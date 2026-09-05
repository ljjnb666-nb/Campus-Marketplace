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

describe("withObligationGuard（锁序 + 复核 + seam 次序）", () => {
  it("acquires deduped subject locks before the participant recheck", async () => {
    userFindMany.mockResolvedValue([
      { id: "user-b", ...ACTIVE },
      { id: "user-a", ...ACTIVE },
    ]);

    const tx = { $executeRaw: executeRaw, user: { findMany: userFindMany } };
    const callOrder: string[] = [];
    executeRaw.mockImplementation(() => {
      callOrder.push("lock");
      return Promise.resolve(0);
    });
    userFindMany.mockImplementation(() => {
      callOrder.push("recheck");
      return Promise.resolve([
        { id: "user-b", ...ACTIVE },
        { id: "user-a", ...ACTIVE },
      ]);
    });

    const result = await withObligationGuard(
      tx as never,
      ["user-b", "user-a", "user-b"],
      async () => "ok",
    );

    expect(result).toBe("ok");
    // 去重后恰好两把锁（user-a / user-b），且锁先于复核
    expect(callOrder.filter((entry) => entry === "lock")).toHaveLength(2);
    expect(callOrder.indexOf("recheck")).toBeGreaterThan(1);
    // 复核查询收到去重后的参与方集合
    expect(userFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["user-b", "user-a"] } },
      select: { id: true, status: true, deletedAt: true, erasedAt: true },
    });
  });

  it("runs the race point after the guard and before the domain callback", async () => {
    userFindMany.mockResolvedValue([{ id: "user-a", ...ACTIVE }]);

    const order: string[] = [];
    const tx = { $executeRaw: executeRaw, user: { findMany: userFindMany } };

    await withObligationGuard(
      tx as never,
      ["user-a"],
      async () => {
        order.push("domain");
        return "ok";
      },
      async () => {
        order.push("racePoint");
      },
    );

    expect(order).toEqual(["racePoint", "domain"]);
  });

  it("never runs the domain callback when a participant is inactive", async () => {
    userFindMany.mockResolvedValue([
      { id: "user-a", ...ACTIVE, erasedAt: new Date() },
    ]);

    const tx = { $executeRaw: executeRaw, user: { findMany: userFindMany } };
    const domain = vi.fn();

    await expect(
      withObligationGuard(tx as never, ["user-a"], domain),
    ).rejects.toMatchObject({ code: "GOVERNANCE_SUBJECT_INACTIVE" });
    expect(domain).not.toHaveBeenCalled();
  });
});
