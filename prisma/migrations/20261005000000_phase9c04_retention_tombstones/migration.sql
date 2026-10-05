-- Phase 9C-04：retention tombstone / PII redaction 基础列（§46）。
--
-- 全部为 nullable 列新增 + 索引新增：
-- - 不做任何 mass UPDATE（历史 terminal 行由 retention worker 后续 bounded
--   渐进 compaction，§47——绝不在 migration 里扫全表造成 deployment lock）；
-- - 不删除/不改写任何既有行（existing DEAD_LETTER 保留，§48）；
-- - forward-safe：旧代码忽略新列，新代码对 NULL 列保持既有语义。
--
-- AsyncJob.tombstonedAt / OutboxEvent.tombstonedAt：dedupe-safe terminal
-- tombstone（§4/§5/§8）——COMPLETED/PUBLISHED 行 retention 时 in-place
-- compaction，状态与 dedupeKey UNIQUE（exactly-once / replay suppression
-- authority）永久保留，绝不 DELETE 行。
--
-- NotificationDelivery.redactedAt：terminal contact snapshot PII retention
-- （§16/§17）——PII 消失，delivery provenance 保留。
--
-- 索引为 retention candidate 扫描服务（§45，terminal anchor + tombstone/
-- redaction 谓词，避免全表扫）。

-- AlterTable
ALTER TABLE "AsyncJob" ADD COLUMN     "tombstonedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "NotificationDelivery" ADD COLUMN     "redactedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OutboxEvent" ADD COLUMN     "tombstonedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "AsyncJob_status_completedAt_tombstonedAt_idx" ON "AsyncJob"("status", "completedAt", "tombstonedAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_providerAcceptedAt_redactedAt_idx" ON "NotificationDelivery"("providerAcceptedAt", "redactedAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_suppressedAt_redactedAt_idx" ON "NotificationDelivery"("suppressedAt", "redactedAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_publishedAt_tombstonedAt_idx" ON "OutboxEvent"("status", "publishedAt", "tombstonedAt");
