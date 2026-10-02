-- Phase 9B — Unified Notifications / Transactional Email。
--
-- 语义（冻结）：
--   Notification.kind / schemaVersion / payload = canonical notification
--                 identity（kind/version registry 的持久化投影）。三列
--                 原子 NULL（历史行，禁止按 title 猜测回填）或原子
--                 NOT NULL（9B 起 canonical service 强制，DB CHECK 禁止
--                 半迁移状态）。
--   NotificationDelivery = channel delivery provenance（9B：EMAIL）。
--                 retry / lease / attempts / backoff authority 属于
--                 Phase 9A AsyncJob（NOTIFICATION_DELIVERY:<deliveryId>），
--                 本表绝不复制第二套状态机（无 attempts/lease/retryAt）。
--                 providerAcceptedAt = provider 接受发送请求，绝不声称
--                 mailbox delivered。
--
-- 隐私：destination 是 CONTACT_INFO（DIRECT_IDENTITY）；注销时 unsent
-- EMAIL delivery 由 erasure 事务置 suppressedAt = RECIPIENT_ERASED 并
-- 清空 destination。delivery 行刻意不建 FK（RB-23 注销删除 Notification
-- 时 delivery 行存活以表达抑制 provenance；应用层 canonical service 是
-- 唯一写入方）。payload / AsyncJob payload 只允许 IDs + 机器状态。

-- AlterTable：canonical notification identity 三列（历史行保持 NULL）
ALTER TABLE "Notification" ADD COLUMN "kind" TEXT;
ALTER TABLE "Notification" ADD COLUMN "schemaVersion" INTEGER;
ALTER TABLE "Notification" ADD COLUMN "payload" JSONB;

-- 原子性 CHECK：禁止半迁移状态（kind/schemaVersion/payload 必须同时
-- 为 NULL 或同时 NOT NULL）。历史 dedupeKey 不强制非空（保持 9A 兼容）。
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_kind_identity_atomic" CHECK (
    (
        "kind" IS NULL
        AND "schemaVersion" IS NULL
        AND "payload" IS NULL
    )
    OR (
        "kind" IS NOT NULL
        AND "schemaVersion" IS NOT NULL
        AND "payload" IS NOT NULL
    )
);

-- CreateTable：channel delivery provenance
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "senderSnapshot" TEXT NOT NULL,
    "replyToSnapshot" TEXT,
    "providerIdempotencyKey" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "firstAttemptAt" TIMESTAMP(3),
    "providerAcceptedAt" TIMESTAMP(3),
    "suppressedAt" TIMESTAMP(3),
    "suppressionCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_notificationId_channel_key" ON "NotificationDelivery"("notificationId", "channel");
CREATE UNIQUE INDEX "NotificationDelivery_providerIdempotencyKey_key" ON "NotificationDelivery"("providerIdempotencyKey");
CREATE INDEX "NotificationDelivery_notificationId_idx" ON "NotificationDelivery"("notificationId");
CREATE INDEX "NotificationDelivery_channel_suppressedAt_idx" ON "NotificationDelivery"("channel", "suppressedAt");
CREATE INDEX "NotificationDelivery_channel_providerAcceptedAt_idx" ON "NotificationDelivery"("channel", "providerAcceptedAt");

-- CHECK：provider 接受 ⇒ 必须有 providerMessageId（符合 provider API
-- 返回合同；suppressed / pending 行 providerAcceptedAt 为 NULL 不受限）。
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_accepted_requires_message_id" CHECK (
    "providerAcceptedAt" IS NULL
    OR "providerMessageId" IS NOT NULL
);
