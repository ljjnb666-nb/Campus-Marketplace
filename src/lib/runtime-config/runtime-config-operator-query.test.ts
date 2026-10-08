import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadAuthorizationContext, requirePermissionInContext, findUnique } = vi.hoisted(() => ({
  loadAuthorizationContext: vi.fn(),
  requirePermissionInContext: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("@/lib/rbac/service", () => ({
  loadAuthorizationContext,
  requirePermissionInContext,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { runtimeConfigOverride: { findUnique } },
}));

import { loadRuntimeConfigForOperator } from "@/lib/runtime-config/runtime-config-operator-query";

beforeEach(() => {
  loadAuthorizationContext.mockReset().mockResolvedValue({ accountActive: true });
  requirePermissionInContext.mockReset().mockResolvedValue({});
  findUnique.mockReset().mockResolvedValue(null);
});

describe("Phase 10E operator config management read", () => {
  it("checks fresh permission before querying exact GLOBAL scope", async () => {
    const result = await loadRuntimeConfigForOperator({
      actorId: "actor", key: "RISK_SIGNAL_EVIDENCE_LIMIT", campusId: null,
    });
    expect(requirePermissionInContext).toHaveBeenCalledWith(
      { accountActive: true }, "runtime.config.manage", null,
    );
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        key_scopeKey: { key: "RISK_SIGNAL_EVIDENCE_LIMIT", scopeKey: "GLOBAL" },
      },
      select: {
        value: true, version: true,
        revisions: {
          orderBy: { version: "desc" }, take: 20,
          select: {
            version: true, previousValue: true, newValue: true, createdAt: true,
          },
        },
      },
    });
    expect(result).toMatchObject({ currentValue: null, currentVersion: 0 });
  });

  it("INHERIT tombstone keeps its own CAS version, independent of inherited GLOBAL", async () => {
    findUnique.mockResolvedValue({
      value: null, version: 4,
      revisions: [{
        version: 4, previousValue: 10, newValue: null,
        createdAt: new Date("2026-10-08T00:00:00Z"),
      }],
    });
    const result = await loadRuntimeConfigForOperator({
      actorId: "actor", key: "RISK_SIGNAL_EVIDENCE_LIMIT", campusId: "A",
    });
    expect(result).toEqual({
      key: "RISK_SIGNAL_EVIDENCE_LIMIT",
      scopeKey: "CAMPUS:A",
      currentValue: null,
      currentVersion: 4,
      revisions: [{
        version: 4, previousValue: 10, newValue: null,
        createdAt: "2026-10-08T00:00:00.000Z",
      }],
    });
  });

  it("denied permission prevents any config row existence query", async () => {
    requirePermissionInContext.mockRejectedValue(new Error("DENY"));
    await expect(loadRuntimeConfigForOperator({
      actorId: "actor", key: "RISK_SIGNAL_EVIDENCE_LIMIT", campusId: "A",
    })).rejects.toThrow("DENY");
    expect(findUnique).not.toHaveBeenCalled();
  });
});
