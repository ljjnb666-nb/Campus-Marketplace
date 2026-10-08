import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadAuthorizationContext: vi.fn(), campusFind: vi.fn(), groupBy: vi.fn(), snapshot: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  campus: { findUnique: mocks.campusFind },
  metricContribution: { groupBy: mocks.groupBy },
}}));
vi.mock("@/lib/rbac/service", () => ({ loadAuthorizationContext: mocks.loadAuthorizationContext }));
vi.mock("@/lib/analytics/liquidity-snapshot", () => ({ getActiveSupplySnapshot: mocks.snapshot }));

import { loadAuthorizedAnalyticsOverview } from "@/lib/analytics/analytics-overview-query";

const now = new Date("2026-10-08T12:00:00.000Z");
function authorize(scope: "GLOBAL" | "CAMPUS" = "CAMPUS", activeCampusIds = ["A"]) {
  mocks.loadAuthorizationContext.mockResolvedValue({
    userId: "op", accountActive: true, activeCampusIds,
    grants: [{ scope, roleKey: "ANALYTICS", campusId: scope === "GLOBAL" ? null : "A", permissionKeys: ["analytics.read"] }],
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.campusFind.mockResolvedValue({ id: "A", name: "校区甲" });
  mocks.groupBy.mockResolvedValue([]);
  mocks.snapshot.mockImplementation(async (id: string) => ({
    campusId: id, capturedAt: now, authority: "DOMAIN_CURRENT_STATE",
    productListings: 2, serviceListings: 3, rentalListings: 1, totalListings: 6,
  }));
});

describe("10J authoritative analytics overview read", () => {
  it("fresh actor RBAC rejects wrong campus or inactive membership before ANY database query", async () => {
    authorize("CAMPUS", []);
    await expect(loadAuthorizedAnalyticsOverview({
      actorId: "op", campusId: "A", periodDays: 7,
    })).rejects.toThrow("ANALYTICS_SCOPE_DENIED");
    authorize("CAMPUS", ["A"]);
    await expect(loadAuthorizedAnalyticsOverview({
      actorId: "op", campusId: "B", periodDays: 7,
    })).rejects.toThrow("ANALYTICS_SCOPE_DENIED");
    expect(mocks.campusFind).not.toHaveBeenCalled();
    expect(mocks.groupBy).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it("SQL predicates pin one campus, exact current projection & metric versions and event window", async () => {
    authorize();
    mocks.groupBy.mockResolvedValue([
      { metricKey: "NEW_LISTING_COUNT", metricVersion: 1, dimensionKey: "LISTING_TYPE:PRODUCT", _sum: { value: new Prisma.Decimal(2) } },
      { metricKey: "COMPLETED_TRANSACTION_COUNT", metricVersion: 2, dimensionKey: "TRANSACTION_TYPE:RENTAL", _sum: { value: new Prisma.Decimal(1) } },
      { metricKey: "COMPLETED_TRANSACTION_VALUE", metricVersion: 1, dimensionKey: "TRANSACTION_TYPE:RENTAL", _sum: { value: new Prisma.Decimal("35.50") } },
    ]);
    const result = await loadAuthorizedAnalyticsOverview({
      actorId: "op", campusId: "A", periodDays: 7, now,
    });
    expect(mocks.loadAuthorizationContext).toHaveBeenCalledWith("op");
    expect(mocks.groupBy).toHaveBeenCalledWith({
      by: ["metricKey", "metricVersion", "dimensionKey"],
      where: {
        projectionKey: "ANALYTICS_METRIC_CONTRIBUTIONS", projectionVersion: 3,
        campusId: "A",
        occurredAt: { gte: new Date("2026-10-01T12:00:00.000Z"), lte: now },
        OR: [
          { metricKey: "NEW_LISTING_COUNT", metricVersion: 1 },
          { metricKey: "DEMAND_CREATED_COUNT", metricVersion: 1 },
          { metricKey: "COMPLETED_TRANSACTION_COUNT", metricVersion: 2 },
          { metricKey: "COMPLETED_TRANSACTION_VALUE", metricVersion: 1 },
        ],
      },
      _sum: { value: true },
    });
    expect(result.currentSupply).toMatchObject({ product: 2, service: 3, rental: 1, total: 6 });
    expect(result.metrics.map(row => row.total)).toEqual(["2", "0", "1", "35.50"]);
    expect(result.metrics[2]?.dimensions[0]).toEqual({ label: "物品租赁", value: "1" });
  });

  it("keeps large Decimal amounts as strings (never floating-point) and zeroes absent facts", async () => {
    authorize("GLOBAL", []);
    mocks.groupBy.mockResolvedValue([
      { metricKey: "COMPLETED_TRANSACTION_VALUE", metricVersion: 1, dimensionKey: "TRANSACTION_TYPE:PRODUCT", _sum: { value: new Prisma.Decimal("9007199254740993.12") } },
    ]);
    const result = await loadAuthorizedAnalyticsOverview({
      actorId: "op", campusId: "A", periodDays: 30, now,
    });
    expect(result.metrics[3]?.total).toBe("9007199254740993.12");
    expect(result.metrics[1]?.total).toBe("0");
  });

  it("denies invalid periods and nonexistent campuses before reading metric data", async () => {
    authorize();
    await expect(loadAuthorizedAnalyticsOverview({
      actorId: "op", campusId: "A", periodDays: 60 as 7,
    })).rejects.toThrow("ANALYTICS_SCOPE_OR_PERIOD_INVALID");
    mocks.campusFind.mockResolvedValueOnce(null);
    await expect(loadAuthorizedAnalyticsOverview({
      actorId: "op", campusId: "A", periodDays: 7,
    })).rejects.toThrow("ANALYTICS_CAMPUS_NOT_FOUND");
    expect(mocks.groupBy).not.toHaveBeenCalled();
  });
});
