-- Phase 7D：enforcement.read permission 数据收敛（DATA-ONLY，零 DDL）。
--
-- 硬合同（Phase 7D Planning Repair 1 冻结）：
-- - 显式事务：classic Prisma Migrate 不自动包裹 PG migration，
--   原子性由本文件的 BEGIN / COMMIT 显式保证（与 6A/7A/7C migration 同款）；
-- - 不改任何表/列/枚举/索引/FK（本迁移是纯数据授权收敛）；
-- - 绝不触碰 UserRoleAssignment：不新增/不删除/不修改任何用户授权行；
-- - 自然键解析：Permission 按 key、Role 按 key 定位持久化 ID，
--   确定性 ID 仅用于"新建 Permission 行"这一步（pm_ || md5(key)，
--   与 6A migration 同一惯例）；
-- - 幂等：fresh / upgrade / rerun 收敛结果一致；
-- - 职责定性（R1）：本迁移是"PLATFORM_ADMIN 获得新的执法可见性 capability"，
--   不是"修补 legacy requireAdmin 桥"——legacy 等价集合
--   LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS 已在代码层显式冻结且不含本 key；
-- - 定义必须与 src/lib/rbac/permissions.ts 的 PERMISSIONS 完全一致
--   （bootstrap ensureRbacFoundation 收敛测试断言两者不漂移）。

BEGIN;

-- 1. permission 行：缺失则新建（确定性 ID 仅此处使用），已存在则原样保留
INSERT INTO "Permission" ("id", "key", "description", "createdAt")
VALUES (
      'pm_' || md5('enforcement.read'),
      'enforcement.read',
      '读取执法记录与账户限制状态（治理运营可见性）',
      CURRENT_TIMESTAMP
      )
ON CONFLICT ("key") DO NOTHING;

-- 2. 既有行描述收敛到代码定义（不改动 id）
UPDATE "Permission"
SET "description" = '读取执法记录与账户限制状态（治理运营可见性）'
WHERE "key" = 'enforcement.read';

-- 3. 授权收敛：PLATFORM_ADMIN 获得 enforcement.read 恰好一次；
--    绝不授予任何其他角色（7D 冻结：无新 campus 角色）。
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
JOIN "Permission" p ON p."key" = 'enforcement.read'
WHERE r."key" = 'PLATFORM_ADMIN'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
