import { beforeEach, describe, expect, it, vi } from "vitest";

const { userFindUnique, riskStateFindMany, riskFlagCount, reportFindMany } = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  riskStateFindMany: vi.fn(),
  riskFlagCount: vi.fn(),
  reportFindMany: vi.fn(),
}));

const { campusMembershipFindUnique } = vi.hoisted(() => ({
  campusMembershipFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    riskState: { findMany: riskStateFindMany },
    riskFlag: { count: riskFlagCount },
    report: { findMany: reportFindMany },
    campusMembership: { findUnique: campusMembershipFindUnique },
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

function campusAuditor(campusId: string): AuthorizationContext {
  return {
    userId: "actor-1",
    accountActive: true,
    activeCampusIds: [campusId],
    grants: [
      {
        roleKey: "CAMPUS_AUDITOR",
        scope: "CAMPUS",
        campusId,
        permissionKeys: ["audit.read"],
      },
    ],
  };
}

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
  campusMembershipFindUnique.mockReset().mockResolvedValue({ status: "ACTIVE" });
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
    loadAuthorizationContextMock.mockResolvedValue(campusAuditor("campus-b"));

    // campus-a 视角：scope 不匹配 → DENY
    await expect(
      getInternalTrustSnapshot({ actorId: "actor-1", targetUserId: "user-1", campusId: "campus-a" }),
    ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });

    // campus-b 视角：user-1 在 campus-b 的 membership 为 LEFT → target
    // relationship DENY（GLOBAL/campus 都不能绕过）
    campusMembershipFindUnique.mockResolvedValue({ status: "LEFT" });
    await expect(
      getInternalTrustSnapshot({ actorId: "actor-1", targetUserId: "user-1", campusId: "campus-b" }),
    ).rejects.toMatchObject({ code: "ENFORCEMENT_TARGET_SCOPE_MISMATCH" });

    // campus-a 视角：actor 有 audit.read@A 且 target 是 A ACTIVE member → ALLOW
    campusMembershipFindUnique.mockResolvedValue({ status: "ACTIVE" });
    loadAuthorizationContextMock.mockResolvedValue(campusAuditor("campus-a"));
    await expect(
      getInternalTrustSnapshot({ actorId: "actor-1", targetUserId: "user-1", campusId: "campus-a" }),
    ).resolves.toMatchObject({ view: "CAMPUS", campusId: "campus-a" });

    // GLOBAL auditor 请求 campus 视图：仍受 target relationship 约束（不绕过）
    loadAuthorizationContextMock.mockResolvedValue({
      userId: "global-actor",
      accountActive: true,
      activeCampusIds: [],
      grants: [{ roleKey: "PLATFORM_ADMIN", scope: "GLOBAL", campusId: null, permissionKeys: ["audit.read"] }],
    });
    campusMembershipFindUnique.mockResolvedValue({ status: "LEFT" });
    await expect(
      getInternalTrustSnapshot({ actorId: "global-actor", targetUserId: "user-1", campusId: "campus-a" }),
    ).rejects.toMatchObject({ code: "ENFORCEMENT_TARGET_SCOPE_MISMATCH" });
  });

  it("aggregates RiskFlag-based submitted/confirmed signals distinctly (GLOBAL view)", async () => {
    riskFlagCount.mockImplementation(async ({ where }: { where: { kind: string } }) =>
      where.kind === "REPORT_SUBMITTED" ? 3 : 1,
    );
    riskStateFindMany.mockResolvedValue([
      { scopeKey: "GLOBAL", campusId: null, state: "RESTRICTED", reasonCode: "FRAUD_CONFIRMED" },
      { scopeKey: "CAMPUS:campus-a", campusId: "campus-a", state: "WATCH", reasonCode: "MANUAL_REVIEW" },
    ]);

    const snapshot = await getInternalTrustSnapshot({
      actorId: "actor-1",
      targetUserId: "user-1",
    });

    // GLOBAL 判别字段
    expect(snapshot?.view).toBe("GLOBAL");
    if (snapshot?.view !== "GLOBAL") {
      throw new Error("expected GLOBAL view");
    }
    expect(snapshot.reportSignals).toEqual({
      submittedReportSignals: 3,
      confirmedReportSignals: 1,
      submittedSignalNote: "SIGNAL_NOT_ADIJUDICATED_FACT",
      confirmedSignalNote: "CONFIRMED_AFTER_REVIEW",
    });
    // GLOBAL 视图可见全部 membership / 全部 risk states
    expect(snapshot.membership).toEqual({
      activeCampusIds: ["campus-a"],
      statuses: ["ACTIVE", "LEFT"],
    });
    expect(snapshot.risk.states).toHaveLength(2);
    expect(snapshot.risk.activeRestrictions).toEqual(["GLOBAL"]);
  });

  it("campus view returns campus-local minimization only（Repair 2 Blocker A）", async () => {
    // USER_ROW: memberships = campus-a ACTIVE + campus-b LEFT
    riskFlagCount.mockImplementation(
      async ({ where }: { where: { kind: string; campusId?: string | null } }) => {
        // campus 过滤下只应查询 campus-a 的信号
        expect(where.campusId).toBe("campus-a");
        return where.kind === "REPORT_SUBMITTED" ? 2 : 0;
      },
    );
    riskStateFindMany.mockResolvedValue([
      { state: "WATCH", reasonCode: "MANUAL_REVIEW" },
    ]);

    const snapshot = await getInternalTrustSnapshot({
      actorId: "actor-1",
      targetUserId: "user-1",
      campusId: "campus-a",
    });

    expect(snapshot?.view).toBe("CAMPUS");
    if (snapshot?.view === "CAMPUS") {
      expect(snapshot.membership).toEqual({ status: "ACTIVE" });
      expect(snapshot.risk).toEqual({ state: "WATCH", reasonCode: "MANUAL_REVIEW" });
      expect(snapshot.reportSignals.submittedReportSignals).toBe(2);
      expect(snapshot.reportSignals.confirmedReportSignals).toBe(0);
    }
    const json = JSON.stringify(snapshot);
    // 不得出现其他 campus / 全平台聚合
    expect(json).not.toContain("campus-b");
    expect(json).not.toContain("activeCampusIds");
    expect(json).not.toContain("FRAUD_CONFIRMED");
  });

  it("campus risk query is scoped to the campus row only", async () => {
    await getInternalTrustSnapshot({
      actorId: "actor-1",
      targetUserId: "user-1",
      campusId: "campus-a",
    });

    expect(riskStateFindMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        scopeKey: "CAMPUS:campus-a",
      },
      select: { state: true, reasonCode: true },
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
