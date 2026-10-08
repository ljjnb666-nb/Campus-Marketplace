-- Phase 10J: analytics.read isolated, read-only permission.
-- Data-only, transactional, idempotent; no UserRoleAssignment mutation,
-- no new system role, no legacy-admin-equivalence expansion.
BEGIN;

INSERT INTO "Permission" ("id", "key", "description", "createdAt")
VALUES (
  'pm_' || md5('analytics.read'),
  'analytics.read',
  '读取按校区隔离的运营分析与流动性指标（只读）',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;

UPDATE "Permission"
SET "description" = '读取按校区隔离的运营分析与流动性指标（只读）'
WHERE "key" = 'analytics.read';

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r JOIN "Permission" p ON p."key" = 'analytics.read'
WHERE r."key" = 'PLATFORM_ADMIN'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
