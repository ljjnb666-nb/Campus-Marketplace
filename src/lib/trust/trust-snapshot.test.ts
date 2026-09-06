import { beforeEach, describe, expect, it, vi } from "vitest";

const { userFindUnique, reportCount, membershipFindMany } = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  reportCount: vi.fn(),
  membershipFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    report: { count: reportCount },
    campusMembership: { findMany: membershipFindMany },
  },
}));

import { getTrustSnapshot } from "@/lib/trust/trust-snapshot";

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

beforeEach(() => {
  userFindUnique.mockReset().mockResolvedValue({ ...USER_ROW });
  reportCount.mockReset().mockResolvedValue(0);
  membershipFindMany.mockReset().mockResolvedValue([]);
});

describe("getTrustSnapshot（中央 trust 快照，只读既有事实）", () => {
  it("aggregates existing signals without inventing scores", async () => {
    reportCount.mockResolvedValueOnce(2).mockResolvedValueOnce(5);

    const snapshot = await getTrustSnapshot("user-1");

    expect(snapshot).toMatchObject({
      userId: "user-1",
      verification: { status: "VERIFIED" },
      membership: { activeCampusIds: ["campus-a"], statuses: ["ACTIVE", "LEFT"] },
      transactionHistory: { completedOrdersCount: 12 },
      reviewSignals: { positiveReviewRate: 0.95, receivedReviewsCount: 7 },
      rentalSignals: { rentalDisputeCount: 1, onTimeReturnRate: 0.9 },
      reportSignals: {
        openReportCount: 2,
        resolvedReportCount: 5,
        signalNote: "SIGNAL_NOT_ADIJUDICATED_FACT",
      },
      legacyCreditScore: { value: 100, policy: "LEGACY_DISPLAY_SIGNAL" },
    });
    // 无综合评分字段（NO_OPAQUE_SCORING）
    expect(snapshot && "riskScore" in snapshot).toBe(false);
    expect(snapshot && "trustScore" in snapshot).toBe(false);
  });

  it("hides risk data unless includeRisk is set（#39 admin-only）", async () => {
    const withoutRisk = await getTrustSnapshot("user-1");
    expect(withoutRisk?.risk).toBeUndefined();

    const { getRiskStateRows } = await import("@/lib/enforcement/risk-service");
    const rowsSpy = vi.spyOn(await import("@/lib/enforcement/risk-service"), "getRiskStateRows");
    // getRiskStateRows 在 includeRisk 下经 prisma 路径读取 riskState
    const prismaModule = await import("@/lib/prisma");
    (prismaModule.prisma as unknown as Record<string, unknown>).riskState = {
      findMany: vi.fn().mockResolvedValue([
        { scopeKey: "GLOBAL", campusId: null, state: "RESTRICTED", reasonCode: "FRAUD_CONFIRMED" },
      ]),
    };
    void rowsSpy;

    const withRisk = await getTrustSnapshot("user-1", { includeRisk: true });

    expect(withRisk?.risk?.activeRestrictions).toEqual(["GLOBAL"]);
    expect(withRisk?.risk?.states[0]).toMatchObject({ state: "RESTRICTED" });
    void getRiskStateRows;
  });

  it("returns null for unknown users", async () => {
    userFindUnique.mockResolvedValue(null);

    await expect(getTrustSnapshot("ghost")).resolves.toBeNull();
  });
});
