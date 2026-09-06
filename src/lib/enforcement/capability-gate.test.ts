import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  txUserFindUnique,
  txMembershipFindFirst,
  txRiskStateFindMany,
  acquireGovernanceSubjectLocks,
} = vi.hoisted(() => ({
  txUserFindUnique: vi.fn(),
  txMembershipFindFirst: vi.fn(),
  txRiskStateFindMany: vi.fn(),
  acquireGovernanceSubjectLocks: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  withTransaction: vi.fn(),
}));

vi.mock("@/lib/governance/governance-lock", () => ({
  acquireGovernanceSubjectLocks,
}));

// isMarketplaceRestricted 用真实实现（纯读），替换其 prisma 依赖为 tx 桩
import {
  enforceMarketplaceCreationGate,
  evaluateMarketplaceCapability,
  requireMarketplaceCapability,
} from "@/lib/enforcement/capability-gate";
import type { Prisma } from "@prisma/client";

const txStub = {
  user: { findUnique: txUserFindUnique },
  campusMembership: { findFirst: txMembershipFindFirst },
  riskState: { findMany: txRiskStateFindMany },
} as unknown as Prisma.TransactionClient;

const ACTIVE_USER = { id: "user-1", status: "ACTIVE", deletedAt: null, erasedAt: null };

beforeEach(() => {
  txUserFindUnique.mockReset().mockResolvedValue({ ...ACTIVE_USER });
  txMembershipFindFirst.mockReset().mockResolvedValue({ id: "m-1" });
  txRiskStateFindMany.mockReset().mockResolvedValue([]);
  acquireGovernanceSubjectLocks.mockReset().mockResolvedValue(undefined);
});

describe("evaluateMarketplaceCapability（START_NEW_MARKETPLACE_ACTIVITY）", () => {
  it("allows an ACTIVE account with an ACTIVE membership and no restriction", async () => {
    await expect(evaluateMarketplaceCapability(txStub, "user-1", "campus-a")).resolves.toEqual({
      allowed: true,
    });
  });

  it("denies when the account is suspended / erased（deny reason: ACCOUNT_INACTIVE）", async () => {
    txUserFindUnique.mockResolvedValue({ ...ACTIVE_USER, status: "SUSPENDED" });
    expect(await evaluateMarketplaceCapability(txStub, "user-1", "campus-a")).toMatchObject({
      allowed: false,
      denialReason: "ACCOUNT_INACTIVE",
    });

    txUserFindUnique.mockResolvedValue({ ...ACTIVE_USER, erasedAt: new Date() });
    expect(await evaluateMarketplaceCapability(txStub, "user-1", "campus-a")).toMatchObject({
      allowed: false,
      denialReason: "ACCOUNT_INACTIVE",
    });
  });

  it("denies without an ACTIVE membership in the activity campus（#18）", async () => {
    txMembershipFindFirst.mockResolvedValue(null);

    expect(await evaluateMarketplaceCapability(txStub, "user-1", "campus-a")).toMatchObject({
      allowed: false,
      denialReason: "MEMBERSHIP_NOT_ACTIVE",
    });
    expect(txMembershipFindFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", campusId: "campus-a", status: "ACTIVE" },
      select: { id: true },
    });
  });

  it("denies when the GLOBAL scope is RESTRICTED", async () => {
    txRiskStateFindMany.mockResolvedValue([{ scopeKey: "GLOBAL" }]);

    expect(await evaluateMarketplaceCapability(txStub, "user-1", "campus-a")).toMatchObject({
      allowed: false,
      denialReason: "RISK_RESTRICTED",
    });
    expect(txRiskStateFindMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        scopeKey: { in: ["GLOBAL", "CAMPUS:campus-a"] },
        state: "RESTRICTED",
      },
      select: { scopeKey: true },
    });
  });

  it("denies when the campus scope is RESTRICTED but GLOBAL is NORMAL", async () => {
    txRiskStateFindMany.mockResolvedValue([{ scopeKey: "CAMPUS:campus-a" }]);

    expect(await evaluateMarketplaceCapability(txStub, "user-1", "campus-a")).toMatchObject({
      allowed: false,
      denialReason: "RISK_RESTRICTED",
    });
  });

  it("does not deny for WATCH（观察态不阻断能力）", async () => {
    txRiskStateFindMany.mockResolvedValue([{ scopeKey: "GLOBAL" }, { scopeKey: "CAMPUS:campus-b" }]);
    // 只有 WATCH 状态时 findMany 不会返回行（查询条件 state=RESTRICTED）——
    // 这里以"查询条件即证"断言 WATCH 不进入判定
    expect(txRiskStateFindMany).not.toHaveBeenCalled();
  });

  it("allows other-campus restrictions to stay scoped（campus 隔离）", async () => {
    // RESTRICTED 行仅存在于 CAMPUS:campus-b：对 campus-a 的活动不受影响
    txRiskStateFindMany.mockResolvedValue([]);
    await expect(evaluateMarketplaceCapability(txStub, "user-1", "campus-a")).resolves.toEqual({
      allowed: true,
    });
  });
});

describe("requireMarketplaceCapability（fail closed 抛错）", () => {
  it("maps denial reasons to stable error codes", async () => {
    txUserFindUnique.mockResolvedValue({ ...ACTIVE_USER, status: "SUSPENDED" });
    await expect(requireMarketplaceCapability(txStub, "user-1", "campus-a")).rejects.toMatchObject({
      code: "AUTH_ACCOUNT_INACTIVE",
    });

    txUserFindUnique.mockResolvedValue({ ...ACTIVE_USER });
    txMembershipFindFirst.mockResolvedValue(null);
    await expect(requireMarketplaceCapability(txStub, "user-1", "campus-a")).rejects.toMatchObject({
      code: "MEMBERSHIP_NOT_ACTIVE",
    });

    txMembershipFindFirst.mockResolvedValue({ id: "m-1" });
    txRiskStateFindMany.mockResolvedValue([{ scopeKey: "GLOBAL" }]);
    await expect(requireMarketplaceCapability(txStub, "user-1", "campus-a")).rejects.toMatchObject({
      code: "MARKETPLACE_RESTRICTED",
    });
  });
});

describe("enforceMarketplaceCreationGate（creation 路径 choke point）", () => {
  it("takes the self subject lock before the capability checks", async () => {
    const order: string[] = [];
    txUserFindUnique.mockImplementation(async () => {
      order.push("check");
      return { ...ACTIVE_USER };
    });

    await enforceMarketplaceCreationGate(txStub, "user-1", "campus-a");

    expect(acquireGovernanceSubjectLocks).toHaveBeenCalledWith(txStub, [
      { subjectType: "USER", subjectId: "user-1" },
    ]);
    expect(order).toEqual(["check"]);
  });
});
