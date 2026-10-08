import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  acquireGovernanceSubjectLocks, lockFeatureFlagSharedById,
  withTransaction, loadAuthorizationContext, requirePermissionInContext,
  findMany,
} = vi.hoisted(() => ({
  acquireGovernanceSubjectLocks: vi.fn(),
  lockFeatureFlagSharedById: vi.fn(),
  withTransaction: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  requirePermissionInContext: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/governance/governance-lock", () => ({ acquireGovernanceSubjectLocks }));
vi.mock("@/lib/feature-flags/feature-flag-guard", () => ({ lockFeatureFlagSharedById }));
vi.mock("@/lib/prisma", () => ({ withTransaction }));
vi.mock("@/lib/rbac/service", () => ({
  loadAuthorizationContext, requirePermissionInContext,
}));

import { loadFeatureFlagConsoleRows } from "@/lib/feature-flags/feature-flag-ui-query";

const actor = {
  userId: "operator", accountActive: true, activeCampusIds: ["campus-A"],
  grants: [{ roleKey: "X", scope: "CAMPUS", campusId: "campus-A",
    permissionKeys: ["feature.flags.manage"] }],
};
const moment = new Date("2026-10-08T00:00:00.000Z");
function record(key: string, scopeKey: string, campusId: string | null,
                disabled: boolean | null, version: number,
                revisions: Array<{ version: number; previousDisabled: boolean | null;
                  nextDisabled: boolean | null; createdAt: Date }> = []) {
  return { key, scopeKey, campusId, disabled, version, revisions };
}

beforeEach(() => {
  vi.clearAllMocks();
  withTransaction.mockImplementation(
    (callback: (tx: { featureFlagOverride: { findMany: typeof findMany } }) => Promise<unknown>) =>
      callback({ featureFlagOverride: { findMany } }),
  );
  loadAuthorizationContext.mockResolvedValue(actor);
  requirePermissionInContext.mockResolvedValue(actor);
  findMany.mockResolvedValue([]);
});

describe("10G operator snapshot: exact-scope, GLOBAL precedence, serialized read", () => {
  it("G16: GLOBAL disable wins over local false; only local revisions leave the server", async () => {
    findMany.mockResolvedValue([
      record("DISABLE_NEW_ORDERS", "GLOBAL", null, true, 5, [
        { version: 5, previousDisabled: false, nextDisabled: true, createdAt: moment },
      ]),
      record("DISABLE_NEW_ORDERS", "CAMPUS:campus-A", "campus-A", false, 2, [
        { version: 2, previousDisabled: true, nextDisabled: false, createdAt: moment },
      ]),
    ]);
    const rows = await loadFeatureFlagConsoleRows({ actorId: "operator", campusId: "campus-A" });
    expect(rows).toHaveLength(9);
    const order = rows.find(row => row.key === "DISABLE_NEW_ORDERS")!;
    expect(order).toMatchObject({
      globalDisabled: true, effectiveDisabled: true, localDisabled: false,
      currentVersion: 2, revisions: [{ version: 2, nextDisabled: false }],
    });
    expect(order.revisions).not.toContainEqual(expect.objectContaining({ version: 5 }));
    expect(rows.find(row => row.key === "DISABLE_NEW_MESSAGES")).toMatchObject({
      effectiveDisabled: false, currentVersion: 0, revisions: [],
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        key: { in: expect.arrayContaining(["DISABLE_NEW_ORDERS"]) },
        scopeKey: { in: ["GLOBAL", "CAMPUS:campus-A"] },
      },
    }));
    expect(acquireGovernanceSubjectLocks).toHaveBeenCalledWith(
      expect.anything(), [{ subjectType: "USER", subjectId: "operator" }],
    );
    expect(requirePermissionInContext).toHaveBeenCalledWith(
      actor, "feature.flags.manage", "campus-A",
    );
    const ids = lockFeatureFlagSharedById.mock.calls.map((args: unknown[]) => args[1]);
    expect(ids).toHaveLength(18);
    expect(ids).toEqual([...ids].sort());
    expect(Math.max(...lockFeatureFlagSharedById.mock.invocationCallOrder))
      .toBeLessThan(findMany.mock.invocationCallOrder[0]);
  });

  it("G17: GLOBAL operator sees only GLOBAL version/history and takes nine locks", async () => {
    findMany.mockResolvedValue([record(
      "DISABLE_REGISTRATION", "GLOBAL", null, true, 1,
      [{ version: 1, previousDisabled: null, nextDisabled: true, createdAt: moment }],
    )]);
    const rows = await loadFeatureFlagConsoleRows({ actorId: "operator", campusId: null });
    expect(rows.find(r => r.key === "DISABLE_REGISTRATION")).toMatchObject({
      effectiveDisabled: true, currentVersion: 1,
      revisions: [{ version: 1, nextDisabled: true, createdAt: moment.toISOString() }],
    });
    expect(requirePermissionInContext).toHaveBeenCalledWith(actor, "feature.flags.manage", null);
    expect(lockFeatureFlagSharedById).toHaveBeenCalledTimes(9);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ scopeKey: { in: ["GLOBAL"] } }),
    }));
  });

  it("G18: fresh permission denial never reaches feature-flag table", async () => {
    requirePermissionInContext.mockRejectedValueOnce(new Error("AUTH_PERMISSION_DENIED"));
    await expect(loadFeatureFlagConsoleRows({ actorId: "operator", campusId: "campus-B" }))
      .rejects.toThrow("AUTH_PERMISSION_DENIED");
    expect(findMany).not.toHaveBeenCalled();
    expect(lockFeatureFlagSharedById).not.toHaveBeenCalled();
  });

  it("G19: DB outage and malformed scoped rows fail closed, not default-to-available", async () => {
    findMany.mockRejectedValueOnce(new Error("DB_OFFLINE"));
    await expect(loadFeatureFlagConsoleRows({ actorId: "operator", campusId: "campus-A" }))
      .rejects.toThrow("DB_OFFLINE");
    findMany.mockResolvedValueOnce([
      record("DISABLE_NEW_ORDERS", "CAMPUS:campus-A", "campus-B", false, 1),
    ]);
    await expect(loadFeatureFlagConsoleRows({ actorId: "operator", campusId: "campus-A" }))
      .rejects.toThrow("FEATURE_FLAG_AUTHORITY_INVALID");
  });
});
