import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf-8");

describe("Phase 10F kill-switch contract", () => {
  it("P10F-ARCH-01: registered keys are server authoritative, allow no arbitrary config", () => {
    const registry = source("src/lib/feature-flags/feature-flag-registry.ts");
    expect(registry).toContain("FEATURE_FLAG_KEYS");
    expect(registry).toContain("DISABLE_REGISTRATION");
    expect(registry).toContain("READ_ONLY_MODE");
    expect(registry).not.toContain("RESEND_API_KEY");
  });
  it("P10F-ARCH-02: business checks and writer share same advisory lock namespace", () => {
    const guard = source("src/lib/feature-flags/feature-flag-guard.ts");
    const write = source("src/lib/feature-flags/feature-flag-service.ts");
    expect(guard).toContain("pg_advisory_xact_lock_shared");
    expect(guard).toContain("pg_advisory_xact_lock(");
    expect(guard).toContain("FEATURE_FLAG_LOCK_NAMESPACE = 730_506");
    expect(write).toContain("lockFeatureFlagExclusive(tx");
    expect(write).toContain("acquireGovernanceSubjectLocks");
  });
  it("P10F-ARCH-03: governance mutation is authorized, version CAS, audited atomically", () => {
    const write = source("src/lib/feature-flags/feature-flag-service.ts");
    expect(write).toContain('"feature.flags.manage"');
    expect(write).toContain("loadAuthorizationContext(input.actorId, tx)");
    expect(write).toContain("featureFlagOverride.updateMany");
    expect(write).toContain("featureFlagRevision.create");
    expect(write).toContain("recordAdminAudit");
    const perms = source("src/lib/rbac/permissions.ts");
    const legacy = perms.slice(
      perms.indexOf("export const LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS"),
      perms.indexOf("export const ADMIN_SURFACE_PERMISSION_KEYS"),
    );
    expect(legacy).not.toContain('"feature.flags.manage"');
  });
  it("P10F-ARCH-04: immutable revision, DB authority checks and atomic migration", () => {
    const migration = source("prisma/migrations/20261008170000_phase10f_feature_flags/migration.sql");
    expect(migration).toContain("BEGIN;");
    expect(migration).toContain("COMMIT;");
    expect(migration).toContain("FeatureFlagOverride_scope_chk");
    expect(migration).toContain("FeatureFlagOverride_key_chk");
    expect(migration).toContain("FeatureFlagRevision_no_change");
    expect(migration).not.toContain('INSERT INTO "UserRoleAssignment"');
  });
  it("P10F-ARCH-05: every public content editor is fenced", () => {
    const files = [
      "src/actions/product.ts", "src/actions/service.ts",
      "src/actions/rental-listing.ts", "src/lib/errand-lifecycle.ts",
    ];
    for (const file of files) {
      expect(source(file)).toContain('kind: "LISTING_EDIT"');
      expect(source(file)).toContain("requireNewActivityAllowed(tx");
    }
  });
  it("P10F-ARCH-06: new activity denied on DB fault; no UI or business entitlement bypass", () => {
    const guard = source("src/lib/feature-flags/feature-flag-guard.ts");
    expect(guard).toContain("throw new NewActivityDisabledError()");
    expect(guard).toContain("featureFlagOverride.findMany");
    const read = source("src/lib/feature-flags/feature-flag-operator-query.ts");
    expect(read).toContain('"feature.flags.manage"');
    expect(read).toContain("take: 20");
    expect(read).toContain("withTransaction");
    expect(read).toContain("acquireGovernanceSubjectLocks");
    expect(read).toContain("loadAuthorizationContext(input.actorId, tx)");
    expect(read).toContain("lockFeatureFlagSharedById");
  });
});
