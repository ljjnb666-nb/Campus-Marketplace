-- Phase 7G：dispute.review / dispute.evidence.read / support.manage permissions
-- + CAMPUS_DISPUTE_REVIEWER / CAMPUS_SUPPORT_AGENT 系统角色数据收敛
-- （DATA-ONLY，零 DDL）。
--
-- 硬合同（与 7A/7C/7D/7E/7F migration 同款冻结）：
-- - 显式事务：classic Prisma Migrate 不自动包裹 PG migration，
--   原子性由本文件的 BEGIN / COMMIT 显式保证；
-- - 不改任何表/列/枚举/索引/FK（SCHEMA_CHANGE_REQUIRED = NO）；
-- - 绝不触碰 UserRoleAssignment：本轮前后 UserRoleAssignment delta = 0
--   （不新增/不删除/不修改任何用户授权行）；
-- - 自然键解析：Permission 按 key、Role 按 key 定位持久化 ID，
--   确定性 ID 仅用于"新建行"这一步（6A/7D/7F 同一惯例）；
-- - CAMPUS_DISPUTE_REVIEWER permission set 必须恰好收敛到
--   { dispute.review, dispute.evidence.read }（指令冻结，禁止增删）；
--   CAMPUS_SUPPORT_AGENT permission set 必须恰好收敛到 { support.manage }；
--   多余链接删除、缺失链接补齐（幂等）；
-- - PLATFORM_ADMIN 获得全部三个新 capability（与 bootstrap
--   ensureRbacFoundation 的 [...PERMISSION_KEYS] 定义一致收敛）；
-- - 职责定性（R1 冻结不动）：三个新 key 刻意不进入
--   LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS（legacy 11-key 集合零变化，
--   不改变 requireAdmin eligibility 与 privileged-target 分类）；
-- - 定义必须与 src/lib/rbac/permissions.ts / roles.ts 完全一致
--   （bootstrap 收敛测试断言两者不漂移）。

BEGIN;

-- ── 1. permission 行：缺失则新建（确定性 ID 仅此处使用），已存在则原样保留 ──

INSERT INTO "Permission" ("id", "key", "description", "createdAt")
VALUES (
      'pm_' || md5('dispute.review'),
      'dispute.review',
      '受理与处理租赁纠纷（claim/release/resolve/close）',
      CURRENT_TIMESTAMP
      )
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "Permission" ("id", "key", "description", "createdAt")
VALUES (
      'pm_' || md5('dispute.evidence.read'),
      'dispute.evidence.read',
      '读取租赁纠纷绑定的私有证据材料（仅纠纷证据照片）',
      CURRENT_TIMESTAMP
      )
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "Permission" ("id", "key", "description", "createdAt")
VALUES (
      'pm_' || md5('support.manage'),
      'support.manage',
      '处理支持工单（claim/release/resolve/close）',
      CURRENT_TIMESTAMP
      )
ON CONFLICT ("key") DO NOTHING;

-- ── 2. 既有行描述收敛到代码定义（不改动 id）──────────────────────────────────

UPDATE "Permission"
SET "description" = '受理与处理租赁纠纷（claim/release/resolve/close）'
WHERE "key" = 'dispute.review';

UPDATE "Permission"
SET "description" = '读取租赁纠纷绑定的私有证据材料（仅纠纷证据照片）'
WHERE "key" = 'dispute.evidence.read';

UPDATE "Permission"
SET "description" = '处理支持工单（claim/release/resolve/close）'
WHERE "key" = 'support.manage';

-- ── 3. 角色行：缺失则新建（确定性 ID 仅此处使用），已存在则原样保留其 id ──────

INSERT INTO "Role" ("id", "key", "name", "scope", "isSystem", "createdAt", "updatedAt")
VALUES ('role_campus_dispute_reviewer', 'CAMPUS_DISPUTE_REVIEWER', '校区纠纷审核员', 'CAMPUS', true, now(), now())
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "Role" ("id", "key", "name", "scope", "isSystem", "createdAt", "updatedAt")
VALUES ('role_campus_support_agent', 'CAMPUS_SUPPORT_AGENT', '校区支持专员', 'CAMPUS', true, now(), now())
ON CONFLICT ("key") DO NOTHING;

-- ── 4. 既有行收敛到代码定义（name/scope/isSystem；不改动 id）─────────────────

UPDATE "Role"
SET "name" = '校区纠纷审核员',
    "scope" = 'CAMPUS',
    "isSystem" = true,
    "updatedAt" = now()
WHERE "key" = 'CAMPUS_DISPUTE_REVIEWER';

UPDATE "Role"
SET "name" = '校区支持专员',
    "scope" = 'CAMPUS',
    "isSystem" = true,
    "updatedAt" = now()
WHERE "key" = 'CAMPUS_SUPPORT_AGENT';

-- ── 5. permission 集合收敛：先移除合法集合以外的全部链接（含历史误配），
--      再补齐缺失链接（幂等）──────────────────────────────────────────────────

DELETE FROM "RolePermission"
WHERE "roleId" = (
      SELECT "id" FROM "Role" WHERE "key" = 'CAMPUS_DISPUTE_REVIEWER'
      )
  AND "permissionId" NOT IN (
      SELECT "id" FROM "Permission"
      WHERE "key" IN ('dispute.review', 'dispute.evidence.read')
      );

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
JOIN "Permission" p ON p."key" IN ('dispute.review', 'dispute.evidence.read')
WHERE r."key" = 'CAMPUS_DISPUTE_REVIEWER'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

DELETE FROM "RolePermission"
WHERE "roleId" = (
      SELECT "id" FROM "Role" WHERE "key" = 'CAMPUS_SUPPORT_AGENT'
      )
  AND "permissionId" NOT IN (
      SELECT "id" FROM "Permission" WHERE "key" = 'support.manage'
      );

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
JOIN "Permission" p ON p."key" = 'support.manage'
WHERE r."key" = 'CAMPUS_SUPPORT_AGENT'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ── 6. PLATFORM_ADMIN 获得新 capability 恰好一次（绝不授予任何其他系统角色；
--      与 bootstrap 的 PLATFORM_ADMIN = 全量 PERMISSION_KEYS 定义一致收敛）────

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
JOIN "Permission" p ON p."key" IN ('dispute.review', 'dispute.evidence.read', 'support.manage')
WHERE r."key" = 'PLATFORM_ADMIN'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
