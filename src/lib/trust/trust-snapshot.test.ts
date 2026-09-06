import { beforeEach, describe, expect, it, vi } from "vitest";

const { userFindUnique, riskStateFindMany, riskFlagCount, reportFindMany } = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  riskStateFindMany: vi.fn(),
  riskFlagCount: vi.fn(),
  reportFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    riskState: { findMany: riskStateFindMany },
    riskFlag: { count: riskFlagCount },
    report: { findMany: reportFindMany },
  },
}));

// loadAuthorizationContext 替换（授权路径单测）；hasPermission 用真实实现
const { loadAuthorizationContextMock } = vi.hoisted(() => ({
  loadAuthorizationContextMock: vi.fn(),
}));
vi.mock("@/lib/rbac/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rbac/service")>();
  return {
    ...actual,
    loadAuthorizationContext: loadAuthorizationContextMock,
  };
});

import type { AuthorizationContext } from "@/lib/rbac/service";
import {
  getInternalTrustSnapshot,
  getPublicTrustSnapshot,
} from "@/lib/trust/trust-snapshot";

const USER_ROW = {
  id: "user-1",
  verificationStatus: "VERIFIED",
  creditScore: 100,
  completedOrdersCount: 12,
  positiveReviewRate: 0.95,
  rentalOwnerCount: 3,
  rentalRenterCount: 2,
  onTimeReturnRate: 0.9,
  rentalPositiveRate: 0.93,
  rentalDisputeCount: 1,
  memberships: [
    { campusId: "campus-a", status: "ACTIVE" },
    { campusId: "campus-b", status: "LEFT" },
  ],
  _count: { receivedReviews: 7 },
};

const AUDITED_ACTOR: AuthorizationContext = {
  userId: "actor-1",
  accountActive: true,
  activeCampusIds: [],
  grants: [
    {
      roleKey: "PLATFORM_ADMIN",
      scope: "GLOBAL",
      campusId: null,
      permissionKeys: ["audit.read"],
    },
  ],
};

beforeEach(() => {
  userFindUnique.mockReset().mockResolvedValue({ ...USER_ROW });
  riskStateFindMany.mockReset().mockResolvedValue([]);
  riskFlagCount.mockReset().mockResolvedValue(0);
  loadAuthorizationContextMock.mockReset().mockResolvedValue(AUDITED_ACTOR);
});

describe("getPublicTrustSnapshot（public 安全信号）", () => {
  it("returns only public-safe signals and never risk/report internals", async () => {
    const snapshot = await getPublicTrustSnapshot("user-1");

    expect(snapshot).toMatchObject({
      userId: "user-1",
      verification: { status: "VERIFIED" },
      membership: { activeCampusCount: 1 },
      transactionHistory: { completedOrdersCount: 12 },
      reviewSignals: { positiveReviewRate: 0.95, receivedReviewsCount: 7 },
      rentalSignals: { rentalDisputeCount: 1 },
      legacyCreditScore: { value: 100, policy: "LEGACY_DISPLAY_SIGNAL" },
    });

    const json = JSON.stringify(snapshot);
    // Repair 1 Blocker B 禁止项在结构上不可出现
    expect(json).not.toContain("risk");
    expect(json).not.toContain("reportSignals");
    expect(json).not.toContain("openReport");
    expect(json).not.toContain("resolvedReport");
    expect(json).not.toContain("activeRestrictions");
    expect(snapshot && "riskScore" in snapshot).toBe(false);
    // 公开视图不透出内部 campusId 列表
    expect(JSON.stringify(snapshot)).not.toContain("campus-a");
  });

  it("returns null for unknown users", async () => {
    userFindUnique.mockResolvedValue(null);
    await expect(getPublicTrustSnapshot("ghost")).resolves.toBeNull();
  });
});

describe("getInternalTrustSnapshot（admin-only 授权视图）", () => {
  it("denies actors without audit.read（DEFAULT_DENY，不依赖 includeRisk 自报）", async () => {
    loadAuthorizationContextMock.mockResolvedValue({
      userId: "actor-1",
      accountActive: true,
      activeCampusIds: [],
      grants: [],
    });

    await expect(
      getInternalTrustSnapshot({ actorId: "actor-1", targetUserId: "user-1" }),
    ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("denies inactive actors", async () => {
    loadAuthorizationContextMock.mockResolvedValue({
      userId: "actor-1",
      accountActive: false,
      activeCampusIds: [],
      grants: AUDITED_ACTOR.grants,
    });

    await expect(
      getInternalTrustSnapshot({ actorId: "actor-1", targetUserId: "user-1" }),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });
  });

  it("requires campus-scoped audit.read for campus views", async () => {
    loadAuthorizationContextMock.mockResolvedValue({
      userId: "actor-1",
      accountActive: true,
      activeCampusIds: ["campus-b"],
      grants: [
        {
          roleKey: "CAMPUS_AUDITOR",
          scope: "CAMPUS",
          campusId: "campus-b",
          permissionKeys: ["audit.read"],
        },
      ],
    });

    // campus-a 视角：scope 不匹配 → DENY
    await expect(
      getInternalTrustSnapshot({ actorId: "actor-1", targetUserId: "user-1", campusId: "campus-a" }),
    ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });

    // campus-b 视角：命中 → ALLOW
    await expect(
      getInternalTrustSnapshot({ actorId: "actor-1", targetUserId: "user-1", campusId: "campus-b" }),
    ).resolves.toBeTruthy();
  });

  it("aggregates RiskFlag-based submitted/confirmed signals distinctly", async () => {
    riskFlagCount.mockImplementation(async ({ where }: { where: { kind: string } }) =>
      where.kind === "REPORT_SUBMITTED" ? 3 : 1,
    );
    riskStateFindMany.mockResolvedValue([
      { scopeKey: "GLOBAL", campusId: null, state: "RESTRICTED", reasonCode: "FRAUD_CONFIRMED" },
    ]);

    const snapshot = await getInternalTrustSnapshot({
      actorId: "actor-1",
      targetUserId: "user-1",
    });

    expect(snapshot?.reportSignals).toEqual({
      submittedReportSignals: 3,
      confirmedReportSignals: 1,
      submittedSignalNote: "SIGNAL_NOT_ADIJUDICATED_FACT",
      confirmedSignalNote: "CONFIRMED_AFTER_REVIEW",
    });
    expect(snapshot?.risk?.activeRestrictions).toEqual(["GLOBAL"]);
    expect(snapshot?.risk?.states[0]).toMatchObject({ state: "RESTRICTED" });
  });

  it("scopes campus views to GLOBAL + that campus risk rows only", async () => {
    await getInternalTrustSnapshot({
      actorId: "actor-1",
      targetUserId: "user-1",
      campusId: "campus-a",
    });

    expect(riskStateFindMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        scopeKey: { in: ["GLOBAL", "CAMPUS:campus-a"] },
      },
      select: { scopeKey: true, campusId: true, state: true, reasonCode: true },
      orderBy: [{ scopeKey: "asc" }],
    });
  });

  it("returns null for unknown targets (authorized actor)", async () => {
    userFindUnique.mockResolvedValue(null);
    await expect(
      getInternalTrustSnapshot({ actorId: "actor-1", targetUserId: "ghost" }),
    ).resolves.toBeNull();
  });
});
