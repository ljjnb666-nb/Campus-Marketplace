import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const source = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
describe("10E config authority guard", () => {
  it("P10E-ARCH-01: only a non-secret, typed registry is mutable", () => {
    const registry = source("src/lib/runtime-config/runtime-config-registry.ts");
    expect(registry).toContain("RISK_SIGNAL_EVIDENCE_LIMIT");
    expect(registry).toContain("NO provider credentials");
    expect(registry).not.toContain("RESEND_API_KEY:");
  });
  it("P10E-ARCH-02: actor lock, fresh scoped RBAC, CAS, same-tx revision and audit", () => {
    const service = source("src/lib/runtime-config/runtime-config-service.ts");
    expect(service).toContain('subjectType: "USER"');
    expect(service).toContain("loadAuthorizationContext(input.actorId, tx)");
    expect(service).toContain('"runtime.config.manage"');
    expect(service).toContain("runtimeConfigOverride.updateMany");
    expect(service).toContain("runtimeConfigRevision.create");
    expect(service).toContain("recordAdminAudit");
    expect(service).toContain("RUNTIME_CONFIG_VERSION_CONFLICT");
  });
  it("P10E-ARCH-03: DB shape, append-only and atomic migration", () => {
    const m = source("prisma/migrations/20261008150000_phase10e_runtime_config_center/migration.sql");
    expect(m).toContain("BEGIN;");
    expect(m).toContain("COMMIT;");
    expect(m).toContain("RuntimeConfigOverride_scope_chk");
    expect(m).toContain("RuntimeConfigOverride_registry_chk");
    expect(m).toContain("RuntimeConfigRevision_no_change");
    expect(m).not.toContain('INSERT INTO "UserRoleAssignment"');
  });
  it("P10E-ARCH-04: scoped operator read exposes its own CAS version", () => {
    const read = source("src/lib/runtime-config/runtime-config-operator-query.ts");
    expect(read).toContain('"runtime.config.manage"');
    expect(read).toContain("currentVersion: row?.version ?? 0");
    expect(read).toContain("take: 20");
    expect(read).not.toContain("actorId: true");
  });
  it("P10E-ARCH-05: consumption cannot widen evidence above original upper bound", () => {
    const risk = source("src/lib/risk/risk-intelligence.ts");
    expect(risk).toContain("loadEffectiveRuntimeConfig");
    expect(risk).toContain("Math.min(RISK_SIGNAL_EVIDENCE_LIMIT, evidenceLimit.value)");
    const perms=source("src/lib/rbac/permissions.ts");
    const legacy=perms.slice(
      perms.indexOf("export const LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS"),
      perms.indexOf("export const ADMIN_SURFACE_PERMISSION_KEYS"),
    );
    expect(legacy).not.toContain('"runtime.config.manage"');
  });
});
