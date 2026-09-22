-- Phase 7H：operations.overview 窄读取 permission（DATA-ONLY，零 DDL）。
--
-- 硬合同（Planning §11/§37/§57 冻结）：
-- - 仅新增 1 条 permission 行（permission count delta = 1），绝不创建
--   UserRoleAssignment，绝不创建新 role；
-- - PLATFORM_ADMIN 经 RolePermission 收敛自然获得 operations.overview
--   （SYSTEM_ROLES.permissionKeys = [...PERMISSION_KEYS] 的 DB 侧镜像），
--   绝不授予任何其他角色；
-- - LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS 恰 11 key 零变化，且
--   operations.overview 不在 legacy 集合内（R1 冻结；requireAdmin 资格、
--   privileged-target 分类零变化）；
-- - 幂等：ON CONFLICT DO NOTHING + description UPDATE 收敛，重放零漂移；
-- - 自然键（Permission.key / Role.key）解析持久化 id；'pm_' || md5(key)
--   确定性 id 仅在新建行时使用。
-- 显式 BEGIN/COMMIT：classic Prisma Migrate 不自动包裹 PG migration。

BEGIN;

-- 1. permission 行：缺失则新建（确定性 ID 仅此处使用），已存在则原样保留
INSERT INTO "Permission" ("id", "key", "description", "createdAt")
VALUES (
      'pm_' || md5('operations.overview'),
      'operations.overview',
      '读取平台运行状态与安全的运营级系统概览',
      CURRENT_TIMESTAMP
      )
ON CONFLICT ("key") DO NOTHING;

-- 2. 既有行描述收敛到代码定义（不改动 id）
UPDATE "Permission"
SET "description" = '读取平台运行状态与安全的运营级系统概览'
WHERE "key" = 'operations.overview';

-- 3. 授权收敛：PLATFORM_ADMIN 获得 operations.overview 恰好一次；
--    绝不授予任何其他角色（7H 冻结：无新角色、无 UserRoleAssignment）。
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
JOIN "Permission" p ON p."key" = 'operations.overview'
WHERE r."key" = 'PLATFORM_ADMIN'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
