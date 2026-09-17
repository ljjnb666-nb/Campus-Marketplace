-- Phase 7E: Report & Moderation Case Operations — scope snapshot + 1:1 case.
--
-- Hard contract (Phase 7E directive, frozen):
-- - Report stays the canonical decision truth; ModerationCase carries ONLY
--   operational metadata (assignment / SLA dueAt / activity clocks). There is
--   deliberately NO case status enum: operational state derives from closedAt
--   (NULL = ACTIVE, non-NULL = CLOSED); terminal result is Report.status only.
-- - Report gains immutable scope provenance (campusId nullable + scopeKey):
--   PRODUCT / ERRAND_TASK / SERVICE_LISTING / RENTAL_LISTING backfill from the
--   target object's real campusId (scopeKey = 'CAMPUS:' || campusId);
--   USER / MESSAGE backfill to campusId IS NULL + scopeKey = 'UNSCOPED'.
--   Never guessed from User.campusId / sender campus (frozen fail-closed rule).
--   Backfill runs BEFORE SET NOT NULL / CHECK so upgrade converges in one pass.
-- - DB CHECK enforces the scope pair on both tables (Prisma cannot express it):
--   ('UNSCOPED' ∧ campusId IS NULL) ∨ (campusId IS NOT NULL ∧ scopeKey = 'CAMPUS:' || campusId).
--   Malformed cross pairs are structurally impossible, mirroring the
--   exact-pair authorization predicate (never campusId IN (...) alone).
-- - Every historical Report gets exactly one ModerationCase (UNIQUE(reportId)
--   + ON CONFLICT DO NOTHING → rerun-safe). Historical SLA origin is the
--   REPORT's createdAt (+48h), never the migration execution time.
--   closedAt mapping: OPEN/IN_REVIEW → NULL; RESOLVED/REJECTED →
--   COALESCE(handledAt, updatedAt, createdAt). assignedToId stays NULL
--   (claim did not exist historically; no fabrication).
-- - FK discipline (7C governance convention): Report/ModerationCase → Campus
--   and case → Report are ON DELETE RESTRICT (governance provenance must not
--   vanish silently); assignee is operational, ON DELETE SET NULL.
-- - DDL is idempotent-safe under migrate deploy (fails loudly on partial
--   application via the explicit transaction below).
--
-- MIGRATION_ATOMICITY = EXPLICIT_POSTGRES_TRANSACTION.

BEGIN;

-- CreateTable
CREATE TABLE "ModerationCase" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "campusId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "assignedToId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "lastActivityAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModerationCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModerationCase_reportId_key" ON "ModerationCase"("reportId");

-- CreateIndex
CREATE INDEX "ModerationCase_dueAt_createdAt_id_idx" ON "ModerationCase"("dueAt", "createdAt", "id");

-- CreateIndex
CREATE INDEX "ModerationCase_campusId_scopeKey_idx" ON "ModerationCase"("campusId", "scopeKey");

-- CreateIndex
CREATE INDEX "ModerationCase_assignedToId_idx" ON "ModerationCase"("assignedToId");

-- AddForeignKey（7C governance convention：provenance Restrict，assignee SetNull）
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable：Report immutable scope provenance（先加列，回填后再收敛约束）
ALTER TABLE "Report" ADD COLUMN "campusId" TEXT;
ALTER TABLE "Report" ADD COLUMN "scopeKey" TEXT;

-- Backfill（1/4）：四类 listing 目标 → 目标对象真实 campus 快照，绝不猜测。
-- 四张目标表 campusId 均为 NOT NULL，'CAMPUS:' || campusId 恒有定义。
UPDATE "Report" AS r
SET "campusId" = p."campusId",
    "scopeKey" = 'CAMPUS:' || p."campusId"
FROM "Product" AS p
WHERE r."productId" = p."id" AND r."targetType" = 'PRODUCT';

UPDATE "Report" AS r
SET "campusId" = e."campusId",
    "scopeKey" = 'CAMPUS:' || e."campusId"
FROM "ErrandTask" AS e
WHERE r."errandTaskId" = e."id" AND r."targetType" = 'ERRAND_TASK';

UPDATE "Report" AS r
SET "campusId" = s."campusId",
    "scopeKey" = 'CAMPUS:' || s."campusId"
FROM "ServiceListing" AS s
WHERE r."serviceListingId" = s."id" AND r."targetType" = 'SERVICE_LISTING';

UPDATE "Report" AS r
SET "campusId" = rl."campusId",
    "scopeKey" = 'CAMPUS:' || rl."campusId"
FROM "RentalListing" AS rl
WHERE r."rentalListingId" = rl."id" AND r."targetType" = 'RENTAL_LISTING';

-- Backfill（2/4）：USER / MESSAGE（以及任何无法解析 campus 的残行——FK 下
-- 理论为空集）→ UNSCOPED，campusId 置 NULL。fail-closed，不猜测。
UPDATE "Report"
SET "campusId" = NULL,
    "scopeKey" = 'UNSCOPED'
WHERE "scopeKey" IS NULL;

-- 收敛：scopeKey NOT NULL + scope pair CHECK（数据已全量回填，一次通过）
ALTER TABLE "Report" ALTER COLUMN "scopeKey" SET NOT NULL;

ALTER TABLE "Report" ADD CONSTRAINT "Report_scope_pair_check" CHECK (
    ("scopeKey" = 'UNSCOPED' AND "campusId" IS NULL)
    OR ("campusId" IS NOT NULL AND "scopeKey" = 'CAMPUS:' || "campusId")
);

ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_scope_pair_check" CHECK (
    ("scopeKey" = 'UNSCOPED' AND "campusId" IS NULL)
    OR ("campusId" IS NOT NULL AND "scopeKey" = 'CAMPUS:' || "campusId")
);

-- CreateIndex（Report exact-pair 授权谓词支撑）
CREATE INDEX "Report_campusId_scopeKey_idx" ON "Report"("campusId", "scopeKey");

-- AddForeignKey（Report scope 快照 → Campus，Restrict：provenance 不随删除消失）
ALTER TABLE "Report" ADD CONSTRAINT "Report_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill（3/4）：每个历史 Report 恰好一个 ModerationCase。
-- - openedAt = report.createdAt（历史 SLA 起点，绝不用 migration 执行时刻）；
-- - dueAt = report.createdAt + 48 hours（MODERATION_CASE_SLA_HOURS=48，代码常量冻结）；
-- - lastActivityAt = COALESCE(handledAt, updatedAt, createdAt)（真实最近活动重建）；
-- - closedAt：OPEN/IN_REVIEW → NULL（ACTIVE）；RESOLVED/REJECTED →
--   COALESCE(handledAt, updatedAt, createdAt)（M10 映射合同）；
-- - assignedToId 恒 NULL（claim 机制历史上不存在，不伪造领用人）；
-- - id = 'case_' || report.id 确定性派生 + ON CONFLICT(reportId) DO NOTHING
--   → rerun 安全（M03），不重复建 case（M04/M12）。
INSERT INTO "ModerationCase" (
    "id", "reportId", "campusId", "scopeKey", "assignedToId",
    "openedAt", "dueAt", "lastActivityAt", "closedAt", "createdAt", "updatedAt"
)
SELECT
    'case_' || r."id",
    r."id",
    r."campusId",
    r."scopeKey",
    NULL,
    r."createdAt",
    r."createdAt" + INTERVAL '48 hours',
    COALESCE(r."handledAt", r."updatedAt", r."createdAt"),
    CASE
        WHEN r."status" IN ('RESOLVED', 'REJECTED')
            THEN COALESCE(r."handledAt", r."updatedAt", r."createdAt")
        ELSE NULL
    END,
    now(),
    now()
FROM "Report" AS r
ON CONFLICT ("reportId") DO NOTHING;

COMMIT;
