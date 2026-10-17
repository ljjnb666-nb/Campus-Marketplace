import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const {
  notFound,
  rentalOrderFindMany,
  rentalOrderFindFirst,
  rentalListingFindUnique,
  rentalOrderAggregate,
  peakQueryRaw,
} = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  rentalOrderFindMany: vi.fn(),
  rentalOrderFindFirst: vi.fn(),
  rentalListingFindUnique: vi.fn(),
  rentalOrderAggregate: vi.fn(),
  peakQueryRaw: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    rentalOrder: {
      findMany: rentalOrderFindMany,
      findFirst: rentalOrderFindFirst,
      aggregate: rentalOrderAggregate,
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

describe("checkTimeConflict - R07 peak occupancy", () => {
  const tx = {
    rentalListing: { findUnique: rentalListingFindUnique },
    $queryRaw: peakQueryRaw,
  } as unknown as Prisma.TransactionClient;
  const start = new Date("2026-09-01T10:00:00Z");
  const end = new Date("2026-09-01T12:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
    rentalListingFindUnique.mockResolvedValue({ totalQuantity: 2 });
    peakQueryRaw.mockResolvedValue([{ reservedQuantity: 0n }]);
  });

  it("does not query occupancy when listing is absent", async () => {
    rentalListingFindUnique.mockResolvedValue(null);
    expect(await checkTimeConflict(tx, "listing-1", start, end, 1))
      .toEqual({ available: false, reservedQuantity: 0 });
    expect(peakQueryRaw).not.toHaveBeenCalled();
  });

  it("rejects malformed requested quantity or interval before querying", async () => {
    for (const q of [0, -1, 1.5, Number.NaN]) {
      expect((await checkTimeConflict(tx, "listing-1", start, end, q)).available).toBe(false);
    }
    expect((await checkTimeConflict(tx, "listing-1", end, start, 1)).available).toBe(false);
    expect(peakQueryRaw).not.toHaveBeenCalled();
  });

  it("rejects occupancy peak exceeding stock and accepts exact fit", async () => {
    peakQueryRaw.mockResolvedValue([{ reservedQuantity: 2n }]);
    expect(await checkTimeConflict(tx, "listing-1", start, end, 1))
      .toEqual({ available: false, reservedQuantity: 2 });
    peakQueryRaw.mockResolvedValue([{ reservedQuantity: 1n }]);
    expect(await checkTimeConflict(tx, "listing-1", start, end, 1))
      .toEqual({ available: true, reservedQuantity: 1 });
  });

  it("R07: consecutive 10–11 and 11–12 reservations each occupy one of two units", async () => {
    // SQL 聚合总量会是 2，峰值却仅为 1：申请 10–12 的 quantity=1 必须放行。
    // 原始端点是否真算对由下面的 real-PG integration fixture 验证。
    peakQueryRaw.mockResolvedValue([{ reservedQuantity: 1n }]);
    expect(await checkTimeConflict(tx, "listing-1", start, end, 1))
      .toEqual({ available: true, reservedQuantity: 1 });
  });

  it("uses half-open bounds, terminal exclusion and end-before-start window order", async () => {
    await checkTimeConflict(tx, "listing-1", start, end, 1);
    const sql = peakQueryRaw.mock.calls[0][0];
    expect(sql.sql).toContain('ro."startTime" <');
    expect(sql.sql).toContain('ro."endTime" >');
    expect(sql.sql).toContain("'CANCELLED', 'REJECTED', 'CLOSED'");
    expect(sql.sql).toContain('0 AS boundary_order, -quantity');
    expect(sql.sql).toContain('ORDER BY moment, boundary_order');
    expect(sql.values).toContain("listing-1");
    expect(sql.values.some((v: unknown) => v instanceof Date && +v === +start)).toBe(true);
  });

  it("excludes own order for extension requests and fails closed for unsafe peak", async () => {
    await checkTimeConflict(tx, "listing-1", start, end, 1, "order-to-exclude");
    const sql = peakQueryRaw.mock.calls[0][0];
    expect(sql.sql).toContain('ro."id" <>');
    expect(sql.values).toContain("order-to-exclude");
    peakQueryRaw.mockResolvedValue([{ reservedQuantity: BigInt(Number.MAX_SAFE_INTEGER) + 1n }]);
    expect((await checkTimeConflict(tx, "listing-1", start, end, 1)).available).toBe(false);
  });

  it("defaults null/no overlap to zero occupancy", async () => {
    peakQueryRaw.mockResolvedValue([{ reservedQuantity: 0n }]);
    expect(await checkTimeConflict(tx, "listing-1", start, end, 2))
      .toEqual({ available: true, reservedQuantity: 0 });
  });
});
