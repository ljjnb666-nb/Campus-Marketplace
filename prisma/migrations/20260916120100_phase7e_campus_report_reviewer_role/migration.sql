-- Phase 7E：CAMPUS_REPORT_REVIEWER 系统角色数据收敛（DATA-ONLY，零 DDL）。
--
-- 硬合同（与 7A/7C role migration 同款冻结）：
-- - 显式事务：classic Prisma Migrate 不自动包裹 PG migration，
--   原子性由本文件的 BEGIN / COMMIT 显式保证；
-- - 不改任何表/列/枚举/索引/FK（SCHEMA_CHANGE_REQUIRED = NO）；
-- - 绝不触碰 UserRoleAssignment：不新增/不删除/不修改任何用户授权行；
-- - 自然键解析：Role 按 Role.key、Permission 按 Permission.key 定位持久化 ID，
--   硬编码确定性 ID 仅用于"新建 Role 行"这一步（与 6A/7A/7C migration 同一惯例）；
-- - 幂等：对"角色已存在（含 bootstrap 建出的不同 id 行）"的库安全收敛，
--   permission 集合收敛到且仅到 report.review（report.review 行由 6A migration
--   建立并存在于所有已部署环境，属 pre-7D legacy 11-key——不新增 R1 语义）；
-- - 定义必须与 src/lib/rbac/roles.ts 的 SYSTEM_ROLES 完全一致
--   （bootstrap 收敛测试断言两者不漂移）。

BEGIN;

-- 1. 角色行：缺失则新建（确定性 ID 仅此处使用），已存在则原样保留其 id
INSERT INTO "Role" ("id", "key", "name", "scope", "isSystem", "createdAt", "updatedAt")
VALUES ('role_campus_report_reviewer', 'CAMPUS_REPORT_REVIEWER', '校区举报审核员', 'CAMPUS', true, now(), now())
ON CONFLICT ("key") DO NOTHING;

-- 2. 既有行收敛到代码定义（name/scope/isSystem；不改动 id）
UPDATE "Role"
SET "name" = '校区举报审核员',
    "scope" = 'CAMPUS',
    "isSystem" = true,
    "updatedAt" = now()
WHERE "key" = 'CAMPUS_REPORT_REVIEWER';

-- 3. permission 集合收敛：先移除该角色身上 report.review 以外的全部链接
--    （含历史误配），再补齐缺失的 report.review 链接。
--    两次操作均以自然键定位 roleId/permissionId，绝不假设 Role.id 形状。
DELETE FROM "RolePermission"
WHERE "roleId" = (
      SELECT "id" FROM "Role" WHERE "key" = 'CAMPUS_REPORT_REVIEWER'
      )
  AND "permissionId" <> (
      SELECT "id" FROM "Permission" WHERE "key" = 'report.review'
      );

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
JOIN "Permission" p ON p."key" = 'report.review'
WHERE r."key" = 'CAMPUS_REPORT_REVIEWER'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
