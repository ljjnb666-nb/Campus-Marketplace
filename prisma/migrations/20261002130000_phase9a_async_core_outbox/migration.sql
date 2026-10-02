-- Phase 9A — Async Core / Transactional Outbox / Reservation Scheduler。
--
-- 语义（冻结）：
--   AsyncJob    = durable job intent（业务领域动作，如 reservation expiry
--                 scheduler 的 wake-up 意图）；status ∈ {PENDING, RUNNING,
--                 RETRY, COMPLETED, DEAD_LETTER}，绝不引入语义模糊的 FAILED。
--   OutboxEvent = transactional outbox（已发生 domain fact 的幂等派生面：
--                 In-App 通知 / Phase 9B 未来渠道）；status ∈ {PENDING,
--                 PROCESSING, PUBLISHED, DEAD_LETTER}。
--   Notification.dedupeKey / sourceEventId = outbox-driven In-App 通知的
--                 exactly-once 身份；nullable——历史同步通知 NULL，多行 NULL
--                 共存由 PostgreSQL unique index 语义天然允许，行为兼容。
--
-- 永久原则：domain state 与 async intent 必须同事务原子落盘；durable
-- queue authority = PostgreSQL（SKIP LOCKED + lease token fencing）。
-- payload 只允许 IDs + 机器状态（privacy registry 同步登记）；禁止
-- user-authored 自由文本 / secret / raw provider payload。

-- CreateEnum
CREATE TYPE "AsyncJobStatus" AS ENUM ('PENDING', 'RUNNING', 'RETRY', 'COMPLETED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "OutboxEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'DEAD_LETTER');

-- CreateTable
CREATE TABLE "AsyncJob" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "AsyncJobStatus" NOT NULL DEFAULT 'PENDING',
    "runAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "leaseOwner" TEXT,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "completedAt" TIMESTAMP(3),
    "deadLetteredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AsyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
    "availableAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "leaseOwner" TEXT,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "publishedAt" TIMESTAMP(3),
    "deadLetteredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AsyncJob_dedupeKey_key" ON "AsyncJob"("dedupeKey");
CREATE INDEX "AsyncJob_status_runAt_createdAt_idx" ON "AsyncJob"("status", "runAt", "createdAt");
CREATE INDEX "AsyncJob_status_leaseExpiresAt_idx" ON "AsyncJob"("status", "leaseExpiresAt");
CREATE INDEX "AsyncJob_kind_status_runAt_idx" ON "AsyncJob"("kind", "status", "runAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_dedupeKey_key" ON "OutboxEvent"("dedupeKey");
CREATE INDEX "OutboxEvent_status_availableAt_createdAt_idx" ON "OutboxEvent"("status", "availableAt", "createdAt");
CREATE INDEX "OutboxEvent_status_leaseExpiresAt_idx" ON "OutboxEvent"("status", "leaseExpiresAt");
CREATE INDEX "OutboxEvent_eventType_status_availableAt_idx" ON "OutboxEvent"("eventType", "status", "availableAt");

-- AlterTable：Notification outbox 幂等身份（nullable，旧同步通知行为零变化）
ALTER TABLE "Notification" ADD COLUMN     "dedupeKey" TEXT;
ALTER TABLE "Notification" ADD COLUMN     "sourceEventId" TEXT;

-- CreateIndex（PostgreSQL unique index 允许多行 NULL——历史通知不受影响）
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- ============================================================
-- Reservation job backfill（§10）
-- ============================================================

-- Backfill safety guard（§42）：PRODUCT PENDING 但 deadline IS NULL 属
-- Phase 8B DB contract（Order_product_pending_deadline_check）理论禁止的
-- 异常行。存在即 RAISE EXCEPTION——绝不猜测 deadline，迁移中止。
DO $$
DECLARE
  violation_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO violation_count
  FROM "Order"
  WHERE "type" = 'PRODUCT'::"OrderType"
    AND "status" = 'PENDING'::"OrderStatus"
    AND "productReservationExpiresAt" IS NULL;
  IF violation_count > 0 THEN
    RAISE EXCEPTION 'Phase 9A backfill guard: % 条 PRODUCT PENDING 订单缺少 productReservationExpiresAt（违反 Phase 8B DB contract）——禁止猜测 deadline，迁移中止', violation_count;
  END IF;
END
$$;

-- Backfill：存量 PRODUCT PENDING reservation → 恰好一条
-- PRODUCT_RESERVATION_EXPIRE durable intent（dedupeKey 幂等）。
--   runAt = productReservationExpiresAt：deadline 已在过去也保留历史值，
--   worker 上线后立即发现并经 canonical lifecycle materialize。
--   禁止 migration 直接 expire Order / 补发历史 EXPIRED 通知（§43）：
--   migration 只建立 async intent，业务 lifecycle 必须继续走
--   expireProductReservationTx()。
INSERT INTO "AsyncJob" (
  "id", "kind", "schemaVersion", "dedupeKey", "payload",
  "status", "runAt", "attempts", "maxAttempts", "createdAt", "updatedAt"
)
SELECT
  'job_' || replace(gen_random_uuid()::text, '-', ''),
  'PRODUCT_RESERVATION_EXPIRE',
  1,
  'PRODUCT_RESERVATION_EXPIRE:' || "id",
  jsonb_build_object('orderId', "id"),
  'PENDING'::"AsyncJobStatus",
  "productReservationExpiresAt",
  0,
  8,
  now(),
  now()
FROM "Order"
WHERE "type" = 'PRODUCT'::"OrderType"
  AND "status" = 'PENDING'::"OrderStatus"
  AND "productReservationExpiresAt" IS NOT NULL
ON CONFLICT ("dedupeKey") DO NOTHING;
