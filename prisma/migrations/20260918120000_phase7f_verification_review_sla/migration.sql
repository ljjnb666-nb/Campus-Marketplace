-- Phase 7F: UserVerification.reviewDueAt（审核 SLA）——schema migration。
--
-- 硬合同（Phase 7F directive 冻结）：
-- - reviewDueAt 的历史回填 origin 必须是行自身的 submittedAt + 48h，
--   绝不能用迁移执行时刻（now() + 48h 是被显式禁止的错误语义）；
-- - 回填先于 SET NOT NULL（upgrade 在一趟迁移内收敛，fresh 空表 no-op）；
-- - 运行时唯一写路径 = 提交/重新提交（submittedAt + 48h，见
--   verification-service / verification-sla 常量 48 冻结）；
-- - 决定后保留为历史值；OVERDUE 只读判定 = PENDING ∧ reviewDueAt < now，
--   SLA 不驱动任何自动决定 / enforcement；
-- - 队列排序 (reviewDueAt ASC, submittedAt ASC, id ASC) 的复合索引与
--   prisma/schema.prisma @@index 逐字一致（无 drift）。
--
-- MIGRATION_ATOMICITY = EXPLICIT_POSTGRES_TRANSACTION（与 6C/7A/7E 同款）。

BEGIN;

-- 1. 加列（先可空，供 upgrade 回填）
ALTER TABLE "UserVerification" ADD COLUMN "reviewDueAt" TIMESTAMP(3);

-- 2. 历史回填：origin = 行自身 submittedAt（不是迁移执行时刻）
UPDATE "UserVerification"
SET "reviewDueAt" = "submittedAt" + INTERVAL '48 hours';

-- 3. 收紧为 NOT NULL（fresh 空表 / upgrade 已回填，均安全）
ALTER TABLE "UserVerification" ALTER COLUMN "reviewDueAt" SET NOT NULL;

-- 4. 治理队列排序索引（与 schema @@index([reviewDueAt, submittedAt, id]) 一致）
CREATE INDEX "UserVerification_reviewDueAt_submittedAt_id_idx" ON "UserVerification"("reviewDueAt", "submittedAt", "id");

COMMIT;
