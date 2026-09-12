import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeRaw, userFindMany } = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  userFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

import {
  assertActiveGovernanceSubjects,
  withObligationGuard,
} from "@/lib/governance/obligation-guard";

const ACTIVE = { status: "ACTIVE", deletedAt: null, erasedAt: null };

function makeTx() {
  return {
    $executeRaw: executeRaw,
    user: { findMany: userFindMany },
  };
}

beforeEach(() => {
  executeRaw.mockReset().mockResolvedValue(0);
  userFindMany.mockReset();
});

describe("assertActiveGovernanceSubjects（participant active guard）", () => {
  it("passes when every participant is active and non-erased", async () => {
    userFindMany.mockResolvedValue([
      { id: "user-a", ...ACTIVE },
      { id: "user-b", ...ACTIVE },
    ]);

    await expect(
      assertActiveGovernanceSubjects(makeTx() as never, ["user-a", "user-b"]),
    ).resolves.toBeUndefined();
  });

  it("throws GOVERNANCE_SUBJECT_INACTIVE when a participant is erased", async () => {
    userFindMany.mockResolvedValue([
      { id: "user-a", ...ACTIVE },
      { id: "user-b", ...ACTIVE, erasedAt: new Date() },
    ]);

    await expect(
      assertActiveGovernanceSubjects(makeTx() as never, ["user-a", "user-b"]),
    ).rejects.toMatchObject({ code: "GOVERNANCE_SUBJECT_INACTIVE", status: 409 });
  });

  it("throws for missing, suspended, or soft-deleted participants", async () => {
    // 缺失（查无此行）
    userFindMany.mockResolvedValue([{ id: "user-a", ...ACTIVE }]);
    await expect(
      assertActiveGovernanceSubjects(makeTx() as never, ["user-a", "user-ghost"]),
    ).rejects.toMatchObject({ code: "GOVERNANCE_SUBJECT_INACTIVE" });

    // SUSPENDED
    userFindMany.mockResolvedValue([
      { id: "user-a", ...ACTIVE, status: "SUSPENDED" },
    ]);
    await expect(
      assertActiveGovernanceSubjects(makeTx() as never, ["user-a"]),
    ).rejects.toMatchObject({ code: "GOVERNANCE_SUBJECT_INACTIVE" });

    // 软删除
    userFindMany.mockResolvedValue([
      { id: "user-a", ...ACTIVE, deletedAt: new Date() },
    ]);
    await expect(
      assertActiveGovernanceSubjects(makeTx() as never, ["user-a"]),
    ).rejects.toMatchObject({ code: "GOVERNANCE_SUBJECT_INACTIVE" });
  });
});

describe("withObligationGuard（Phase 6C-3 Repair 2：锁 → validateLocked → racePoint → run）", () => {
  it("acquires deduped subject locks before invoking the locked validator", async () => {
    const tx = { $executeRaw: executeRaw, user: { findMany: userFindMany } };
    const callOrder: string[] = [];
    executeRaw.mockImplementation(() => {
      callOrder.push("lock");
      return Promise.resolve(0);
    });

    const validateLocked = vi.fn(async () => {
      callOrder.push("validate");
    });
    const run = vi.fn(async () => "ok");

    const result = await withObligationGuard(
      tx as never,
      ["user-b", "user-a", "user-b"],
      validateLocked,
      run,
    );

    expect(result).toBe("ok");
    // 去重后恰好两把锁（user-a / user-b），且锁先于锁内校验
    expect(callOrder.filter((entry) => entry === "lock")).toHaveLength(2);
    expect(callOrder.indexOf("validate")).toBeGreaterThan(1);
    expect(validateLocked).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs the race point after validation and before the domain callback", async () => {
    const tx = { $executeRaw: executeRaw, user: { findMany: userFindMany } };
    const order: string[] = [];

    await withObligationGuard(
      tx as never,
      ["user-a"],
      async () => {
        order.push("validate");
      },
      async () => {
        order.push("domain");
        return "ok";
      },
      async () => {
        order.push("racePoint");
      },
    );

    // 冻结序列：校验 → racePoint → 业务写
    expect(order).toEqual(["validate", "racePoint", "domain"]);
  });

  it("never runs the race point or domain callback when the locked validation fails", async () => {
    const tx = { $executeRaw: executeRaw, user: { findMany: userFindMany } };
    const domain = vi.fn();
    const racePoint = vi.fn();

    await expect(
      withObligationGuard(
        tx as never,
        ["user-a"],
        async () => {
          throw Object.assign(new Error("counterparty unavailable"), { code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE", status: 409 });
        },
        domain,
        racePoint,
      ),
    ).rejects.toMatchObject({ code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE" });
    expect(racePoint).not.toHaveBeenCalled();
    expect(domain).not.toHaveBeenCalled();
  });
});
