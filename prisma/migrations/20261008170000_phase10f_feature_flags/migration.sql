-- Phase 10F: versioned, restrictive GLOBAL/CAMPUS kill-switch authority.
-- DDL + permission grants are atomic. Existing account-role assignments are untouched.
BEGIN;

CREATE TABLE "FeatureFlagOverride" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "campusId" TEXT,
    "disabled" BOOLEAN,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FeatureFlagOverride_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FeatureFlagOverride_version_chk" CHECK ("version" >= 1),
    CONSTRAINT "FeatureFlagOverride_scope_chk" CHECK (
       ("scopeKey" = 'GLOBAL' AND "campusId" IS NULL)
       OR ("campusId" IS NOT NULL AND "scopeKey" = 'CAMPUS:' || "campusId")
    ),
    CONSTRAINT "FeatureFlagOverride_key_chk" CHECK (
      "key" IN (
        'DISABLE_REGISTRATION',
        'DISABLE_NEW_LISTINGS',
        'DISABLE_NEW_ORDERS',
        'DISABLE_NEW_CONVERSATIONS',
        'DISABLE_NEW_MESSAGES',
        'DISABLE_MEETUPS',
        'DISABLE_DISPUTE_INITIATION',
        'MAINTENANCE_MODE',
        'READ_ONLY_MODE'
      )
    )
);

CREATE UNIQUE INDEX "FeatureFlagOverride_key_scopeKey_key"
  ON "FeatureFlagOverride"("key", "scopeKey");
CREATE INDEX "FeatureFlagOverride_campusId_key_idx"
  ON "FeatureFlagOverride"("campusId", "key");
ALTER TABLE "FeatureFlagOverride"
  ADD CONSTRAINT "FeatureFlagOverride_campusId_fkey"
  FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "FeatureFlagRevision" (
    "id" TEXT NOT NULL,
    "flagId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "previousDisabled" BOOLEAN,
    "nextDisabled" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeatureFlagRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FeatureFlagRevision_version_chk" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX "FeatureFlagRevision_flagId_version_key"
  ON "FeatureFlagRevision"("flagId", "version");
CREATE INDEX "FeatureFlagRevision_flagId_createdAt_idx"
  ON "FeatureFlagRevision"("flagId", "createdAt");
ALTER TABLE "FeatureFlagRevision"
  ADD CONSTRAINT "FeatureFlagRevision_flagId_fkey"
  FOREIGN KEY ("flagId") REFERENCES "FeatureFlagOverride"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION feature_flag_revision_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FEATURE_FLAG_REVISION_APPEND_ONLY';
END;
$$;
CREATE TRIGGER "FeatureFlagRevision_no_change"
  BEFORE UPDATE OR DELETE ON "FeatureFlagRevision"
  FOR EACH ROW EXECUTE FUNCTION feature_flag_revision_immutable();

INSERT INTO "Permission" ("id", "key", "description", "createdAt")
VALUES (
  'pm_' || md5('feature.flags.manage'),
  'feature.flags.manage',
  '管理按校区隔离的功能开关与应急熔断（带审计）',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;

UPDATE "Permission"
SET "description" = '管理按校区隔离的功能开关与应急熔断（带审计）'
WHERE "key" = 'feature.flags.manage';

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
JOIN "Permission" p ON p."key" = 'feature.flags.manage'
WHERE r."key" = 'PLATFORM_ADMIN'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
