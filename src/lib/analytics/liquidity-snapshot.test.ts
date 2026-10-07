import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  productCount: vi.fn(),
  serviceCount: vi.fn(),
  rentalCount: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: { count: mocks.productCount },
    serviceListing: { count: mocks.serviceCount },
    rentalListing: { count: mocks.rentalCount },
  },
}));

import { getActiveSupplySnapshot } from "@/lib/analytics/liquidity-snapshot";

describe("Phase 10C-1 active supply snapshot", () => {
  beforeEach(() => {
    mocks.productCount.mockReset().mockResolvedValue(2);
    mocks.serviceCount.mockReset().mockResolvedValue(3);
    mocks.rentalCount.mockReset().mockResolvedValue(4);
  });

  it("P10C1-SNAPSHOT-01: current PUBLIC supply is campus/exposure/moderation scoped", async () => {
    const now = new Date("2026-10-07T08:00:00.000Z");
    await expect(getActiveSupplySnapshot("campus-1", { now })).resolves.toEqual({
      campusId: "campus-1",
      capturedAt: now,
      authority: "DOMAIN_CURRENT_STATE",
      productListings: 2,
      serviceListings: 3,
      rentalListings: 4,
      totalListings: 9,
    });
    const moderation = { moderations: { none: { resolvedAt: null } } };
    expect(mocks.productCount).toHaveBeenCalledWith({
      where: { campusId: "campus-1", deletedAt: null, status: "ACTIVE", ...moderation },
    });
    expect(mocks.serviceCount).toHaveBeenCalledWith({
      where: { campusId: "campus-1", deletedAt: null, status: "ACTIVE", ...moderation },
    });
    expect(mocks.rentalCount).toHaveBeenCalledWith({
      where: {
        campusId: "campus-1",
        deletedAt: null,
        status: "AVAILABLE",
        availableQuantity: { gt: 0 },
        ...moderation,
      },
    });
  });

  it("P10C1-SNAPSHOT-02: campus scope is mandatory", async () => {
    await expect(getActiveSupplySnapshot("")).rejects.toThrow("LIQUIDITY_CAMPUS_ID_REQUIRED");
  });
});
