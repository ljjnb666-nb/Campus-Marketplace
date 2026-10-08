import { beforeEach, describe, expect, it, vi } from "vitest";
const { configFindMany } = vi.hoisted(() => ({ configFindMany: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { runtimeConfigOverride: { findMany: configFindMany } },
}));
import { loadEffectiveRuntimeConfig } from "@/lib/runtime-config/runtime-config-query";

beforeEach(() => configFindMany.mockReset().mockResolvedValue([]));

describe("10E effective runtime config lookup", () => {
  it("default read is deterministic and GLOBAL/CAMPUS lookup is one scoped DB query", async () => {
    expect(await loadEffectiveRuntimeConfig({ key: "RISK_SIGNAL_EVIDENCE_LIMIT" }))
      .toEqual({ key: "RISK_SIGNAL_EVIDENCE_LIMIT", value: 50, source: "DEFAULT", version: null });
    expect(configFindMany).toHaveBeenCalledWith({
      where: { key: "RISK_SIGNAL_EVIDENCE_LIMIT", scopeKey: { in: ["GLOBAL"] } },
      select: { scopeKey: true, campusId: true, value: true, version: true },
    });
    configFindMany.mockResolvedValue([
      { scopeKey: "GLOBAL", campusId: null, value: 45, version: 2 },
      { scopeKey: "CAMPUS:A", campusId: "A", value: 12, version: 3 },
    ]);
    expect(await loadEffectiveRuntimeConfig({
      key: "RISK_SIGNAL_EVIDENCE_LIMIT", campusId: "A",
    })).toEqual({ key: "RISK_SIGNAL_EVIDENCE_LIMIT", value: 12, source: "CAMPUS_OVERRIDE", version: 3 });
    expect(configFindMany).toHaveBeenLastCalledWith({
      where: { key: "RISK_SIGNAL_EVIDENCE_LIMIT", scopeKey: { in: ["GLOBAL", "CAMPUS:A"] } },
      select: { scopeKey: true, campusId: true, value: true, version: true },
    });
  });

  it("invalid local override must fail safe, not fall through to permissive global", async () => {
    configFindMany.mockResolvedValue([
      { scopeKey: "GLOBAL", campusId: null, value: 50, version: 1 },
      { scopeKey: "CAMPUS:A", campusId: "B", value: 50, version: 1 },
    ]);
    expect(await loadEffectiveRuntimeConfig({
      key: "RISK_SIGNAL_EVIDENCE_LIMIT", campusId: "A",
    })).toMatchObject({ value: 10, source: "SAFE_FALLBACK" });
  });

  it("DB outage and invalid value both produce the restricted safe fallback", async () => {
    configFindMany.mockRejectedValue(new Error("DB_UNAVAILABLE"));
    expect(await loadEffectiveRuntimeConfig({
      key: "RISK_SIGNAL_EVIDENCE_LIMIT",
    })).toMatchObject({ value: 10, source: "SAFE_FALLBACK" });
    configFindMany.mockResolvedValue([
      { scopeKey: "GLOBAL", campusId: null, value: 999, version: 1 },
    ]);
    expect(await loadEffectiveRuntimeConfig({
      key: "RISK_SIGNAL_EVIDENCE_LIMIT",
    })).toMatchObject({ value: 10, source: "SAFE_FALLBACK" });
  });
});
