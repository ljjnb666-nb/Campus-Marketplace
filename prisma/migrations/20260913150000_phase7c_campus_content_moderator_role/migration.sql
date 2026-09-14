-- Phase 7C：CAMPUS_CONTENT_MODERATOR 系统角色数据收敛（DATA-ONLY，零 DDL）。
--
-- 硬合同（Phase 7C Planning Repair 2 / §8-§11 冻结）：
-- - 显式事务：classic Prisma Migrate 不自动包裹 PG migration，
--   原子性由本文件的 BEGIN / COMMIT 显式保证（与 7A data-only migration 同款）；
-- - 不改任何表/列/枚举/索引/FK；
-- - 绝不触碰 UserRoleAssignment：不新增/不删除/不修改任何用户授权行，
--   零自动授予（角色经 /governance/roles server-owned action 显式授予）；
-- - 无 GLOBAL content-moderator 角色；无额外权限（仅 listing.moderate）；
-- - 自然键解析：Role 按 Role.key、Permission 按 Permission.key 定位持久化
--   ID，硬编码确定性 ID 仅用于"新建 Role 行"这一步（与 6A/7A 同一惯例）；
-- - 幂等收敛：对"角色已存在（含 bootstrap 建出的不同 id 行）"的库安全收敛，
--   permission 集合收敛到且仅到 listing.moderate（listing.moderate 行由
--   6A migration 建立并存在于所有已部署环境）；
-- - 定义必须与 src/lib/rbac/roles.ts 的 SYSTEM_ROLES 完全一致
--   （bootstrap 收敛测试断言两者不漂移）；
-- - PLATFORM_ADMIN 与 CAMPUS_APPEAL_REVIEWER 语义零改动。

BEGIN;

-- 1. 角色行：缺失则新建（确定性 ID 仅此处使用），已存在则原样保留其 id
INSERT INTO "Role" ("id", "key", "name", "scope", "isSystem", "createdAt", "updatedAt")
VALUES ('role_campus_content_moderator', 'CAMPUS_CONTENT_MODERATOR', '校区内容审核员', 'CAMPUS', true, now(), now())
ON CONFLICT ("key") DO NOTHING;

-- 2. 既有行收敛到代码定义（name/scope/isSystem；不改动 id）
UPDATE "Role"
SET "name" = '校区内容审核员',
    "scope" = 'CAMPUS',
    "isSystem" = true,
    "updatedAt" = now()
WHERE "key" = 'CAMPUS_CONTENT_MODERATOR';

-- 3. permission 集合收敛：先移除该角色身上 listing.moderate 以外的全部链接
--    （含历史误配），再补齐缺失的 listing.moderate 链接。
--    两次操作均以自然键定位 roleId/permissionId，绝不假设 Role.id 形状。
DELETE FROM "RolePermission"
WHERE "roleId" = (
      SELECT "id" FROM "Role" WHERE "key" = 'CAMPUS_CONTENT_MODERATOR'
      )
  AND "permissionId" <> (
      SELECT "id" FROM "Permission" WHERE "key" = 'listing.moderate'
      );

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
JOIN "Permission" p ON p."key" = 'listing.moderate'
WHERE r."key" = 'CAMPUS_CONTENT_MODERATOR'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
