import { randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { waitForAdvisoryLockWaiter } from "./helpers/lock-barrier";

// Phase 8B-01（P8-B01）Product Reservation Deadline & Synchronous Expiry
// 集成测试（真实 PostgreSQL）。
//
// 关闭的缺口：PRODUCT PENDING reservation 此前可无限持续——不存在
// reservation deadline / resolution truth / 同步过期操作，Product RESERVED
// 可能被永久占用。
//
// 修复后合同（冻结）：
//   - PRODUCT_RESERVATION_TTL = 24 HOURS（deadline = 事务捕获 now + 24h）
//   - 时间边界：now >= expiresAt = EXPIRED（accept/cancel/expire 共享判定）
//   - resolution ≠ Order status：EXPIRED 的业务结果 = Order CANCELLED +
//     productReservationResolution = EXPIRED（不新增 OrderStatus.EXPIRED）
//   - accept 超期：同一事务 materialize EXPIRED，返回非 null outcome
//     （action 必须 revalidate views，绝不发"已接单"通知）
//   - cancel 超期：deadline truth > late user intent → EXPIRED resolution
//   - explicit expire：system wind-down，无 user actor，任何账号状态都
//     不阻止关闭；capability 只影响 Product 投影目标
//   - PRODUCT ACCEPTED / CANCELLED 均委派 product-order-lifecycle 唯一权威
//   - 锁序：candidate pre-read → sorted USER buyer+seller locks →
//     Order FOR UPDATE → fresh 谓词 → Product FOR UPDATE
//   - DB 约束：pair consistency / non-product isolation / pending deadline
//
// 时钟：deadline 判定经可注入 now（fixed Date）；真实 PG race 零 sleep
// 排序（racePoint seam + pg_locks waiter barrier）。

vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p8b01-${randomUUID().slice(0, 8)}`;

const createdUserIds: string[] = [];
const createdProductIds: string[] = [];
const createdOrderIds: string[] = [];
const createdMembershipIds: string[] = [];

let campusId = "";
let productCategoryId = "";

let fixtureSeq = 0;

async function createFixtureUser(name: string, status: "ACTIVE" | "SUSPENDED" = "ACTIVE") {
  const seq = fixtureSeq++;
  const user = await rawClient!.user.create({
    data: {
      email: `${RUN_TAG}-${seq}-${name}@it.local`,
      name,
      passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
      schoolName: "集成测试大学",
      campusId,
      role: "STUDENT",
      status,
    },
  });
  createdUserIds.push(user.id);
  if (status === "ACTIVE") {
    const membership = await rawClient!.campusMembership.create({
      data: { userId: user.id, campusId, status: "ACTIVE" },
    });
    createdMembershipIds.push(membership.id);
  }
  return user;
}

async function createProductFixture(sellerId: string, status: "ACTIVE" | "RESERVED" | "SOLD" | "OFFLINE" = "ACTIVE") {
  const product = await rawClient!.product.create({
    data: {
      title: `8B01 商品 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8B-01 reservation fixture",
      price: 10,
      condition: "NEW",
      locationText: "东门",
      categoryId: productCategoryId,
      campusId,
      sellerId,
      status,
    },
  });
  createdProductIds.push(product.id);
  return product;
}

async function createOrderFixture(input: {
  buyerId: string;
  sellerId: string;
  productId: string;
  status: "PENDING" | "ACCEPTED";
  /** PENDING 必须带 deadline（DB 约束）；测试用固定值表达测试时钟。 */
  productReservationExpiresAt?: Date;
}) {
  const order = await rawClient!.order.create({
    data: {
      orderNo: `${RUN_TAG}${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
      type: "PRODUCT",
      status: input.status,
      buyerId: input.buyerId,
      sellerId: input.sellerId,
      productId: input.productId,
      amount: "10.00",
      productReservationExpiresAt:
        input.status === "PENDING"
          ? (input.productReservationExpiresAt ?? new Date(Date.now() + 60 * 60 * 1000))
          : null,
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

/** 真实 buyer 下单（createProductOrderTx 完整事务链）。 */
async function placeRealOrder(input: {
  buyerId: string;
  product: { id: string; price: string; sellerId: string; campusId: string };
  now?: Date;
}) {
  const { createProductOrderTx } = await import("@/lib/order-creation");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    createProductOrderTx(
      tx,
      {
        buyerId: input.buyerId,
        product: input.product,
        meetingLocation: "东门",
        note: null,
      },
      undefined,
      undefined,
      input.now !== undefined ? { now: input.now } : undefined,
    ),
  );
}

/** 真实订单状态流转（updateOrderStatusTx：ACCEPTED/CANCELLED/COMPLETED 委派）。 */
async function transitionOrder(
  actorId: string,
  orderId: string,
  requestedStatus: "ACCEPTED" | "CANCELLED" | "COMPLETED",
  seams?: Record<string, unknown>,
) {
  const { updateOrderStatusTx } = await import("@/lib/order-status-service");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    updateOrderStatusTx(
      tx,
      actorId,
      orderId,
      { requestedStatus },
      seams as Parameters<typeof updateOrderStatusTx>[4],
    ),
  );
}

/** canonical accept 直调（注入测试时钟 / seam）。 */
async function acceptOrder(
  sellerId: string,
  orderId: string,
  input: { buyerId: string; sellerId: string; productId: string | null },
  options?: { now?: Date },
  seams?: Record<string, unknown>,
) {
  const { acceptProductOrderTx } = await import("@/lib/product-order-lifecycle");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    acceptProductOrderTx(
      tx,
      sellerId,
      orderId,
      input,
      seams as Parameters<typeof acceptProductOrderTx>[4],
      options,
    ),
  );
}

/** canonical explicit expire 直调（注入测试时钟 / seam）。 */
async function expireReservation(
  orderId: string,
  options?: { now?: Date },
  seams?: Record<string, unknown>,
) {
  const { expireProductReservationTx } = await import("@/lib/product-order-lifecycle");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    expireProductReservationTx(
      tx,
      orderId,
      seams as Parameters<typeof expireProductReservationTx>[2],
      options,
    ),
  );
}

async function notificationCount(userId: string, title: string, orderId?: string) {
  return rawClient!.notification.count({
    where: { userId, title, ...(orderId ? { orderId } : {}) },
  });
}

/** NO_40P01：任何拒绝原因都不得是 PG deadlock / serialization failure。 */
function assertNoSerializationFailure(errors: unknown[]) {
  for (const error of errors) {
    const message = String((error as Error)?.message ?? error);
    expect(message).not.toContain("40P01");
    expect(message).not.toContain("deadlock detected");
  }
}

beforeAll(async () => {
  if (!rawClient) return;

  const campus = await rawClient.campus.upsert({
    where: { slug: `p8b01-${randomUUID().slice(0, 8)}` },
    create: { name: `8B01 预留校区 ${randomUUID().slice(0, 6)}`, slug: `p8b01-${randomUUID().slice(0, 8)}`, schoolName: "集成测试大学" },
    update: {},
  });
  campusId = campus.id;
  const category = await rawClient.productCategory.create({
    data: { name: `8B01类目-${RUN_TAG}`, slug: RUN_TAG },
  });
  productCategoryId = category.id;
});

// §70：反向 FK 顺序清理（精确 fixture ID 域；禁止 silent catch 吞 cleanup
// failure）；Campus 最后删除 + 哨兵断言 fixture campus 归零。
afterAll(async () => {
  if (!rawClient) return;

  await rawClient.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await rawClient.riskState.deleteMany({ where: { userId: { in: createdUserIds } } });
  await rawClient.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await rawClient.product.deleteMany({ where: { id: { in: createdProductIds } } });
  // RES-CREATE-02 的 ServiceListing（精确 slug 域）先于其 category 删除
  await rawClient.serviceListing.deleteMany({ where: { category: { slug: { startsWith: "p8b01-svc-" } } } });
  await rawClient.serviceCategory.deleteMany({ where: { slug: { startsWith: "p8b01-svc-" } } });
  await rawClient.productCategory.deleteMany({ where: { id: productCategoryId } });
  await rawClient.campusMembership.deleteMany({ where: { id: { in: createdMembershipIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await rawClient.campus.deleteMany({ where: { id: campusId } });

  const remainingCampus = await rawClient.campus.count({
    where: { id: campusId },
  });
  expect(remainingCampus).toBe(0);

  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 8B-01 product reservation expiry（真实 PG）",
  () => {
    it("DB-CONSTRAINT-01/02/03：PENDING 无 deadline / 非 PRODUCT 带 deadline / pair 破缺 → 全部被约束拒绝", async () => {
      const seller = await createFixtureUser("DB01卖家");
      const buyer = await createFixtureUser("DB01买家");
      const product = await createProductFixture(seller.id);

      // 01：PRODUCT PENDING 必须有 deadline
      await expect(
        rawClient!.order.create({
          data: {
            orderNo: `${RUN_TAG}db01a`,
            type: "PRODUCT",
            status: "PENDING",
            buyerId: buyer.id,
            sellerId: seller.id,
            productId: product.id,
            amount: "10.00",
            productReservationExpiresAt: null,
          },
        }),
      ).rejects.toThrow();

      // 02：SERVICE 订单不得携带 Product reservation 字段
      await expect(
        rawClient!.order.create({
          data: {
            orderNo: `${RUN_TAG}db01b`,
            type: "SERVICE",
            status: "PENDING",
            buyerId: buyer.id,
            sellerId: seller.id,
            amount: "10.00",
            productReservationExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
        }),
      ).rejects.toThrow();

      // 03：resolvedAt / resolution 必须成对
      await expect(
        rawClient!.order.create({
          data: {
            orderNo: `${RUN_TAG}db01c`,
            type: "PRODUCT",
            status: "CANCELLED",
            buyerId: buyer.id,
            sellerId: seller.id,
            productId: product.id,
            amount: "10.00",
            productReservationResolvedAt: new Date(),
          },
        }),
      ).rejects.toThrow();

      expect(await rawClient!.order.count({ where: { orderNo: { startsWith: `${RUN_TAG}db01` } } })).toBe(0);
    });

    it("RES-CREATE-01：真实下单写入 deadline（捕获 now + 24h，resolution NULL，Product RESERVED）", async () => {
      const seller = await createFixtureUser("CREATE01卖家");
      const buyer = await createFixtureUser("CREATE01买家");
      const product = await createProductFixture(seller.id);

      const now = new Date("2026-09-29T12:00:00.000Z");
      const order = await placeRealOrder({
        buyerId: buyer.id,
        product: { id: product.id, price: "10", sellerId: seller.id, campusId },
        now,
      });
      expect(order).not.toBeNull();
      createdOrderIds.push(order!.id);

      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order!.id } });
      expect(finalOrder.status).toBe("PENDING");
      expect(finalOrder.productReservationExpiresAt?.toISOString()).toBe("2026-09-30T12:00:00.000Z");
      expect(finalOrder.productReservationResolvedAt).toBeNull();
      expect(finalOrder.productReservationResolution).toBeNull();

      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("RESERVED");
    });

    it("RES-CREATE-02：SERVICE 下单三字段保持 NULL（不套 Product timeout）", async () => {
      const seller = await createFixtureUser("CREATE02卖家");
      const buyer = await createFixtureUser("CREATE02买家");
      const serviceCategory = await rawClient!.serviceCategory.create({
        data: { name: `8B01服务类目-${randomUUID().slice(0, 6)}`, slug: `p8b01-svc-${randomUUID().slice(0, 8)}` },
      });
      const service = await rawClient!.serviceListing.create({
        data: {
          title: `8B01 服务 ${randomUUID().slice(0, 6)}`,
          description: "Phase 8B-01 service fixture",
          price: 20,
          pricingUnit: "PER_SESSION",
          locationText: "东门",
          providerId: seller.id,
          campusId,
          categoryId: serviceCategory.id,
          status: "ACTIVE",
        },
      });

      const { createServiceOrderTx } = await import("@/lib/order-creation");
      const { withTransaction } = await import("@/lib/prisma");
      const order = await withTransaction((tx: Prisma.TransactionClient) =>
        createServiceOrderTx(tx, {
          buyerId: buyer.id,
          service: { id: service.id, price: "20", providerId: seller.id, campusId },
          meetingLocation: "东门",
          note: null,
        }),
      );
      expect(order).not.toBeNull();
      createdOrderIds.push(order!.id);

      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order!.id } });
      expect(finalOrder.type).toBe("SERVICE");
      expect(finalOrder.productReservationExpiresAt).toBeNull();
      expect(finalOrder.productReservationResolvedAt).toBeNull();
      expect(finalOrder.productReservationResolution).toBeNull();
    });

    it("RES-ACCEPT-01：期限内 accept → ACCEPTED resolution，Product 保持 RESERVED", async () => {
      const seller = await createFixtureUser("ACC01卖家");
      const buyer = await createFixtureUser("ACC01买家");
      const product = await createProductFixture(seller.id);
      const order = await placeRealOrder({
        buyerId: buyer.id,
        product: { id: product.id, price: "10", sellerId: seller.id, campusId },
      });
      expect(order).not.toBeNull();
      createdOrderIds.push(order!.id);

      const deadline = new Date("2026-10-01T00:00:00.000Z");
      await rawClient!.order.update({ where: { id: order!.id }, data: { productReservationExpiresAt: deadline } });

      const outcome = await acceptOrder(
        seller.id,
        order!.id,
        { buyerId: buyer.id, sellerId: seller.id, productId: product.id },
        { now: new Date(deadline.getTime() - 1) },
      );
      expect(outcome).toEqual({ reservationResolution: "ACCEPTED" });

      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order!.id } });
      expect(finalOrder.status).toBe("ACCEPTED");
      expect(finalOrder.productReservationResolution).toBe("ACCEPTED");
      expect(finalOrder.productReservationResolvedAt).not.toBeNull();
      // expiresAt 保留为审计快照，不清空
      expect(finalOrder.productReservationExpiresAt?.toISOString()).toBe(deadline.toISOString());

      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("RESERVED");

      expect(await notificationCount(buyer.id, "订单状态更新：已接单", order!.id)).toBe(1);
      expect(await notificationCount(seller.id, "订单状态更新：已接单", order!.id)).toBe(1);
    });

    it("RES-ACCEPT-02/03：at / after deadline 的 accept 不得接受 → 同一事务 EXPIRED + Product release，无已接单通知", async () => {
      for (const [label, nowOffsetMs] of [["at", 0], ["after", 1]] as const) {
        const seller = await createFixtureUser(`ACC${label}卖家`);
        const buyer = await createFixtureUser(`ACC${label}买家`);
        const product = await createProductFixture(seller.id);
        const order = await placeRealOrder({
          buyerId: buyer.id,
          product: { id: product.id, price: "10", sellerId: seller.id, campusId },
        });
        expect(order).not.toBeNull();
        createdOrderIds.push(order!.id);

        const deadline = new Date("2026-10-01T00:00:00.000Z");
        await rawClient!.order.update({ where: { id: order!.id }, data: { productReservationExpiresAt: deadline } });

        const outcome = await acceptOrder(
          seller.id,
          order!.id,
          { buyerId: buyer.id, sellerId: seller.id, productId: product.id },
          { now: new Date(deadline.getTime() + nowOffsetMs) },
        );
        // 非 null domain outcome：action 端必须 revalidate views
        expect(outcome).toEqual({ reservationResolution: "EXPIRED" });

        const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order!.id } });
        expect(finalOrder.status).toBe("CANCELLED");
        expect(finalOrder.productReservationResolution).toBe("EXPIRED");
        expect(finalOrder.cancelReason).toBe("商品预留超时自动释放");

        expect(
          (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
        ).toBe("ACTIVE");

        expect(await notificationCount(buyer.id, "商品预留已过期", order!.id)).toBe(1);
        expect(await notificationCount(seller.id, "商品预留已过期", order!.id)).toBe(1);
        expect(await notificationCount(buyer.id, "订单状态更新：已接单", order!.id)).toBe(0);
        expect(await notificationCount(seller.id, "订单状态更新：已接单", order!.id)).toBe(0);
      }
    });

    it("RES-CANCEL-01：期限内取消 → CANCELLED resolution + ACTIVE 投影", async () => {
      const seller = await createFixtureUser("CANCEL01卖家");
      const buyer = await createFixtureUser("CANCEL01买家");
      const product = await createProductFixture(seller.id);
      const order = await placeRealOrder({
        buyerId: buyer.id,
        product: { id: product.id, price: "10", sellerId: seller.id, campusId },
      });
      expect(order).not.toBeNull();
      createdOrderIds.push(order!.id);

      const result = await transitionOrder(buyer.id, order!.id, "CANCELLED");
      expect(result).not.toBeNull();

      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order!.id } });
      expect(finalOrder.status).toBe("CANCELLED");
      expect(finalOrder.cancelReason).toBe("用户主动取消");
      expect(finalOrder.productReservationResolution).toBe("CANCELLED");
      expect(finalOrder.productReservationResolvedAt).not.toBeNull();

      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("ACTIVE");
    });

    it("RES-CANCEL-02：deadline 后取消 → deadline truth > late intent，materialize EXPIRED", async () => {
      const seller = await createFixtureUser("CANCEL02卖家");
      const buyer = await createFixtureUser("CANCEL02买家");
      // 真实不变量：PENDING reservation 的 Product = RESERVED 投影
      const product = await createProductFixture(seller.id, "RESERVED");
      const order = await createOrderFixture({
        buyerId: buyer.id,
        sellerId: seller.id,
        productId: product.id,
        status: "PENDING",
        productReservationExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
      });

      const result = await transitionOrder(buyer.id, order.id, "CANCELLED");
      // 非 null：取消请求触发了 EXPIRED materialization，views 仍须刷新
      expect(result).not.toBeNull();

      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.status).toBe("CANCELLED");
      expect(finalOrder.productReservationResolution).toBe("EXPIRED");
      expect(finalOrder.cancelReason).toBe("商品预留超时自动释放");

      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("ACTIVE");

      // 不记"用户主动取消"文案/通知
      expect(finalOrder.cancelReason).not.toBe("用户主动取消");
      expect(await notificationCount(buyer.id, "订单状态更新：已取消", order.id)).toBe(0);
      expect(await notificationCount(buyer.id, "商品预留已过期", order.id)).toBe(1);
      expect(await notificationCount(seller.id, "商品预留已过期", order.id)).toBe(1);
    });

    it("RES-EXP-01：explicit expire 未到期 → NOT_DUE 零写零通知", async () => {
      const seller = await createFixtureUser("EXP01卖家");
      const buyer = await createFixtureUser("EXP01买家");
      const product = await createProductFixture(seller.id);
      const order = await placeRealOrder({
        buyerId: buyer.id,
        product: { id: product.id, price: "10", sellerId: seller.id, campusId },
      });
      expect(order).not.toBeNull();
      createdOrderIds.push(order!.id);

      const outcome = await expireReservation(order!.id);
      expect(outcome).toEqual({ kind: "NOT_DUE" });

      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order!.id } });
      expect(finalOrder.status).toBe("PENDING");
      expect(finalOrder.productReservationResolution).toBeNull();
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("RESERVED");
      expect(await notificationCount(buyer.id, "商品预留已过期", order!.id)).toBe(0);
      expect(await notificationCount(seller.id, "商品预留已过期", order!.id)).toBe(0);
    });

    it("RES-EXP-02/03：due → CANCELLED/EXPIRED + Product ACTIVE + 恰一对通知；重放幂等 NOOP", async () => {
      const seller = await createFixtureUser("EXP02卖家");
      const buyer = await createFixtureUser("EXP02买家");
      const product = await createProductFixture(seller.id, "RESERVED");
      const order = await createOrderFixture({
        buyerId: buyer.id,
        sellerId: seller.id,
        productId: product.id,
        status: "PENDING",
        productReservationExpiresAt: new Date(Date.now() - 1000),
      });

      const outcome = await expireReservation(order.id);
      expect(outcome).toEqual({ kind: "EXPIRED" });

      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.status).toBe("CANCELLED");
      expect(finalOrder.productReservationResolution).toBe("EXPIRED");
      expect(finalOrder.cancelReason).toBe("商品预留超时自动释放");
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("ACTIVE");
      expect(await notificationCount(buyer.id, "商品预留已过期", order.id)).toBe(1);
      expect(await notificationCount(seller.id, "商品预留已过期", order.id)).toBe(1);

      // 第二次相同调用：fresh 行已非 PENDING → NOOP，无重复通知/投影
      const replay = await expireReservation(order.id);
      expect(replay).toEqual({ kind: "NOT_PENDING" });
      expect(await notificationCount(buyer.id, "商品预留已过期", order.id)).toBe(1);
      expect(await notificationCount(seller.id, "商品预留已过期", order.id)).toBe(1);
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("ACTIVE");
      expect(await rawClient!.notification.count({ where: { orderId: order.id } })).toBe(2);
    });

    it("RES-EXP-04：seller SUSPENDED → 过期仍执行（无 user actor），Product OFFLINE", async () => {
      const seller = await createFixtureUser("EXP04卖家");
      const buyer = await createFixtureUser("EXP04买家");
      const product = await createProductFixture(seller.id, "RESERVED");
      const order = await createOrderFixture({
        buyerId: buyer.id,
        sellerId: seller.id,
        productId: product.id,
        status: "PENDING",
        productReservationExpiresAt: new Date(Date.now() - 1000),
      });

      await rawClient!.user.update({ where: { id: seller.id }, data: { status: "SUSPENDED" } });

      const outcome = await expireReservation(order.id);
      expect(outcome).toEqual({ kind: "EXPIRED" });

      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.status).toBe("CANCELLED");
      expect(finalOrder.productReservationResolution).toBe("EXPIRED");
      // seller 无 marketplace exposure capability → OFFLINE（不 rollback expiration）
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("OFFLINE");
      expect(await notificationCount(buyer.id, "商品预留已过期", order.id)).toBe(1);
      expect(await notificationCount(seller.id, "商品预留已过期", order.id)).toBe(1);
    });

    it("RES-REL-01..05：release projection（eligible ACTIVE / ineligible OFFLINE / OFFLINE·SOLD 不覆盖 / 软删不复活 / 其它 active order 保持 RESERVED）", async () => {
      // 01：seller ineligible（membership 撤销）→ OFFLINE
      {
        const seller = await createFixtureUser("REL01卖家");
        const buyer = await createFixtureUser("REL01买家");
        const product = await createProductFixture(seller.id, "RESERVED");
        const order = await createOrderFixture({
          buyerId: buyer.id, sellerId: seller.id, productId: product.id, status: "PENDING",
          productReservationExpiresAt: new Date(Date.now() - 1000),
        });
        await rawClient!.campusMembership.deleteMany({ where: { userId: seller.id } });
        expect(await expireReservation(order.id)).toEqual({ kind: "EXPIRED" });
        expect(
          (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
        ).toBe("OFFLINE");
      }

      // 02：seller 显式 OFFLINE → 不被 expire 穿越
      {
        const seller = await createFixtureUser("REL02卖家");
        const buyer = await createFixtureUser("REL02买家");
        const product = await createProductFixture(seller.id, "OFFLINE");
        const order = await createOrderFixture({
          buyerId: buyer.id, sellerId: seller.id, productId: product.id, status: "PENDING",
          productReservationExpiresAt: new Date(Date.now() - 1000),
        });
        expect(await expireReservation(order.id)).toEqual({ kind: "EXPIRED" });
        expect(
          (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
        ).toBe("OFFLINE");
      }

      // 03：SOLD → 不覆盖
      {
        const seller = await createFixtureUser("REL03卖家");
        const buyer = await createFixtureUser("REL03买家");
        const product = await createProductFixture(seller.id, "SOLD");
        const order = await createOrderFixture({
          buyerId: buyer.id, sellerId: seller.id, productId: product.id, status: "PENDING",
          productReservationExpiresAt: new Date(Date.now() - 1000),
        });
        expect(await expireReservation(order.id)).toEqual({ kind: "EXPIRED" });
        expect(
          (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
        ).toBe("SOLD");
      }

      // 04：软删除 → 不复活
      {
        const seller = await createFixtureUser("REL04卖家");
        const buyer = await createFixtureUser("REL04买家");
        const product = await createProductFixture(seller.id);
        await rawClient!.product.update({
          where: { id: product.id },
          data: { deletedAt: new Date(), status: "OFFLINE" },
        });
        const order = await createOrderFixture({
          buyerId: buyer.id, sellerId: seller.id, productId: product.id, status: "PENDING",
          productReservationExpiresAt: new Date(Date.now() - 1000),
        });
        expect(await expireReservation(order.id)).toEqual({ kind: "EXPIRED" });
        const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
        expect(finalProduct.deletedAt).not.toBeNull();
        expect(finalProduct.status).toBe("OFFLINE");
      }

      // 05：其它 active PRODUCT order 仍存在 → 保持 RESERVED
      {
        const seller = await createFixtureUser("REL05卖家");
        const buyerA = await createFixtureUser("REL05买家A");
        const buyerB = await createFixtureUser("REL05买家B");
        const product = await createProductFixture(seller.id, "RESERVED");
        const orderA = await createOrderFixture({
          buyerId: buyerA.id, sellerId: seller.id, productId: product.id, status: "PENDING",
          productReservationExpiresAt: new Date(Date.now() - 1000),
        });
        const orderB = await createOrderFixture({
          buyerId: buyerB.id, sellerId: seller.id, productId: product.id, status: "ACCEPTED",
        });
        expect(await expireReservation(orderA.id)).toEqual({ kind: "EXPIRED" });
        expect(
          (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
        ).toBe("RESERVED");
        expect(
          (await rawClient!.order.findUniqueOrThrow({ where: { id: orderB.id } })).status,
        ).toBe("ACCEPTED");
      }
    });

    it("RES-DELEG-01：updateOrderStatusTx 对超期订单的 ACCEPTED 请求委派并返回非 null outcome（EXPIRED materialized）", async () => {
      const seller = await createFixtureUser("DELEG01卖家");
      const buyer = await createFixtureUser("DELEG01买家");
      const product = await createProductFixture(seller.id);
      const order = await createOrderFixture({
        buyerId: buyer.id,
        sellerId: seller.id,
        productId: product.id,
        status: "PENDING",
        productReservationExpiresAt: new Date(Date.now() - 1000),
      });

      const result = await transitionOrder(seller.id, order.id, "ACCEPTED");

      // §56：expired accept 必须 non-null → revalidateOrderViews 被触发
      expect(result).not.toBeNull();
      expect(result).toMatchObject({ productId: product.id, isBuyer: false });

      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.status).toBe("CANCELLED");
      expect(finalOrder.productReservationResolution).toBe("EXPIRED");
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("ACTIVE");
      expect(await notificationCount(buyer.id, "订单状态更新：已接单", order.id)).toBe(0);
    });

    it("RES-RACE-01 expire wins accept：T1 expire 持锁挂起 → T2 accept 真实等待（pg_locks）→ EXPIRED，accept loses，NO 40P01", async () => {
      const seller = await createFixtureUser("RACE01卖家");
      const buyer = await createFixtureUser("RACE01买家");
      const product = await createProductFixture(seller.id);
      const order = await createOrderFixture({
        buyerId: buyer.id,
        sellerId: seller.id,
        productId: product.id,
        status: "PENDING",
        productReservationExpiresAt: new Date(Date.now() - 1000),
      });

      const { withTransaction } = await import("@/lib/prisma");
      const { expireProductReservationTx } = await import("@/lib/product-order-lifecycle");

      // T1：explicit expire 取得 pair 锁 + Order 行锁后挂起（fresh 谓词 + due 已确认）
      let signalT1Locked!: () => void;
      const t1Locked = new Promise<void>((resolve) => {
        signalT1Locked = resolve;
      });
      let releaseT1!: () => void;
      const t1Gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });
      const promiseT1 = withTransaction(async (tx: Prisma.TransactionClient) =>
        expireProductReservationTx(tx, order.id, {
          afterOrderRowLock: async () => {
            signalT1Locked();
            await t1Gate;
          },
        }),
      );
      await t1Locked;

      // T2：真实 seller ACCEPT 路径，必须阻塞在同一 pair 锁域（pg_locks waiter 证据）
      const promiseT2 = transitionOrder(seller.id, order.id, "ACCEPTED").catch(
        (error: unknown) => error,
      );
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`, `USER:${seller.id}`]);

      releaseT1();
      const [resultT1, resultT2] = await Promise.allSettled([promiseT1, promiseT2]);

      assertNoSerializationFailure(
        [resultT1, resultT2]
          .filter((r): r is PromiseRejectedResult => r.status === "rejected")
          .map((r) => r.reason),
      );

      expect(resultT1).toEqual({ status: "fulfilled", value: { kind: "EXPIRED" } });
      // T2 醒来后 fresh re-read：status != PENDING → accept NOOP（null）
      expect(resultT2).toEqual({ status: "fulfilled", value: null });

      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.status).toBe("CANCELLED");
      expect(finalOrder.productReservationResolution).toBe("EXPIRED");
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("ACTIVE");

      // 无 ACCEPTED 通知；恰一对 expiry 通知
      expect(await notificationCount(buyer.id, "订单状态更新：已接单", order.id)).toBe(0);
      expect(await notificationCount(seller.id, "订单状态更新：已接单", order.id)).toBe(0);
      expect(await notificationCount(buyer.id, "商品预留已过期", order.id)).toBe(1);
      expect(await notificationCount(seller.id, "商品预留已过期", order.id)).toBe(1);
    });

    it("RES-RACE-02 accept wins expire：期限内 accept 持锁挂起 → T2 expire 真实等待 → ACCEPTED，expire NOOP，NO 40P01", async () => {
      const seller = await createFixtureUser("RACE02卖家");
      const buyer = await createFixtureUser("RACE02买家");
      const product = await createProductFixture(seller.id);
      const order = await placeRealOrder({
        buyerId: buyer.id,
        product: { id: product.id, price: "10", sellerId: seller.id, campusId },
      });
      expect(order).not.toBeNull();
      createdOrderIds.push(order!.id);

      // T1：真实 seller ACCEPT（fresh not expired 已确认）在 transition 写入前挂起
      let signalT1Locked!: () => void;
      const t1Locked = new Promise<void>((resolve) => {
        signalT1Locked = resolve;
      });
      let releaseT1!: () => void;
      const t1Gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });
      const promiseT1 = transitionOrder(seller.id, order!.id, "ACCEPTED", {
        afterOrderRowLock: async () => {
          signalT1Locked();
          await t1Gate;
        },
      });
      await t1Locked;

      // T2：explicit expire（真实 now < expiresAt），阻塞在同一 pair 锁域
      const promiseT2 = expireReservation(order!.id).catch((error: unknown) => error);
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`, `USER:${seller.id}`]);

      releaseT1();
      const [resultT1, resultT2] = await Promise.allSettled([promiseT1, promiseT2]);

      assertNoSerializationFailure(
        [resultT1, resultT2]
          .filter((r): r is PromiseRejectedResult => r.status === "rejected")
          .map((r) => r.reason),
      );

      expect(resultT1).toMatchObject({ status: "fulfilled" });
      expect((resultT1 as PromiseFulfilledResult<unknown>).value).not.toBeNull();
      // T2 醒来后 fresh re-read：ACCEPTED → NOT_PENDING
      expect(resultT2).toEqual({ status: "fulfilled", value: { kind: "NOT_PENDING" } });

      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order!.id } });
      expect(finalOrder.status).toBe("ACCEPTED");
      expect(finalOrder.productReservationResolution).toBe("ACCEPTED");
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("RESERVED");

      expect(await notificationCount(buyer.id, "订单状态更新：已接单", order!.id)).toBe(1);
      expect(await notificationCount(seller.id, "订单状态更新：已接单", order!.id)).toBe(1);
      expect(await notificationCount(buyer.id, "商品预留已过期", order!.id)).toBe(0);
      expect(await notificationCount(seller.id, "商品预留已过期", order!.id)).toBe(0);
    });

    it("RES-RACE-03 deadline boundary race：now == expiresAt 的并发 accept 全部收敛 EXPIRED（恰一次 materialization），NO 40P01", async () => {
      const seller = await createFixtureUser("RACE03卖家");
      const buyer = await createFixtureUser("RACE03买家");
      const product = await createProductFixture(seller.id);
      const order = await placeRealOrder({
        buyerId: buyer.id,
        product: { id: product.id, price: "10", sellerId: seller.id, campusId },
      });
      expect(order).not.toBeNull();
      createdOrderIds.push(order!.id);

      const deadline = new Date("2026-10-01T00:00:00.000Z");
      await rawClient!.order.update({ where: { id: order!.id }, data: { productReservationExpiresAt: deadline } });

      const acceptInput = { buyerId: buyer.id, sellerId: seller.id, productId: product.id };
      const boundaryNow = { now: deadline };

      // T1：accept（注入 now == expiresAt → EXPIRED branch）fresh 谓词后挂起
      let signalT1Locked!: () => void;
      const t1Locked = new Promise<void>((resolve) => {
        signalT1Locked = resolve;
      });
      let releaseT1!: () => void;
      const t1Gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });
      const promiseT1 = acceptOrder(seller.id, order!.id, acceptInput, boundaryNow, {
        afterOrderRowLock: async () => {
          signalT1Locked();
          await t1Gate;
        },
      });
      await t1Locked;

      // T2：同 boundary now 的 accept，必须阻塞在同一 pair 锁域（pg_locks waiter 证据）
      const promiseT2 = acceptOrder(seller.id, order!.id, acceptInput, boundaryNow).catch(
        (error: unknown) => error,
      );
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`, `USER:${seller.id}`]);

      releaseT1();
      const [resultT1, resultT2] = await Promise.allSettled([promiseT1, promiseT2]);

      assertNoSerializationFailure(
        [resultT1, resultT2]
          .filter((r): r is PromiseRejectedResult => r.status === "rejected")
          .map((r) => r.reason),
      );

      // 无论调度顺序如何：都不能 ACCEPTED——winner EXPIRED，loser null NOOP
      const outcomes = [resultT1, resultT2].map((r) =>
        r.status === "fulfilled" ? r.value : String(r.reason),
      );
      expect(outcomes).toContainEqual({ reservationResolution: "EXPIRED" });
      expect(outcomes).toContainEqual(null);

      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order!.id } });
      expect(finalOrder.status).toBe("CANCELLED");
      expect(finalOrder.productReservationResolution).toBe("EXPIRED");
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("ACTIVE");

      // 恰一对 expiry 通知，零 accept 通知；真实下单另含 2 条创建通知
      expect(await notificationCount(buyer.id, "商品预留已过期", order!.id)).toBe(1);
      expect(await notificationCount(seller.id, "商品预留已过期", order!.id)).toBe(1);
      expect(await notificationCount(buyer.id, "订单状态更新：已接单", order!.id)).toBe(0);
      expect(await rawClient!.notification.count({ where: { orderId: order!.id } })).toBe(4);
    });

    it("RES-RACE-04 expire vs buyer cancel：due 预留下二者收敛 EXPIRED（单一 release、单一通知对），NO 40P01", async () => {
      const seller = await createFixtureUser("RACE04卖家");
      const buyer = await createFixtureUser("RACE04买家");
      const product = await createProductFixture(seller.id);
      const order = await createOrderFixture({
        buyerId: buyer.id,
        sellerId: seller.id,
        productId: product.id,
        status: "PENDING",
        productReservationExpiresAt: new Date(Date.now() - 1000),
      });

      const { withTransaction } = await import("@/lib/prisma");
      const { expireProductReservationTx } = await import("@/lib/product-order-lifecycle");

      // T1：explicit expire 持锁挂起
      let signalT1Locked!: () => void;
      const t1Locked = new Promise<void>((resolve) => {
        signalT1Locked = resolve;
      });
      let releaseT1!: () => void;
      const t1Gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });
      const promiseT1 = withTransaction(async (tx: Prisma.TransactionClient) =>
        expireProductReservationTx(tx, order.id, {
          afterOrderRowLock: async () => {
            signalT1Locked();
            await t1Gate;
          },
        }),
      );
      await t1Locked;

      // T2：buyer CANCEL（真实路径），阻塞在同一 pair 锁域
      const promiseT2 = transitionOrder(buyer.id, order.id, "CANCELLED").catch(
        (error: unknown) => error,
      );
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`, `USER:${seller.id}`]);

      releaseT1();
      const [resultT1, resultT2] = await Promise.allSettled([promiseT1, promiseT2]);

      assertNoSerializationFailure(
        [resultT1, resultT2]
          .filter((r): r is PromiseRejectedResult => r.status === "rejected")
          .map((r) => r.reason),
      );

      expect(resultT1).toEqual({ status: "fulfilled", value: { kind: "EXPIRED" } });
      // cancel 醒来后 fresh re-read：非 PENDING → null NOOP
      expect(resultT2).toEqual({ status: "fulfilled", value: null });

      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.status).toBe("CANCELLED");
      expect(finalOrder.productReservationResolution).toBe("EXPIRED");
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("ACTIVE");

      // 单一 expiry 通知对，零 cancel 通知
      expect(await notificationCount(buyer.id, "商品预留已过期", order.id)).toBe(1);
      expect(await notificationCount(seller.id, "商品预留已过期", order.id)).toBe(1);
      expect(await notificationCount(buyer.id, "订单状态更新：已取消", order.id)).toBe(0);
      expect(await rawClient!.notification.count({ where: { orderId: order.id } })).toBe(2);
    });
  },
);
