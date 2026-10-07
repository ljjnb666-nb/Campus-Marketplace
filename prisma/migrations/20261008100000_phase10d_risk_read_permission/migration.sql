-- Phase 10D — risk.read permission bootstrap (DATA-ONLY).
--
-- risk.read is intentionally separate from enforcement.read. The latter's
-- Phase 7D frozen contract only authorizes EnforcementAction + RiskState and
-- must not silently expand to RiskFlag / risk intelligence.
--
-- This migration:
-- - is explicitly atomic (classic Prisma Migrate does not wrap PG SQL);
-- - does not touch UserRoleAssignment;
-- - grants the new capability only to existing PLATFORM_ADMIN;
-- - is idempotent under raw replay;
-- - keeps legacy full-admin compatibility code frozen (code-level explicit set).

BEGIN;

INSERT INTO "Permission" ("id", "key", "description", "createdAt")
VALUES (
  'pm_' || md5('risk.read'),
  'risk.read',
  '读取风险信号与规则化风险建议（治理运营可见性）',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;

UPDATE "Permission"
SET "description" = '读取风险信号与规则化风险建议（治理运营可见性）'
WHERE "key" = 'risk.read';

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
JOIN "Permission" p ON p."key" = 'risk.read'
WHERE r."key" = 'PLATFORM_ADMIN'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
