import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const {
  notFound,
  rentalOrderFindMany,
  rentalOrderFindFirst,
  rentalListingFindUnique,
  rentalOrderCount,
} = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  rentalOrderFindMany: vi.fn(),
  rentalOrderFindFirst: vi.fn(),
  rentalListingFindUnique: vi.fn(),
  rentalOrderCount: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    rentalOrder: {
      findMany: rentalOrderFindMany,
      findFirst: rentalOrderFindFirst,
      count: rentalOrderCount,
    },
    rentalListing: { findUnique: rentalListingFindUnique },
  },
}));

import {
  checkTimeConflict,
  getMyOwnerOrders,
  getMyOwnerOrdersDetailed,
  getMyRenterOrders,
  getMyRenterOrdersDetailed,
  getRentalOrderDetail,
} from "@/repositories/rental-order-repository";

const sampleOrder = { id: "order-1", status: "ACTIVE" };

describe("my orders queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rentalOrderFindMany.mockResolvedValue([sampleOrder]);
  });

  it("getMyRenterOrders scopes by renter and caps at 100", async () => {
    const orders = await getMyRenterOrders("user-1");

    expect(orders).toEqual([sampleOrder]);
    const args = rentalOrderFindMany.mock.calls[0][0];
    expect(args.where).toEqual({ renterId: "user-1" });
    expect(args.take).toBe(100);
    expect(args.orderBy).toEqual({ createdAt: "desc" });
    expect(args.include.rentalListing).toBeDefined();
    expect(args.include.owner).toBeDefined();
  });

  it("getMyOwnerOrders scopes by owner and caps at 100", async () => {
    await getMyOwnerOrders("user-1");

    const args = rentalOrderFindMany.mock.calls[0][0];
    expect(args.where).toEqual({ ownerId: "user-1" });
    expect(args.take).toBe(100);
    expect(args.include.renter).toBeDefined();
  });

  it("getMyRenterOrdersDetailed includes counterpart summaries and reviews", async () => {
    await getMyRenterOrdersDetailed("user-1");

    const args = rentalOrderFindMany.mock.calls[0][0];
    expect(args.where).toEqual({ renterId: "user-1" });
    expect(args.include.owner.select).toEqual({
      id: true,
      name: true,
      avatarUrl: true,
      schoolName: true,
    });
    expect(args.include.reviews).toEqual({ select: { authorId: true } });
    expect(args.take).toBeUndefined();
  });

  it("getMyOwnerOrdersDetailed includes renter summaries", async () => {
    await getMyOwnerOrdersDetailed("user-1");

    const args = rentalOrderFindMany.mock.calls[0][0];
    expect(args.where).toEqual({ ownerId: "user-1" });
    expect(args.include.renter.select).toEqual({
      id: true,
      name: true,
      avatarUrl: true,
      schoolName: true,
    });
  });
});

describe("getRentalOrderDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an order visible to owner or renter with full relations", async () => {
    rentalOrderFindFirst.mockResolvedValue(sampleOrder);

    const order = await getRentalOrderDetail("order-1", "user-1");

    expect(order).toEqual(sampleOrder);
    const args = rentalOrderFindFirst.mock.calls[0][0];
    expect(args.where).toEqual({
      id: "order-1",
      OR: [{ ownerId: "user-1" }, { renterId: "user-1" }],
    });
    for (const relation of [
      "rentalListing",
      "owner",
      "renter",
      "handoverRecord",
      "returnRecord",
      "extensionRequests",
      "damageClaims",
      "disputes",
      "statusLogs",
      "reviews",
    ]) {
      expect(args.include[relation]).toBeDefined();
    }
  });

  it("throws notFound when the order is invisible to the user", async () => {
    rentalOrderFindFirst.mockResolvedValue(null);

    await expect(getRentalOrderDetail("order-1", "user-x")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });
});

describe("checkTimeConflict", () => {
  const tx = {
    rentalListing: { findUnique: rentalListingFindUnique },
    rentalOrder: { count: rentalOrderCount },
  } as unknown as Prisma.TransactionClient;
  const start = new Date("2026-09-01T10:00:00Z");
  const end = new Date("2026-09-03T10:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports unavailable when the listing no longer exists", async () => {
    rentalListingFindUnique.mockResolvedValue(null);

    const result = await checkTimeConflict(tx, "listing-1", start, end, 1);

    expect(result).toEqual({ available: false, conflictCount: 0 });
  });

  it("counts overlapping non-cancelled orders with quantity capacity", async () => {
    rentalListingFindUnique.mockResolvedValue({ totalQuantity: 2 });
    rentalOrderCount.mockResolvedValue(1);

    const result = await checkTimeConflict(tx, "listing-1", start, end, 1);

    expect(result).toEqual({ available: true, conflictCount: 1 });
    const where = rentalOrderCount.mock.calls[0][0].where;
    expect(where.rentalListingId).toBe("listing-1");
    expect(where.status.notIn).toEqual(["CANCELLED", "REJECTED", "CLOSED"]);
    expect(where.AND).toEqual([
      { startTime: { lt: end } },
      { endTime: { gt: start } },
    ]);
  });

  it("marks unavailable when requested quantity exceeds remaining capacity", async () => {
    rentalListingFindUnique.mockResolvedValue({ totalQuantity: 2 });
    rentalOrderCount.mockResolvedValue(2);

    const result = await checkTimeConflict(tx, "listing-1", start, end, 1);

    expect(result).toEqual({ available: false, conflictCount: 2 });
  });

  it("excludes a specific order from the conflict count", async () => {
    rentalListingFindUnique.mockResolvedValue({ totalQuantity: 1 });
    rentalOrderCount.mockResolvedValue(0);

    await checkTimeConflict(tx, "listing-1", start, end, 1, "order-to-exclude");

    expect(rentalOrderCount.mock.calls[0][0].where.id).toEqual({
      not: "order-to-exclude",
    });
  });
});
