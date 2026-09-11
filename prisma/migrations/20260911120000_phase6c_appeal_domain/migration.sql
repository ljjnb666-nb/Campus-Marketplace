-- Phase 6C-1B：Appeal Domain Foundation（申诉域）
--
-- 硬合同（Planning Repair 1–4 冻结，不得为修绿删改）：
-- - 显式事务：classic Prisma Migrate 不自动包裹 PG migration，
--   原子性由本文件的 BEGIN / COMMIT 显式保证；
-- - 两个 Appeal FK 显式 ON DELETE RESTRICT（optional reviewedBy 的
--   Prisma 默认是 SET NULL，必须显式覆盖——terminal reviewer provenance
--   不得因 User 行删除被清空）；
-- - APPEAL_GRANTED 枚举值在 COMMIT 前不得用于任何行写入（PG16 规则），
--   历史 EnforcementAction 零 backfill；
-- - RBAC 回填使用自然键（Permission.key / Role.key）关联并幂等
--   （与 bootstrap / 既有 6A migration 同一语义）。

BEGIN;

-- CreateEnum
CREATE TYPE "AppealStatus" AS ENUM ('SUBMITTED', 'IN_REVIEW', 'GRANTED', 'UPHELD', 'DISMISSED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AppealDecisionReasonCode" AS ENUM ('STALE_ENFORCEMENT', 'ENFORCEMENT_ALREADY_REVERSED', 'LEGACY_PROVENANCE_INSUFFICIENT', 'APPELLANT_ERASED', 'MERIT_APPEAL_JUSTIFIED', 'MERIT_VIOLATION_CONFIRMED');

-- CreateTable
CREATE TABLE "Appeal" (
    "id" TEXT NOT NULL,
    "enforcementActionId" TEXT NOT NULL,
    "status" "AppealStatus" NOT NULL DEFAULT 'SUBMITTED',
    "statement" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "decisionReasonCode" "AppealDecisionReasonCode",
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appeal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Appeal_enforcementActionId_key" ON "Appeal"("enforcementActionId");

-- CreateIndex
CREATE INDEX "Appeal_status_createdAt_idx" ON "Appeal"("status", "createdAt");

-- AddForeignKey（显式 Restrict 合同：治理证据不得级联/静默清空）
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_enforcementActionId_fkey" FOREIGN KEY ("enforcementActionId") REFERENCES "EnforcementAction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey（optional FK 显式覆盖 Prisma 默认的 SET NULL）
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RBAC 回填：第 11 个 permission（与 bootstrap 同一语义，自然键幂等）
INSERT INTO "Permission" ("id", "key", "description", "createdAt") VALUES
    ('pm_' || md5('appeal.review'), 'appeal.review', '审核用户对执法处罚提交的申诉', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
JOIN "Permission" p ON p."key" = 'appeal.review'
WHERE r."key" = 'PLATFORM_ADMIN'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- AlterEnum（新值在 COMMIT 前不得使用；本事务内无任何行写入使用它）
ALTER TYPE "EnforcementReasonCode" ADD VALUE 'APPEAL_GRANTED';

COMMIT;
