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

  it("P10D-ARCH-02: campus authorization is pushed into RiskFlag query predicates", () => {
    const text = source("src/lib/risk/risk-intelligence.ts");

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

  it("P10D-ARCH-04: evidence DTO excludes sensitive/free-text provenance", () => {
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
