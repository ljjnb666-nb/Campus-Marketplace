-- Production Phase 6A：身份 / 校园成员 / 认证策略 / RBAC foundation
--
-- 本迁移除 DDL 外包含三类确定性、幂等的数据回填：
--   1. CampusMembership：为全部既有用户按 User.campusId 回填 ACTIVE membership
--      （含已停用/已注销用户——他们的操作在账号状态门（status/deletedAt/erasedAt）
--      已被默认拒绝，membership 行保持"关系真实性"，恢复流程无需补行）；
--   2. UserVerification.membershipId：认证记录挂接到其所属 membership；
--   3. RBAC bootstrap：Permission / PLATFORM_ADMIN 角色 / 全量授权 /
--      既有 role='ADMIN' 用户的 UserRoleAssignment（legacy admin 迁移，
--      此后 User.role 不再作为授权依据，仅保留展示与 bootstrap 同步用途）。
--
-- 确定性 ID 约定：'pm_'||md5(key) / 'role_platform_admin' / 'rp_'||md5(roleId||':'||permissionId)
-- / 'ura_'||md5(userId||':PLATFORM_ADMIN:GLOBAL') / 'cme_'||md5(userId||':'||campusId)，
-- 保证任意环境重复执行结果一致（ON CONFLICT 幂等）。

-- CreateEnum
CREATE TYPE "CampusMembershipStatus" AS ENUM ('PENDING', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'LEFT');

-- CreateEnum
CREATE TYPE "RoleScope" AS ENUM ('GLOBAL', 'CAMPUS');

-- CreateEnum
CREATE TYPE "CampusVerificationPolicyStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- AlterEnum（本事务内不使用 REVOKED 值，仅扩充枚举）
ALTER TYPE "VerificationStatus" ADD VALUE 'REVOKED';

-- AlterTable
ALTER TABLE "AdminLog" ADD COLUMN     "campusId" TEXT,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "result" TEXT NOT NULL DEFAULT 'SUCCESS';

-- AlterTable（membershipId 先以可空列加入，回填后再收紧 NOT NULL）
ALTER TABLE "UserVerification" ADD COLUMN     "membershipId" TEXT,
ADD COLUMN     "policyHash" TEXT,
ADD COLUMN     "policyId" TEXT,
ADD COLUMN     "policyVersion" INTEGER,
ADD COLUMN     "reasonCode" TEXT,
ADD COLUMN     "reviewedById" TEXT;

-- CreateTable
CREATE TABLE "CampusMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "status" "CampusMembershipStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampusMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampusVerificationPolicy" (
    "id" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "CampusVerificationPolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampusVerificationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "RoleScope" NOT NULL DEFAULT 'GLOBAL',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "UserRoleAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "campusId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "assignedById" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampusMembership_userId_status_idx" ON "CampusMembership"("userId", "status");

-- CreateIndex
CREATE INDEX "CampusMembership_campusId_status_idx" ON "CampusMembership"("campusId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CampusMembership_userId_campusId_key" ON "CampusMembership"("userId", "campusId");

-- CreateIndex
CREATE INDEX "CampusVerificationPolicy_campusId_status_effectiveAt_idx" ON "CampusVerificationPolicy"("campusId", "status", "effectiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampusVerificationPolicy_campusId_version_key" ON "CampusVerificationPolicy"("campusId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Role_key_key" ON "Role"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_key_key" ON "Permission"("key");

-- CreateIndex
CREATE INDEX "RolePermission_permissionId_idx" ON "RolePermission"("permissionId");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_roleId_permissionId_key" ON "RolePermission"("roleId", "permissionId");

-- CreateIndex
CREATE INDEX "UserRoleAssignment_userId_idx" ON "UserRoleAssignment"("userId");

-- CreateIndex
CREATE INDEX "UserRoleAssignment_roleId_idx" ON "UserRoleAssignment"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "UserRoleAssignment_userId_roleId_scopeKey_key" ON "UserRoleAssignment"("userId", "roleId", "scopeKey");

-- CreateIndex
CREATE INDEX "AdminLog_targetType_targetId_createdAt_idx" ON "AdminLog"("targetType", "targetId", "createdAt");

-- ============================================================
-- 数据回填 1：CampusMembership（全部既有用户，ACTIVE）
-- ============================================================

INSERT INTO "CampusMembership" ("id", "userId", "campusId", "status", "createdAt", "updatedAt")
SELECT 'cme_' || md5(u."id" || ':' || u."campusId"),
       u."id",
       u."campusId",
       'ACTIVE',
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
FROM "User" u
WHERE NOT EXISTS (
    SELECT 1 FROM "CampusMembership" m
    WHERE m."userId" = u."id" AND m."campusId" = u."campusId"
);

-- ============================================================
-- 数据回填 2：UserVerification.membershipId → 收紧 NOT NULL + 唯一
-- ============================================================

UPDATE "UserVerification" v
SET "membershipId" = m."id"
FROM "CampusMembership" m
WHERE m."userId" = v."userId";

-- CreateIndex
CREATE UNIQUE INDEX "UserVerification_membershipId_key" ON "UserVerification"("membershipId");

ALTER TABLE "UserVerification" ALTER COLUMN "membershipId" SET NOT NULL;

-- ============================================================
-- 数据回填 3：RBAC bootstrap（Permission / PLATFORM_ADMIN / legacy admin）
-- ============================================================

INSERT INTO "Permission" ("id", "key", "description", "createdAt") VALUES
    ('pm_' || md5('verification.review'), 'verification.review', '审核校园成员认证材料并作出决定', CURRENT_TIMESTAMP),
    ('pm_' || md5('report.review'), 'report.review', '受理与处理举报', CURRENT_TIMESTAMP),
    ('pm_' || md5('listing.moderate'), 'listing.moderate', '对商品/跑腿/服务/租赁列表执行治理处置', CURRENT_TIMESTAMP),
    ('pm_' || md5('category.manage'), 'category.manage', '管理商品/跑腿/服务分类', CURRENT_TIMESTAMP),
    ('pm_' || md5('moderation.keyword.manage'), 'moderation.keyword.manage', '管理敏感词规则', CURRENT_TIMESTAMP),
    ('pm_' || md5('user.suspend'), 'user.suspend', '停用/恢复用户账号', CURRENT_TIMESTAMP),
    ('pm_' || md5('asset.sensitive.read'), 'asset.sensitive.read', '因治理/审核目的访问敏感私有材料（认证材料等）', CURRENT_TIMESTAMP),
    ('pm_' || md5('campus.manage'), 'campus.manage', '管理校区与校园认证策略版本', CURRENT_TIMESTAMP),
    ('pm_' || md5('rbac.role.assign'), 'rbac.role.assign', '授予/撤回用户角色', CURRENT_TIMESTAMP),
    ('pm_' || md5('audit.read'), 'audit.read', '读取管理审计日志', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "Role" ("id", "key", "name", "scope", "isSystem", "createdAt", "updatedAt")
VALUES ('role_platform_admin', 'PLATFORM_ADMIN', '平台管理员', 'GLOBAL', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- PLATFORM_ADMIN 授予当前全部 permission（与 bootstrap service 同一语义）
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT 'role_platform_admin', p."id"
FROM "Permission" p
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- legacy admin 迁移：role='ADMIN' 的既有用户获得 PLATFORM_ADMIN（幂等）
INSERT INTO "UserRoleAssignment" ("id", "userId", "roleId", "campusId", "scopeKey", "assignedAt")
SELECT 'ura_' || md5(u."id" || ':PLATFORM_ADMIN:GLOBAL'),
       u."id",
       'role_platform_admin',
       NULL,
       'GLOBAL',
       CURRENT_TIMESTAMP
FROM "User" u
WHERE u."role" = 'ADMIN'
ON CONFLICT ("userId", "roleId", "scopeKey") DO NOTHING;

-- ============================================================
-- 外键
-- ============================================================

-- AddForeignKey
ALTER TABLE "UserVerification" ADD CONSTRAINT "UserVerification_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "CampusMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserVerification" ADD CONSTRAINT "UserVerification_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserVerification" ADD CONSTRAINT "UserVerification_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "CampusVerificationPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminLog" ADD CONSTRAINT "AdminLog_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampusMembership" ADD CONSTRAINT "CampusMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampusMembership" ADD CONSTRAINT "CampusMembership_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampusVerificationPolicy" ADD CONSTRAINT "CampusVerificationPolicy_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE SET NULL ON UPDATE CASCADE;
