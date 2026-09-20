-- Phase 7G: Dispute & Support Operations —— schema migration。
--
-- 硬合同（Phase 7G directive 冻结）：
-- - RentalDispute 运营字段：campus scope 快照（RentalOrder → RentalListing
--   .campusId 回填，绝不从 User.campusId 推断）、openedFromOrderStatus 历史回填
--   （唯一来源 RentalOrderStatusLog.toStatus='IN_DISPUTE' 的 fromStatus，不可靠
--   还原 → NULL，禁止伪造）、dueAt 历史回填 = 行自身 createdAt + 48h
--   （绝不能用迁移执行时刻 now() + INTERVAL）；
-- - 同一 RentalOrder 至多一个 active dispute（OPEN/IN_REVIEW）：
--   PostgreSQL partial unique index（terminal 历史不阻断未来新 episode，
--   绝不是 UNIQUE(orderId)）；
-- - DataHold source provenance（sourceType/sourceId）+ source-linked ACTIVE
--   行的 DB 级重复防护（partial unique index）；
-- - SupportTicket 新域：UNSCOPED/CAMPUS exact pair 由 DB CHECK 强制；
-- - Appeal.reviewDueAt 历史回填 = 行自身 createdAt + 48h（绝不用迁移执行时刻）；
-- - 回填先于 SET NOT NULL / CHECK（upgrade 一趟收敛；fresh 空表 no-op）；
-- - resolvedBy 列名零变化（Prisma 侧 resolvedById @map("resolvedBy")）。
--
-- MIGRATION_ATOMICITY = EXPLICIT_POSTGRES_TRANSACTION（与 6C/7A/7E/7F 同款）。

BEGIN;

-- ============================================================
-- 1. 新枚举类型
-- ============================================================

CREATE TYPE "DisputeResolutionAction" AS ENUM ('RESTORE_PREVIOUS', 'CLOSE_ORDER');

CREATE TYPE "DisputeResolutionCode" AS ENUM ('MUTUAL_AGREEMENT', 'OPERATIONAL_REMEDIATION', 'EVIDENCE_INSUFFICIENT', 'DUPLICATE', 'INVALID', 'OTHER');

CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

CREATE TYPE "SupportTicketCategory" AS ENUM ('ACCOUNT', 'VERIFICATION', 'MARKETPLACE', 'SAFETY', 'OTHER');

CREATE TYPE "SupportResolutionCode" AS ENUM ('ANSWERED', 'USER_GUIDED', 'DUPLICATE', 'INVALID', 'OUT_OF_SCOPE', 'OTHER');

-- ============================================================
-- 2. RentalDispute 运营字段
-- ============================================================

ALTER TABLE "RentalDispute" ADD COLUMN "campusId" TEXT;
ALTER TABLE "RentalDispute" ADD COLUMN "scopeKey" TEXT;
ALTER TABLE "RentalDispute" ADD COLUMN "openedFromOrderStatus" "RentalOrderStatus";
ALTER TABLE "RentalDispute" ADD COLUMN "assignedToId" TEXT;
ALTER TABLE "RentalDispute" ADD COLUMN "dueAt" TIMESTAMP(3);
ALTER TABLE "RentalDispute" ADD COLUMN "resolutionCode" "DisputeResolutionCode";
ALTER TABLE "RentalDispute" ADD COLUMN "resolutionAction" "DisputeResolutionAction";

-- 2a. campus/scope 历史回填：唯一来源 = RentalOrder → RentalListing.campusId
UPDATE "RentalDispute" AS d
SET "campusId" = l."campusId",
    "scopeKey" = 'CAMPUS:' || l."campusId"
FROM "RentalOrder" AS o
JOIN "RentalListing" AS l ON o."rentalListingId" = l."id"
WHERE d."orderId" = o."id";

-- 2b. dueAt 历史回填：origin = 行自身 createdAt（不是迁移执行时刻）
UPDATE "RentalDispute"
SET "dueAt" = "createdAt" + INTERVAL '48 hours'
WHERE "dueAt" IS NULL;

-- 2c. openedFromOrderStatus 历史回填：每个 dispute 取其创建时刻之前、
--     最近一条 toStatus='IN_DISPUTE' 且 fromStatus 非空的 status log；
--     无法可靠还原 → 保持 NULL（禁止伪造，绝不猜 COMPLETED）。
UPDATE "RentalDispute" AS d
SET "openedFromOrderStatus" = (
    SELECT l."fromStatus"
    FROM "RentalOrderStatusLog" AS l
    WHERE l."orderId" = d."orderId"
      AND l."toStatus" = 'IN_DISPUTE'
      AND l."fromStatus" IS NOT NULL
      AND l."createdAt" <= d."createdAt"
    ORDER BY l."createdAt" DESC, l."id" DESC
    LIMIT 1
)
WHERE d."openedFromOrderStatus" IS NULL;

-- 2d. 收紧 NOT NULL（fresh 空表 / upgrade 已回填，均安全）
ALTER TABLE "RentalDispute" ALTER COLUMN "campusId" SET NOT NULL;
ALTER TABLE "RentalDispute" ALTER COLUMN "scopeKey" SET NOT NULL;
ALTER TABLE "RentalDispute" ALTER COLUMN "dueAt" SET NOT NULL;

-- 2e. campus scope 快照 immutable：exact pair 由 DB CHECK 强制
--    （dispute 恒 campus-scoped，无 UNSCOPED 分支）
ALTER TABLE "RentalDispute" ADD CONSTRAINT "RentalDispute_scope_pair_check" CHECK (
    "campusId" IS NOT NULL AND "scopeKey" = 'CAMPUS:' || "campusId"
);

-- 2f. FK：campus scope（Restrict：治理 provenance 不随删除丢失）+
--     运营领用人（SetNull：领用人引用消失时 dispute 仍在）
ALTER TABLE "RentalDispute" ADD CONSTRAINT "RentalDispute_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RentalDispute" ADD CONSTRAINT "RentalDispute_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2g. 治理队列排序索引（与 schema @@index([dueAt, createdAt, id]) 一致）
CREATE INDEX "RentalDispute_dueAt_createdAt_id_idx" ON "RentalDispute"("dueAt", "createdAt", "id");
-- campus reviewer exact-pair 授权谓词
CREATE INDEX "RentalDispute_campusId_scopeKey_idx" ON "RentalDispute"("campusId", "scopeKey");
CREATE INDEX "RentalDispute_assignedToId_idx" ON "RentalDispute"("assignedToId");

-- 2h. ACTIVE DISPUTE UNIQUENESS：同一订单至多一个 active（OPEN/IN_REVIEW）
--     dispute。partial unique（terminal 历史 RESOLVED/CLOSED 不阻断未来新的
--     dispute episode；绝不是 UNIQUE(orderId)）。
CREATE UNIQUE INDEX "RentalDispute_order_active_key" ON "RentalDispute"("orderId")
WHERE "status" IN ('OPEN', 'IN_REVIEW');

-- ============================================================
-- 3. DataHold source provenance
-- ============================================================

ALTER TABLE "DataHold" ADD COLUMN "sourceType" TEXT;
ALTER TABLE "DataHold" ADD COLUMN "sourceId" TEXT;

-- source-linked release / 重复防护查询
CREATE INDEX "DataHold_sourceType_sourceId_status_idx" ON "DataHold"("sourceType", "sourceId", "status");

-- source-linked ACTIVE 行的 DB 级重复防护：同一
-- (type, subjectType, subjectId, sourceType, sourceId) 至多一个 ACTIVE。
-- 历史/手动 hold（sourceType/sourceId 为 NULL）不受影响。
CREATE UNIQUE INDEX "DataHold_source_active_key" ON "DataHold"("type", "subjectType", "subjectId", "sourceType", "sourceId")
WHERE "status" = 'ACTIVE' AND "sourceType" IS NOT NULL AND "sourceId" IS NOT NULL;

-- ============================================================
-- 4. SupportTicket 新域
-- ============================================================

CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "campusId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "category" "SupportTicketCategory" NOT NULL,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "assignedToId" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "resolutionCode" "SupportResolutionCode",
    "resolutionMessage" TEXT,
    "internalNote" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- requester（required → Restrict：注销保留行，绝不级联删除工单历史）
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- 运营领用人（SetNull）
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- campus scope（Restrict）
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- UNSCOPED/CAMPUS exact pair 由 DB CHECK 强制（Prisma 不可表达）
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_scope_pair_check" CHECK (
    ("scopeKey" = 'UNSCOPED' AND "campusId" IS NULL)
    OR ("campusId" IS NOT NULL AND "scopeKey" = 'CAMPUS:' || "campusId")
);

-- 治理队列排序 keyset tuple（dueAt ASC, createdAt ASC, id ASC）
CREATE INDEX "SupportTicket_dueAt_createdAt_id_idx" ON "SupportTicket"("dueAt", "createdAt", "id");
-- campus agent exact-pair 授权谓词
CREATE INDEX "SupportTicket_campusId_scopeKey_idx" ON "SupportTicket"("campusId", "scopeKey");
CREATE INDEX "SupportTicket_assignedToId_idx" ON "SupportTicket"("assignedToId");
-- requester 侧 active 计数（创建上限 3 的锁内复查）
CREATE INDEX "SupportTicket_requesterId_status_idx" ON "SupportTicket"("requesterId", "status");

-- ============================================================
-- 5. Appeal.reviewDueAt（7G 唯一允许触碰的既有 7A domain：SLA 收口）
-- ============================================================

ALTER TABLE "Appeal" ADD COLUMN "reviewDueAt" TIMESTAMP(3);

-- 历史回填：origin = 行自身 createdAt（提交时刻），绝不使用迁移执行时刻
UPDATE "Appeal"
SET "reviewDueAt" = "createdAt" + INTERVAL '48 hours';

ALTER TABLE "Appeal" ALTER COLUMN "reviewDueAt" SET NOT NULL;

-- 队列排序 keyset tuple（reviewDueAt ASC, createdAt ASC, id ASC）
CREATE INDEX "Appeal_reviewDueAt_createdAt_id_idx" ON "Appeal"("reviewDueAt", "createdAt", "id");

COMMIT;
