import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function source(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("Phase 10D Risk Intelligence architecture contract", () => {
  it("P10D-ARCH-01: engine is advisory-only and has no opaque numeric score", () => {
    const text = source("src/lib/risk/risk-intelligence.ts");

    expect(text).toContain("NO_OPAQUE_SCORING");
    expect(text).toContain("RISK_RULESET_VERSION = 1");
    expect(text).not.toContain("riskScore:");
    expect(text).not.toContain("trustScore:");
    expect(text).not.toContain("riskState.upsert");
    expect(text).not.toContain("riskState.update");
    expect(text).not.toContain("enforcementAction.create");
    expect(text).not.toContain("setRiskState(");
  });

  it("P10D-ARCH-02: independent risk.read scope is pushed into RiskFlag query predicates", () => {
    const text = source("src/lib/risk/risk-intelligence.ts");
    const access = source("src/lib/risk/risk-read-access.ts");
    const enforcementAccess = source("src/lib/enforcement/enforcement-read-access.ts");
    const permissions = source("src/lib/rbac/permissions.ts");

    expect(text).toContain('import type { RiskReadAccess }');
    expect(text).not.toContain("EnforcementReadAccess");
    expect(access).toContain('RISK_READ_PERMISSION = "risk.read"');
    expect(enforcementAccess).not.toContain('RISK_READ_PERMISSION');
    expect(permissions).toContain('"risk.read"');
    expect(text).toContain('whereScope: { campusId }');
    expect(text).toContain('status: "ACTIVE"');
    expect(text).toContain("RISK_INTELLIGENCE_SCOPE_DENIED");
    expect(text).toContain("prisma.riskFlag.groupBy");
    expect(text).toContain("prisma.riskFlag.findMany");
  });

  it("P10D-ARCH-03: neutral allegations/disputes cannot independently request enforcement review", () => {
    const text = source("src/lib/risk/risk-intelligence.ts");

    expect(text).toContain("UNCONFIRMED_REPORT_CONTEXT");
    expect(text).toContain("DISPUTE_CONTEXT_ONLY");
    expect(text).toContain('maxAttention(attentionLevel, "OBSERVE")');
    expect(text).toContain("REPORT_CONFIRMED");
    expect(text).toContain("MANUAL_FLAG");
  });

  it("P10D-ARCH-04: risk.read bootstrap is atomic and does not change legacy admin equivalence", () => {
    const migration = source(
      "prisma/migrations/20261008100000_phase10d_risk_read_permission/migration.sql",
    );
    const permissions = source("src/lib/rbac/permissions.ts");

    expect(migration).toContain("BEGIN;");
    expect(migration).toContain("COMMIT;");
    expect(migration).toContain("'risk.read'");
    expect(migration).toContain("PLATFORM_ADMIN");
    expect(migration).not.toContain("UserRoleAssignment");

    const legacyStart = permissions.indexOf(
      "LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS",
    );
    const legacyEnd = permissions.indexOf(
      "ADMIN_SURFACE_PERMISSION_KEYS",
      legacyStart,
    );
    const legacyBlock = permissions.slice(legacyStart, legacyEnd);
    expect(legacyBlock).not.toContain('"risk.read"');
  });

  it("P10D-ARCH-05: evidence DTO excludes sensitive/free-text provenance", () => {
    const text = source("src/lib/risk/risk-intelligence.ts");
    const selectStart = text.indexOf("select: {", text.indexOf("prisma.riskFlag.findMany"));
    const selectEnd = text.indexOf("},", selectStart);
    const selectBlock = text.slice(selectStart, selectEnd);

    expect(selectBlock).toContain("id: true");
    expect(selectBlock).toContain("sourceType: true");
    expect(selectBlock).not.toContain("sourceId");
    expect(selectBlock).not.toContain("note");
    expect(selectBlock).not.toContain("reasonCode");
    expect(selectBlock).not.toContain("createdById");
  });
});
