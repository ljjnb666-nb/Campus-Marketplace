import { describe, expect, it, vi } from "vitest";
import { requireNewActivityAllowed, NewActivityDisabledError } from "@/lib/feature-flags/feature-flag-guard";

function mockTx(rows: unknown[] = []) {
  const execute = vi.fn().mockResolvedValue(0);
  const findMany = vi.fn().mockResolvedValue(rows);
  return {
    $executeRaw: execute,
    featureFlagOverride: { findMany },
  } as unknown as Parameters<typeof requireNewActivityAllowed>[0] & {
    $executeRaw: ReturnType<typeof vi.fn>;
    featureFlagOverride: { findMany: ReturnType<typeof vi.fn> };
  };
}

describe("Phase 10F transaction-level flag gate", () => {
  it("reads both GLOBAL and requested campus only, under advisory SHARED tx locks", async () => {
    const tx = mockTx();
    await requireNewActivityAllowed(tx, { kind: "ORDER", campusId: "A" });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(6);
    expect(tx.featureFlagOverride.findMany).toHaveBeenCalledWith({
      where: {
        key: { in: ["DISABLE_NEW_ORDERS", "MAINTENANCE_MODE", "READ_ONLY_MODE"] },
        scopeKey: { in: ["GLOBAL", "CAMPUS:A"] },
      },
      select: { key: true, scopeKey: true, campusId: true, disabled: true, version: true },
    });
  });

  it("GLOBAL true cannot be bypassed by exact campus false", async () => {
    const tx = mockTx([
      { key: "DISABLE_NEW_ORDERS", scopeKey: "GLOBAL", campusId: null, disabled: true, version: 1 },
      { key: "DISABLE_NEW_ORDERS", scopeKey: "CAMPUS:A", campusId: "A", disabled: false, version: 1 },
    ]);
    await expect(requireNewActivityAllowed(tx, { kind: "ORDER", campusId: "A" }))
      .rejects.toBeInstanceOf(NewActivityDisabledError);
  });

  it("ignores other-campus rows only if absent from the DB scope query", async () => {
    const tx = mockTx([
      { key: "DISABLE_NEW_MESSAGES", scopeKey: "CAMPUS:B", campusId: "B", disabled: true, version: 1 },
    ]);
    await expect(requireNewActivityAllowed(tx, { kind: "MESSAGE", campusId: "A" }))
      .rejects.toBeInstanceOf(NewActivityDisabledError);
  });

  it("LISTING_EDIT rejects read-only but not a new-listings-only switch", async () => {
    const disabled = mockTx([
      { key: "READ_ONLY_MODE", scopeKey: "GLOBAL", campusId: null, disabled: true, version: 1 },
    ]);
    await expect(requireNewActivityAllowed(disabled, { kind: "LISTING_EDIT", campusId: "A" }))
      .rejects.toMatchObject({ code: "NEW_ACTIVITY_DISABLED" });
    expect(disabled.featureFlagOverride.findMany).toHaveBeenCalledWith({
      where: {
        key: { in: ["MAINTENANCE_MODE", "READ_ONLY_MODE"] },
        scopeKey: { in: ["GLOBAL", "CAMPUS:A"] },
      },
      select: { key: true, scopeKey: true, campusId: true, disabled: true, version: true },
    });

    const normal = mockTx();
    await expect(requireNewActivityAllowed(normal, { kind: "LISTING_EDIT", campusId: "A" }))
      .resolves.toBeUndefined();
  });

  it("fails closed on DB errors, invalid versions, missing campus and unknown activity", async () => {
    const tx = mockTx();
    tx.featureFlagOverride.findMany.mockRejectedValue(new Error("DATABASE_UNAVAILABLE"));
    await expect(requireNewActivityAllowed(tx, { kind: "LISTING", campusId: "A" }))
      .rejects.toBeInstanceOf(NewActivityDisabledError);
    await expect(requireNewActivityAllowed(tx, { kind: "LISTING", campusId: "" }))
      .rejects.toBeInstanceOf(NewActivityDisabledError);

    const bad = mockTx([{
      key: "DISABLE_NEW_LISTINGS", scopeKey: "GLOBAL", campusId: null, disabled: true, version: 0,
    }]);
    await expect(requireNewActivityAllowed(bad, { kind: "LISTING", campusId: "A" }))
      .rejects.toBeInstanceOf(NewActivityDisabledError);
  });
});
