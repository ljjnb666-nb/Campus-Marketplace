import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const {
  notFound,
  rentalOrderFindMany,
  rentalOrderFindFirst,
  rentalListingFindUnique,
  rentalOrderAggregate,
} = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  rentalOrderFindMany: vi.fn(),
  rentalOrderFindFirst: vi.fn(),
  rentalListingFindUnique: vi.fn(),
  rentalOrderAggregate: vi.fn(),
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

describe("checkTimeConflict", () => {
  const tx = {
    rentalListing: { findUnique: rentalListingFindUnique },
    rentalOrder: { aggregate: rentalOrderAggregate },
  } as unknown as Prisma.TransactionClient;
  const start = new Date("2026-09-01T10:00:00Z");
  const end = new Date("2026-09-03T10:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockReservedQuantity(reserved: number | null, totalQuantity: number) {
    rentalListingFindUnique.mockResolvedValue({ totalQuantity });
    rentalOrderAggregate.mockResolvedValue({ _sum: { quantity: reserved } });
  }

  it("reports unavailable when the listing no longer exists", async () => {
    rentalListingFindUnique.mockResolvedValue(null);

    const result = await checkTimeConflict(tx, "listing-1", start, end, 1);

    expect(result).toEqual({ available: false, reservedQuantity: 0 });
    expect(rentalOrderAggregate).not.toHaveBeenCalled();
  });

  it("aggregates overlapping quantities via _sum on quantity", async () => {
    mockReservedQuantity(0, 3);

    await checkTimeConflict(tx, "listing-1", start, end, 1);

    const args = rentalOrderAggregate.mock.calls[0][0];
    expect(args.where.rentalListingId).toBe("listing-1");
    expect(args._sum).toEqual({ quantity: true });
    expect(args.where.status.notIn).toEqual(["CANCELLED", "REJECTED", "CLOSED"]);
    expect(args.where.AND).toEqual([
      { startTime: { lt: end } },
      { endTime: { gt: start } },
    ]);
  });

  // TEST 1 — RB-02 原始确定性回归：total=3、已有 quantity=3、请求 1。
  // 旧 count 模型：1+1<=3 误判可租；SUM 模型：3+1>3 必须拒绝。
  it("TEST 1: rejects when a single existing order already reserves the full quantity", async () => {
    mockReservedQuantity(3, 3);

    const result = await checkTimeConflict(tx, "listing-1", start, end, 1);

    expect(result).toEqual({ available: false, reservedQuantity: 3 });
  });

  // TEST 2 — 审计原始场景：total=3、已有 quantity=2、请求 2（旧模型 1+2<=3 误判）。
  it("TEST 2: rejects when reserved plus requested exceeds capacity (2+2>3)", async () => {
    mockReservedQuantity(2, 3);

    const result = await checkTimeConflict(tx, "listing-1", start, end, 2);

    expect(result).toEqual({ available: false, reservedQuantity: 2 });
  });

  // TEST 3 — 恰好装满：total=3、已订 1、请求 2 => true
  it("TEST 3: accepts an exact fit (1+2=3)", async () => {
    mockReservedQuantity(1, 3);

    const result = await checkTimeConflict(tx, "listing-1", start, end, 2);

    expect(result).toEqual({ available: true, reservedQuantity: 1 });
  });

  // TEST 4 — 多订单重叠：total=5、两条各 quantity=2（合计 4）、请求 2 => false
  it("TEST 4: rejects when multiple overlapping orders exceed capacity (4+2>5)", async () => {
    mockReservedQuantity(4, 5);

    const result = await checkTimeConflict(tx, "listing-1", start, end, 2);

    expect(result).toEqual({ available: false, reservedQuantity: 4 });
  });

  // TEST 5 — 多订单恰好装满：total=5、已订 2+1=3、请求 2 => true
  it("TEST 5: accepts when multiple overlapping orders exactly fit (3+2=5)", async () => {
    mockReservedQuantity(3, 5);

    const result = await checkTimeConflict(tx, "listing-1", start, end, 2);

    expect(result).toEqual({ available: true, reservedQuantity: 3 });
  });

  // TEST 6 — 首尾相接不算重叠：既有 09:00-10:00、请求 10:00-11:00。
  // 严格不等号（lt/gt）保证 [end A] == [start B] 不匹配，保留既有语义。
  it("TEST 6: keeps strict interval bounds so back-to-back intervals do not conflict", async () => {
    // 既有订单 09:00-10:00（quantity=3），其结束时刻 == 请求开始时刻
    const requestedStart = new Date("2026-09-01T10:00:00Z");
    const requestedEnd = new Date("2026-09-01T11:00:00Z");
    mockReservedQuantity(0, 3);

    const result = await checkTimeConflict(tx, "listing-1", requestedStart, requestedEnd, 3);

    expect(result).toEqual({ available: true, reservedQuantity: 0 });
    const and = rentalOrderAggregate.mock.calls[0][0].where.AND;
    // 既有订单必须满足 endTime > 请求开始 才重叠：首尾相接（==）不满足 gt
    expect(and).toContainEqual({ endTime: { gt: requestedStart } });
    expect(and).toContainEqual({ startTime: { lt: requestedEnd } });
  });

  // TEST 7 — 终态不占容量：CANCELLED/REJECTED/CLOSED 的 quantity 不得进入 SUM
  it("TEST 7: excludes only terminal statuses from the reserved quantity", async () => {
    mockReservedQuantity(0, 3);

    await checkTimeConflict(tx, "listing-1", start, end, 1);

    const notIn = rentalOrderAggregate.mock.calls[0][0].where.status.notIn;
    expect(notIn).toEqual(["CANCELLED", "REJECTED", "CLOSED"]);
  });

  // TEST 8 — 其余全部活跃状态占容量：notIn 恰为三个终态，即
  // PENDING_APPROVAL/PENDING_PAYMENT/PENDING_PICKUP/PICKED_UP/IN_RENTAL/
  // PENDING_RETURN/PENDING_INSPECTION/COMPLETED/OVERDUE/IN_DISPUTE 均计入
  // （状态全集见 schema RentalOrderStatus；行为级覆盖见集成测试）。
  it("TEST 8: counts every non-terminal status toward capacity", async () => {
    const activeStatuses = [
      "PENDING_APPROVAL",
      "PENDING_PAYMENT",
      "PENDING_PICKUP",
      "PICKED_UP",
      "IN_RENTAL",
      "PENDING_RETURN",
      "PENDING_INSPECTION",
      "COMPLETED",
      "OVERDUE",
      "IN_DISPUTE",
    ] as const;
    mockReservedQuantity(activeStatuses.length, 10);

    const result = await checkTimeConflict(tx, "listing-1", start, end, 1);

    // 10 个活跃状态各占 1 个容量：10+1 > 10
    expect(result).toEqual({ available: false, reservedQuantity: 10 });
    const notIn = rentalOrderAggregate.mock.calls[0][0].where.status.notIn;
    for (const status of activeStatuses) {
      expect(notIn).not.toContain(status);
    }
  });

  // TEST 9 — excludeOrderId：编辑/续租时不得把自己重复计入
  it("TEST 9: excludes the given order id from the reserved quantity", async () => {
    mockReservedQuantity(1, 3);

    const result = await checkTimeConflict(tx, "listing-1", start, end, 2, "order-to-exclude");

    expect(result).toEqual({ available: true, reservedQuantity: 1 });
    expect(rentalOrderAggregate.mock.calls[0][0].where.id).toEqual({
      not: "order-to-exclude",
    });
  });

  it("does not filter by id when no order is excluded", async () => {
    mockReservedQuantity(0, 3);

    await checkTimeConflict(tx, "listing-1", start, end, 1);

    expect(rentalOrderAggregate.mock.calls[0][0].where.id).toBeUndefined();
  });

  // TEST 10 — 无重叠行时 Prisma 返回 _sum.quantity = null，必须归零而非 NaN/null 运算
  it("TEST 10: normalizes a null _sum to zero reserved quantity", async () => {
    mockReservedQuantity(null, 3);

    const result = await checkTimeConflict(tx, "listing-1", start, end, 3);

    expect(result).toEqual({ available: true, reservedQuantity: 0 });
    expect(Number.isFinite(result.reservedQuantity)).toBe(true);
  });
});
