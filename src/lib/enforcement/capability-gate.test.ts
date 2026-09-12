import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  txUserFindUnique,
  txMembershipFindFirst,
  txRiskStateFindMany,
  txUserFindMany,
  txMembershipFindMany,
  acquireGovernanceSubjectLocks,
  incrementCounter,
} = vi.hoisted(() => ({
  txUserFindUnique: vi.fn(),
  txMembershipFindFirst: vi.fn(),
  txRiskStateFindMany: vi.fn(),
  txUserFindMany: vi.fn(),
  txMembershipFindMany: vi.fn(),
  acquireGovernanceSubjectLocks: vi.fn(),
  incrementCounter: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  withTransaction: vi.fn(),
}));

vi.mock("@/lib/governance/governance-lock", () => ({
  acquireGovernanceSubjectLocks,
}));

vi.mock("@/lib/metrics", () => ({
  incrementCounter,
}));

import {
  enforceMarketplaceCapability,
  evaluateMarketplaceCapability,
  marketplaceObligationValidator,
  requireMarketplaceCapability,
  requireParticipantsMarketplaceEligible,
} from "@/lib/enforcement/capability-gate";
import type { Prisma } from "@prisma/client";

const txStub = {
  user: { findUnique: txUserFindUnique, findMany: txUserFindMany },
  campusMembership: { findFirst: txMembershipFindFirst, findMany: txMembershipFindMany },
  riskState: { findMany: txRiskStateFindMany },
} as unknown as Prisma.TransactionClient;

const ACTIVE_USER = { id: "user-1", status: "ACTIVE", deletedAt: null, erasedAt: null };

beforeEach(() => {
  txUserFindUnique.mockReset().mockResolvedValue({ ...ACTIVE_USER });
  txMembershipFindFirst.mockReset().mockResolvedValue({ id: "m-1" });
  txRiskStateFindMany.mockReset().mockResolvedValue([]);
  txUserFindMany.mockReset().mockResolvedValue([]);
  txMembershipFindMany.mockReset().mockResolvedValue([]);
  acquireGovernanceSubjectLocks.mockReset().mockResolvedValue(undefined);
  incrementCounter.mockReset();
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

  it("denies when the GLOBAL scope is RESTRICTED（matchedScopeKind=GLOBAL）", async () => {
    txRiskStateFindMany.mockResolvedValue([{ scopeKey: "GLOBAL" }]);

    expect(await evaluateMarketplaceCapability(txStub, "user-1", "campus-a")).toMatchObject({
      allowed: false,
      denialReason: "RISK_RESTRICTED",
      matchedScopeKind: "GLOBAL",
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
      matchedScopeKind: "CAMPUS",
    });
  });

  it("accepts MODIFY_PUBLIC_LISTING_CONTENT capability value（taxonomy 冻结 2 值）", async () => {
    await expect(
      evaluateMarketplaceCapability(
        txStub,
        "user-1",
        "campus-a",
        "MODIFY_PUBLIC_LISTING_CONTENT",
      ),
    ).resolves.toEqual({ allowed: true });
  });

  it("allows other-campus restrictions to stay scoped（campus 隔离）", async () => {
    // RESTRICTED 行仅存在于 CAMPUS:campus-b：对 campus-a 的活动不受影响
    txRiskStateFindMany.mockResolvedValue([]);
    await expect(evaluateMarketplaceCapability(txStub, "user-1", "campus-a")).resolves.toEqual({
      allowed: true,
    });
  });
});

describe("requireMarketplaceCapability（fail closed 抛错 + metrics）", () => {
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

  it("increments marketplace_capability_denied_total with low-cardinality labels", async () => {
    txUserFindUnique.mockResolvedValue({ ...ACTIVE_USER });
    txMembershipFindFirst.mockResolvedValue({ id: "m-1" });
    txRiskStateFindMany.mockResolvedValue([{ scopeKey: "CAMPUS:campus-a" }]);

    await expect(
      requireMarketplaceCapability(txStub, "user-1", "campus-a"),
    ).rejects.toMatchObject({ code: "MARKETPLACE_RESTRICTED" });

    expect(incrementCounter).toHaveBeenCalledWith("marketplace_capability_denied_total", {
      capability: "START_NEW_MARKETPLACE_ACTIVITY",
      scope_kind: "CAMPUS",
    });
  });
});

describe("enforceMarketplaceCapability（choke point：自取单把 USER subject 锁）", () => {
  it("takes the self subject lock before the capability checks", async () => {
    const order: string[] = [];
    txUserFindUnique.mockImplementation(async () => {
      order.push("check");
      return { ...ACTIVE_USER };
    });

    await enforceMarketplaceCapability(txStub, "user-1", "campus-a");

    expect(acquireGovernanceSubjectLocks).toHaveBeenCalledWith(txStub, [
      { subjectType: "USER", subjectId: "user-1" },
    ]);
    expect(order).toEqual(["check"]);
  });

  it("runs racePoint after the capability check passes（锁 + 门 + seam 次序）", async () => {
    const order: string[] = [];
    txUserFindUnique.mockImplementation(async () => {
      order.push("check");
      return { ...ACTIVE_USER };
    });

    await enforceMarketplaceCapability(txStub, "user-1", "campus-a", "START_NEW_MARKETPLACE_ACTIVITY", async () => {
      order.push("racePoint");
    });

    expect(order).toEqual(["check", "racePoint"]);
  });

  it("does not run racePoint when the capability check fails", async () => {
    txUserFindUnique.mockResolvedValue({ ...ACTIVE_USER, status: "SUSPENDED" });
    const racePoint = vi.fn();

    await expect(
      enforceMarketplaceCapability(txStub, "user-1", "campus-a", "MODIFY_PUBLIC_LISTING_CONTENT", racePoint),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });
    expect(racePoint).not.toHaveBeenCalled();
  });
});

describe("requireParticipantsMarketplaceEligible（Phase 6C-3 全参与方资格门）", () => {
  const ELIGIBLE_USER = { id: "user-2", status: "ACTIVE", deletedAt: null, erasedAt: null };

  it("passes when every participant is eligible in the campus", async () => {
    txUserFindMany.mockResolvedValue([
      { ...ACTIVE_USER },
      { ...ELIGIBLE_USER },
    ]);
    txMembershipFindMany.mockResolvedValue([{ userId: "user-1" }, { userId: "user-2" }]);

    await expect(
      requireParticipantsMarketplaceEligible(txStub, ["user-1", "user-2"], "campus-a"),
    ).resolves.toBeUndefined();
    // 批量查询（3 个查询与人数无关）
    expect(txUserFindMany).toHaveBeenCalledTimes(1);
    expect(txMembershipFindMany).toHaveBeenCalledTimes(1);
    expect(txRiskStateFindMany).toHaveBeenCalledTimes(1);
    expect(txRiskStateFindMany).toHaveBeenCalledWith({
      where: {
        userId: { in: ["user-1", "user-2"] },
        scopeKey: { in: ["GLOBAL", "CAMPUS:campus-a"] },
        state: "RESTRICTED",
      },
      select: { scopeKey: true },
    });
  });

  it("throws the unified 409 counterparty error when account inactive / membership inactive", async () => {
    // account 维度失效
    txUserFindMany.mockResolvedValue([{ ...ACTIVE_USER }]); // user-2 缺失
    txMembershipFindMany.mockResolvedValue([{ userId: "user-1" }, { userId: "user-2" }]);
    await expect(
      requireParticipantsMarketplaceEligible(txStub, ["user-1", "user-2"], "campus-a"),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE",
      status: 409,
    });

    // membership 维度失效
    txUserFindMany.mockResolvedValue([
      { ...ACTIVE_USER },
      { ...ELIGIBLE_USER },
    ]);
    txMembershipFindMany.mockResolvedValue([{ userId: "user-1" }]); // user-2 无 ACTIVE membership
    await expect(
      requireParticipantsMarketplaceEligible(txStub, ["user-1", "user-2"], "campus-a"),
    ).rejects.toMatchObject({ code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE", status: 409 });
  });

  it("throws the unified 409 when any participant is risk RESTRICTED（GLOBAL 或 CAMPUS）", async () => {
    txUserFindMany.mockResolvedValue([
      { ...ACTIVE_USER },
      { ...ELIGIBLE_USER },
    ]);
    txMembershipFindMany.mockResolvedValue([{ userId: "user-1" }, { userId: "user-2" }]);

    // GLOBAL RESTRICTED（任一参与方）
    txRiskStateFindMany.mockResolvedValue([{ scopeKey: "GLOBAL" }]);
    await expect(
      requireParticipantsMarketplaceEligible(txStub, ["user-1", "user-2"], "campus-a"),
    ).rejects.toMatchObject({ code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE", status: 409 });

    // CAMPUS RESTRICTED（对手方）
    txRiskStateFindMany.mockResolvedValue([{ scopeKey: "CAMPUS:campus-a" }]);
    await expect(
      requireParticipantsMarketplaceEligible(txStub, ["user-1", "user-2"], "campus-a"),
    ).rejects.toMatchObject({ code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE", status: 409 });

    // WATCH 不阻断
    txRiskStateFindMany.mockResolvedValue([]);
    await expect(
      requireParticipantsMarketplaceEligible(txStub, ["user-1", "user-2"], "campus-a"),
    ).resolves.toBeUndefined();
  });

  it("keeps other-campus restriction rows out of scope（campus 隔离，CAP-05）", async () => {
    txUserFindMany.mockResolvedValue([
      { ...ACTIVE_USER },
      { ...ELIGIBLE_USER },
    ]);
    txMembershipFindMany.mockResolvedValue([{ userId: "user-1" }, { userId: "user-2" }]);
    // 查询条件只覆盖 GLOBAL + CAMPUS:campus-a；campus-b 行不可能命中
    txRiskStateFindMany.mockResolvedValue([]);

    await expect(
      requireParticipantsMarketplaceEligible(txStub, ["user-1", "user-2"], "campus-a"),
    ).resolves.toBeUndefined();
  });
});

describe("marketplaceObligationValidator（锁内校验回调工厂）", () => {
  it("runs actor capability first, then participant eligibility（归因次序合同）", async () => {
    txUserFindUnique.mockResolvedValue({ ...ACTIVE_USER, status: "SUSPENDED" });

    const validate = marketplaceObligationValidator({
      initiatorId: "user-1",
      participantUserIds: ["user-1", "user-2"],
      campusId: "campus-a",
    });

    // actor 失败必须以 actor 专用 403 族抛出（不被 409 吞掉）
    await expect(validate(txStub)).rejects.toMatchObject({
      code: "AUTH_ACCOUNT_INACTIVE",
      status: 403,
    });

    // actor 通过后，对手方失效才以统一 409 抛出
    txUserFindUnique.mockResolvedValue({ ...ACTIVE_USER });
    txMembershipFindFirst.mockResolvedValue({ id: "m-1" });
    txUserFindMany.mockResolvedValue([
      { ...ACTIVE_USER },
      { id: "user-2", status: "ACTIVE", deletedAt: null, erasedAt: null },
    ]);
    txMembershipFindMany.mockResolvedValue([{ userId: "user-1" }]);
    txRiskStateFindMany.mockResolvedValue([]);

    await expect(validate(txStub)).rejects.toMatchObject({
      code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE",
      status: 409,
    });
  });

  it("passes without any throw when all participants are eligible", async () => {
    txUserFindUnique.mockResolvedValue({ ...ACTIVE_USER });
    txMembershipFindFirst.mockResolvedValue({ id: "m-1" });
    txUserFindMany.mockResolvedValue([
      { ...ACTIVE_USER },
      { ...ACTIVE_USER, id: "user-2" },
    ]);
    txMembershipFindMany.mockResolvedValue([{ userId: "user-1" }, { userId: "user-2" }]);
    txRiskStateFindMany.mockResolvedValue([]);

    const validate = marketplaceObligationValidator({
      initiatorId: "user-1",
      participantUserIds: ["user-1", "user-2"],
      campusId: "campus-a",
    });

    await expect(validate(txStub)).resolves.toBeUndefined();
  });
});

