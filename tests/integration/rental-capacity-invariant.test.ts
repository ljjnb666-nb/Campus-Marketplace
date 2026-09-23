import { randomUUID } from "node:crypto";
import { waitForAdvisoryLockWaiter } from "./helpers/lock-barrier";
import { PrismaClient, type Prisma, type RentalOrderStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * RB-02 Rental Capacity Invariant 集成测试（真实 PostgreSQL）。
 *
 * 修复前 checkTimeConflict 以"重叠订单条数"近似容量，quantity>1 即可超卖。
 * 本文件在生产创建路径（createRentalOrderTx：participant advisory 锁 →
 * RentalListing FOR UPDATE → 锁内复查 → SUM(quantity) 容量复算 → 写入）上证明：
 *
 *  - CONC-1 确定性 barrier：订单 A（quantity=2）持锁挂起于 domainRacePoint
 *    seam → 订单 B（quantity=2，totalQuantity=3）真实进入 advisory 锁等待
 *    队列（pg_locks barrier，零 sleep）→ release A 提交 → B 锁内以
 *    SUM(quantity) 复算（reserved=2，2+2>3）→ 业务拒绝。
 *    最终 SUCCESS_COUNT=1 / FAILURE_COUNT=1，无超卖、无 40P01、无部分写入。
 *  - CONC-2 同时起跑（Promise.all）：恰好一成一败（顺序无关），失败必须是
 *    业务容量错误而非数据库异常。
 *  - STATUS 状态语义行为级：10 个活跃状态各 quantity=5 全部计入 reserved；
 *    CANCELLED/REJECTED/CLOSED 各 quantity=50 不计入；首尾相接不算重叠；
 *    excludeOrderId 精确排除自身；无重叠时 reserved 归零。
 */

// 竞态 barrier + Prisma 交互事务（默认 10s）需要超过默认 5s 的测试预算
vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const prisma = integrationDatabaseUrl ? (await import("@/lib/prisma")).prisma : null;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `rb02it-${randomUUID().slice(0, 8)}`;
// 校区按稳定 slug 复用且 teardown 不删除：本文件生命周期极短（~3s），
// 若在 afterAll 删除 Campus 行，恰好落在 phase7h CA02 等全局 campus.count()
// 断言的快照窗口内（实测 2/2 触发 235↔236 干扰失败），故仅复用不增删。
const RB02_CAMPUS_SLUG = "rb02-it-campus";
let campusId = "";
let categoryId = "";
const userIds: string[] = [];
const listingIds: string[] = [];
let orderNumberSeq = 0;

// 占容量的全部活跃状态（schema RentalOrderStatus 全集 13 值去掉三个终态）
const ACTIVE_STATUSES = [
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
const TERMINAL_STATUSES = ["CANCELLED", "REJECTED", "CLOSED"] as const;

describe.skipIf(!integrationDatabaseUrl)("rental capacity invariant (RB-02, real PostgreSQL)", () => {
  let owner: { id: string };
  let renterA: { id: string };
  let renterB: { id: string };

  async function createFixtureUser(name: string) {
    const user = await rawClient!.user.create({
      data: {
        email: `${RUN_TAG}-${userIds.length}@it.local`,
        name,
        passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
        schoolName: "集成测试大学",
        campusId,
        role: "STUDENT",
        status: "ACTIVE",
      },
    });
    userIds.push(user.id);
    await rawClient!.campusMembership.create({
      data: { userId: user.id, campusId, status: "ACTIVE" },
    });
    return user;
  }

  async function createFixtureListing(totalQuantity: number) {
    const listing = await rawClient!.rentalListing.create({
      data: {
        title: `RB02 租赁 ${randomUUID().slice(0, 6)}`,
        description: "RB-02 容量不变量集成测试",
        condition: "NEW",
        price: "20.00",
        pricingUnit: "PER_DAY",
        depositAmount: "50.00",
        minimumDuration: 1,
        maximumDuration: 30,
        totalQuantity,
        availableQuantity: totalQuantity,
        pickupLocation: "南门",
        returnLocation: "南门",
        status: "AVAILABLE",
        ownerId: owner.id,
        campusId,
        categoryId,
      },
    });
    listingIds.push(listing.id);
    return listing;
  }

  function nextOrderNumber() {
    orderNumberSeq += 1;
    return `${RUN_TAG}-${orderNumberSeq}`;
  }

  function orderRow(input: {
    listingId: string;
    renterId: string;
    status: RentalOrderStatus;
    quantity: number;
    startTime: Date;
    endTime: Date;
  }) {
    return {
      orderNumber: nextOrderNumber(),
      rentalListingId: input.listingId,
      ownerId: owner.id,
      renterId: input.renterId,
      startTime: input.startTime,
      endTime: input.endTime,
      quantity: input.quantity,
      unitPriceSnapshot: "20.00",
      pricingUnitSnapshot: "PER_DAY",
      rentalDuration: 1,
      rentalAmount: "20.00",
      depositAmount: "50.00",
      finalAmount: "70.00",
      paymentStatus: "OFFLINE_PENDING",
      depositStatus: "NOT_REQUIRED",
      status: input.status,
      pickupLocationSnapshot: "南门",
      returnLocationSnapshot: "南门",
    } satisfies Prisma.RentalOrderUncheckedCreateInput;
  }

  beforeAll(async () => {
    const campus = await rawClient!.campus.upsert({
      where: { slug: RB02_CAMPUS_SLUG },
      create: { name: "RB02 集成测试校区", slug: RB02_CAMPUS_SLUG, schoolName: "集成测试大学" },
      update: {},
    });
    campusId = campus.id;
    const category = await rawClient!.rentalCategory.create({
      data: { name: `RB02类目-${RUN_TAG}`, slug: RUN_TAG },
    });
    categoryId = category.id;
    owner = await createFixtureUser("RB02 出租者");
    renterA = await createFixtureUser("RB02 租客A");
    renterB = await createFixtureUser("RB02 租客B");
  });

  afterAll(async () => {
    await rawClient!.rentalOrder.deleteMany({ where: { rentalListingId: { in: listingIds } } });
    await rawClient!.rentalListing.deleteMany({ where: { id: { in: listingIds } } });
    await rawClient!.rentalCategory.deleteMany({ where: { id: categoryId } });
    await rawClient!.notification.deleteMany({ where: { userId: { in: userIds } } });
    await rawClient!.campusMembership.deleteMany({ where: { userId: { in: userIds } } });
    await rawClient!.user.deleteMany({ where: { id: { in: userIds } } });
    // 注意：不删除 Campus 行（稳定 slug 复用，见 RB02_CAMPUS_SLUG 注释）
    await rawClient!.$disconnect();
    await prisma?.$disconnect();
  });

  function assertSingleCommittedOrder(listingId: string, expectedQuantity: number) {
    return async () => {
      const orders = await rawClient!.rentalOrder.findMany({ where: { rentalListingId: listingId } });
      expect(orders).toHaveLength(1);
      expect(orders[0].quantity).toBe(expectedQuantity);
      expect(orders[0].status).toBe("PENDING_APPROVAL");
      // 无部分写入：状态日志与通知与订单一一对应
      const logCount = await rawClient!.rentalOrderStatusLog.count({ where: { orderId: orders[0].id } });
      expect(logCount).toBe(1);
      // 容量不变量终态：重叠活跃订单 quantity 总和 ≤ totalQuantity=3 → 无超卖
      const reservedQuantity = orders.reduce((sum, order) => sum + order.quantity, 0);
      expect(reservedQuantity).toBeLessThanOrEqual(3);
      const listing = await rawClient!.rentalListing.findUniqueOrThrow({ where: { id: listingId } });
      expect(listing.status).toBe("AVAILABLE");
    };
  }

  it("CONC-1 确定性 barrier：持锁挂起的 A 提交后，B 以 SUM(quantity) 复算并业务拒绝", async () => {
    const { createRentalOrderTx } = await import("@/lib/rental-order-machine");
    const { withTransaction } = await import("@/lib/prisma");
    const listing = await createFixtureListing(3);
    const interval = {
      startTime: new Date(Date.now() + 24 * 3600_000),
      endTime: new Date(Date.now() + 48 * 3600_000),
    };

    // A：进入临界区（advisory 锁 + RentalListing FOR UPDATE + 锁内复查完成）
    // 后挂起在 domainRacePoint seam（生产不传，仅测试注入）
    let signalALocked!: () => void;
    const aLocked = new Promise<void>((resolve) => {
      signalALocked = resolve;
    });
    let releaseA!: () => void;
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const promiseA = withTransaction((tx: Prisma.TransactionClient) =>
      createRentalOrderTx(
        tx,
        { userId: renterA.id, rentalListingId: listing.id, ...interval, quantity: 2 },
        undefined,
        async () => {
          signalALocked();
          await aGate;
        },
      ),
    );
    await aLocked;

    // B：与 A 完全重叠、quantity=2。A 已持 USER:owner subject 锁 → B 进入等待队列
    const promiseB = withTransaction((tx: Prisma.TransactionClient) =>
      createRentalOrderTx(tx, { userId: renterB.id, rentalListingId: listing.id, ...interval, quantity: 2 }),
    ).catch((e: unknown) => e);
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${owner.id}`, `USER:${renterB.id}`]);

    releaseA();
    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

    // 恰好一成一败；败者是业务容量错误对象，而非抛出的数据库异常
    expect(resultA).toMatchObject({ orderId: expect.any(String) });
    expect(resultB).toEqual({ error: "该时间段已被预订，库存不足" });

    await assertSingleCommittedOrder(listing.id, 2)();
  });

  it("CONC-2 同时起跑：双 quantity=2 请求恰好一成一败，终态无超卖", async () => {
    const { createRentalOrderTx } = await import("@/lib/rental-order-machine");
    const { withTransaction } = await import("@/lib/prisma");
    const listing = await createFixtureListing(3);
    const interval = {
      startTime: new Date(Date.now() + 72 * 3600_000),
      endTime: new Date(Date.now() + 96 * 3600_000),
    };

    type AttemptOutcome =
      | { kind: "success"; orderId: string }
      | { kind: "business-error"; error: string }
      | { kind: "thrown"; error: unknown };

    const attempt = async (renterId: string): Promise<AttemptOutcome> => {
      try {
        const result = await withTransaction((tx: Prisma.TransactionClient) =>
          createRentalOrderTx(tx, { userId: renterId, rentalListingId: listing.id, ...interval, quantity: 2 }),
        );
        if ("orderId" in result) return { kind: "success", orderId: result.orderId };
        return { kind: "business-error", error: result.error };
      } catch (error) {
        return { kind: "thrown", error };
      }
    };

    const outcomes = await Promise.all([attempt(renterA.id), attempt(renterB.id)]);

    // 两个事务都不允许抛数据库异常（40P01 deadlock / P2034 串行化冲突 / 500）
    expect(outcomes.filter((o) => o.kind === "thrown")).toEqual([]);
    const successes = outcomes.filter((o) => o.kind === "success");
    const businessFailures = outcomes.filter((o) => o.kind === "business-error");

    expect(successes).toHaveLength(1);
    expect(businessFailures).toEqual([
      { kind: "business-error", error: "该时间段已被预订，库存不足" },
    ]);

    await assertSingleCommittedOrder(listing.id, 2)();
  });

  it("STATUS 状态语义行为级：活跃状态计入 SUM、终态与首尾相接排除、excludeOrderId、零重叠归零", async () => {
    const { checkTimeConflict } = await import("@/repositories/rental-order-repository");
    const { withTransaction } = await import("@/lib/prisma");
    const listing = await createFixtureListing(100);
    const dayStart = new Date("2026-10-01T00:00:00Z");
    const reqStart = new Date("2026-10-01T09:00:00Z");
    const reqEnd = new Date("2026-10-01T18:00:00Z");

    // 10 个活跃状态各 quantity=5，全部与请求区间重叠
    for (const status of ACTIVE_STATUSES) {
      await rawClient!.rentalOrder.create({
        data: orderRow({ listingId: listing.id, renterId: renterA.id, status, quantity: 5, startTime: reqStart, endTime: reqEnd }),
      });
    }
    // 三个终态各 quantity=50：若被错误计入，reserved ≥ 150 将使请求必拒（判定区分度）
    for (const status of TERMINAL_STATUSES) {
      await rawClient!.rentalOrder.create({
        data: orderRow({ listingId: listing.id, renterId: renterB.id, status, quantity: 50, startTime: reqStart, endTime: reqEnd }),
      });
    }
    // 首尾相接的活跃订单（00:00-09:00，quantity=30）：严格不等号下不得计入
    await rawClient!.rentalOrder.create({
      data: orderRow({ listingId: listing.id, renterId: renterB.id, status: "IN_RENTAL", quantity: 30, startTime: dayStart, endTime: reqStart }),
    });

    // reserved = 10 × 5 = 50（终态 150 与 back-to-back 30 均不计入）；50 + 5 ≤ 100
    const result = await withTransaction((tx: Prisma.TransactionClient) =>
      checkTimeConflict(tx, listing.id, reqStart, reqEnd, 5),
    );
    expect(result).toEqual({ available: true, reservedQuantity: 50 });

    // excludeOrderId：排除一条活跃订单（quantity=5）后 reserved 同步减少
    const excludedOrder = await rawClient!.rentalOrder.findFirstOrThrow({
      where: { rentalListingId: listing.id, status: "PENDING_APPROVAL" },
      orderBy: { createdAt: "asc" },
    });
    const withExclude = await withTransaction((tx: Prisma.TransactionClient) =>
      checkTimeConflict(tx, listing.id, reqStart, reqEnd, 5, excludedOrder.id),
    );
    expect(withExclude).toEqual({ available: true, reservedQuantity: 45 });

    // 无任何重叠行：_sum 为 null 必须归零，而非 NaN/null 运算
    const noOverlap = await withTransaction((tx: Prisma.TransactionClient) =>
      checkTimeConflict(tx, listing.id, new Date("2027-01-01T00:00:00Z"), new Date("2027-01-02T00:00:00Z"), 5),
    );
    expect(noOverlap).toEqual({ available: true, reservedQuantity: 0 });
  });
});
