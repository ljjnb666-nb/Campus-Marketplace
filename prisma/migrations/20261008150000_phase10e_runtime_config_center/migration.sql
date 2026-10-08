-- Phase 10E: non-secret runtime configuration authority.
-- All DDL + permission grant are one atomic migration.
BEGIN;

CREATE TABLE "RuntimeConfigOverride" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "campusId" TEXT,
    "value" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RuntimeConfigOverride_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RuntimeConfigOverride_scope_chk" CHECK (
      ("scopeKey" = 'GLOBAL' AND "campusId" IS NULL)
      OR ("campusId" IS NOT NULL AND "scopeKey" = 'CAMPUS:' || "campusId")
    ),
    CONSTRAINT "RuntimeConfigOverride_version_chk" CHECK ("version" >= 1),
    CONSTRAINT "RuntimeConfigOverride_registry_chk" CHECK (
      "key" = 'RISK_SIGNAL_EVIDENCE_LIMIT' AND "value" BETWEEN 5 AND 50
    )
);
CREATE UNIQUE INDEX "RuntimeConfigOverride_key_scopeKey_key"
  ON "RuntimeConfigOverride"("key", "scopeKey");
CREATE INDEX "RuntimeConfigOverride_campusId_key_idx"
  ON "RuntimeConfigOverride"("campusId", "key");
ALTER TABLE "RuntimeConfigOverride"
  ADD CONSTRAINT "RuntimeConfigOverride_campusId_fkey"
  FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "RuntimeConfigRevision" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "previousValue" INTEGER,
    "newValue" INTEGER NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RuntimeConfigRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RuntimeConfigRevision_version_chk" CHECK ("version" >= 1),
    CONSTRAINT "RuntimeConfigRevision_value_chk" CHECK (
      "newValue" BETWEEN 5 AND 50
      AND ("previousValue" IS NULL OR "previousValue" BETWEEN 5 AND 50)
    )
);
CREATE UNIQUE INDEX "RuntimeConfigRevision_configId_version_key"
  ON "RuntimeConfigRevision"("configId", "version");
CREATE INDEX "RuntimeConfigRevision_configId_createdAt_idx"
  ON "RuntimeConfigRevision"("configId", "createdAt");
ALTER TABLE "RuntimeConfigRevision"
  ADD CONSTRAINT "RuntimeConfigRevision_configId_fkey"
  FOREIGN KEY ("configId") REFERENCES "RuntimeConfigOverride"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION runtime_config_revision_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'RUNTIME_CONFIG_REVISION_APPEND_ONLY';
END;
$$;
CREATE TRIGGER "RuntimeConfigRevision_no_change"
  BEFORE UPDATE OR DELETE ON "RuntimeConfigRevision"
  FOR EACH ROW EXECUTE FUNCTION runtime_config_revision_immutable();

INSERT INTO "Permission" ("id", "key", "description", "createdAt")
VALUES (
  'pm_' || md5('runtime.config.manage'),
  'runtime.config.manage',
  '调整白名单运行时配置（GLOBAL/CAMPUS，审计与版本保护）',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;
UPDATE "Permission"
SET "description" = '调整白名单运行时配置（GLOBAL/CAMPUS，审计与版本保护）'
WHERE "key" = 'runtime.config.manage';
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
JOIN "Permission" p ON p."key" = 'runtime.config.manage'
WHERE r."key" = 'PLATFORM_ADMIN'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
