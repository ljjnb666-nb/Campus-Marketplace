import { randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Phase 8A-02（P8-B01）Product RESERVED/SOLD authority closure 集成测试
// （真实 PostgreSQL）。
//
// 关闭的缺口：卖家此前可通过 UI/Server Action/domain 直调把 Product 手工写成
// RESERVED/SOLD，与 system-owned Order lifecycle projection 形成双重权威。
// 修复后合同：
//   RESERVED = system projection（唯一来源 createProductOrderTx）
//   SOLD     = system terminal projection（唯一来源 PRODUCT Order COMPLETED）
//   seller 可控目标只剩 ACTIVE/OFFLINE；SOLD 是 seller-terminal。
//
// 覆盖（指令冻结矩阵 PROD-AUTH-01..09）：
//  - 01/02：seller 经真实 Server Action 提交 RESERVED/SOLD → validator 拒绝，
//    零事务零写、Order count = 0
//  - 03：buyer 真实下单 → Product RESERVED + Order PENDING（SYSTEM 仍可）
//  - 04：RESERVED + PENDING order → seller 请求 ACTIVE → DENY（订单权威）
//  - 05：RESERVED → OFFLINE wind-down 放行（订单不动）；随后取消订单 →
//    Product remains OFFLINE（cancellation projection 不复活显式 OFFLINE）
//  - 06：全链 create → accept → complete → Order COMPLETED + Product SOLD
//    （SYSTEM 仍可制造 SOLD）
//  - 07/08：SOLD → seller ACTIVE / OFFLINE → DENY（seller-terminal）
//  - 09：stale RESERVED（无 active order）→ seller ACTIVE 恢复（capability PASS）
//
// System 链路（下单/接单/完成/取消）全部经真实 createProductOrderTx /
// updateOrderStatusTx 事务入口执行，不经 fixture 直写投影。

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const sessionSeam = vi.hoisted(() => ({
  actionUser: { current: null as null | { id: string; email: string; name: string } },
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser: async () => {
    if (!sessionSeam.actionUser.current) {
      throw new Error("NO_SESSION");
    }
    return sessionSeam.actionUser.current;
  },
  requireAdmin: async () => {
    if (!sessionSeam.actionUser.current) {
      throw new Error("NO_SESSION");
    }
    return sessionSeam.actionUser.current;
  },
}));

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p8a02-${randomUUID().slice(0, 8)}`;
const CAMPUS_SLUG = `p8a02-${randomUUID().slice(0, 8)}`;

const userIds: string[] = [];
const productIds: string[] = [];
const orderIds: string[] = [];

let campusId = "";
let productCategoryId = "";

let fixtureSeq = 0;

async function createFixtureUser(name: string) {
  const seq = fixtureSeq++;
  const user = await rawClient!.user.create({
    data: {
      email: `${RUN_TAG}-${seq}-${name}@it.local`,
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

async function createProductFixture(sellerId: string, status: "ACTIVE" | "RESERVED" | "SOLD" | "OFFLINE" = "ACTIVE") {
  const product = await rawClient!.product.create({
    data: {
      title: `8A02 商品 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8A-02 authority fixture",
      price: 10,
      condition: "NEW",
      locationText: "东门",
      categoryId: productCategoryId,
      campusId,
      sellerId,
      status,
    },
  });
  productIds.push(product.id);
  return product;
}

async function createOrderFixture(input: {
  buyerId: string;
  sellerId: string;
  productId: string;
  status: "PENDING" | "ACCEPTED";
}) {
  const order = await rawClient!.order.create({
    data: {
      orderNo: `${RUN_TAG}${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
      type: "PRODUCT",
      status: input.status,
      // Phase 8B-01 约束：PRODUCT PENDING 必须有 seller 确认截止
      productReservationExpiresAt:
        input.status === "PENDING" ? new Date(Date.now() + 60 * 60 * 1000) : null,
      buyerId: input.buyerId,
      sellerId: input.sellerId,
      productId: input.productId,
      amount: "10.00",
    },
  });
  orderIds.push(order.id);
  return order;
}

/** 真实 buyer 下单（createProductOrderTx 完整事务链：行锁 + capability + 预留）。 */
async function placeRealOrder(input: { buyerId: string; product: { id: string; price: string; sellerId: string; campusId: string } }) {
  const { createProductOrderTx } = await import("@/lib/order-creation");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    createProductOrderTx(tx, {
      buyerId: input.buyerId,
      product: input.product,
      meetingLocation: "东门",
      note: null,
    }),
  );
}

/** 真实订单状态流转（updateOrderStatusTx：ACCEPTED/COMPLETED/CANCELLED）。 */
async function transitionOrder(actorId: string, orderId: string, requestedStatus: "ACCEPTED" | "COMPLETED" | "CANCELLED") {
  const { updateOrderStatusTx } = await import("@/lib/order-status-service");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    updateOrderStatusTx(tx, actorId, orderId, { requestedStatus }),
  );
}

/** 真实 Server Action 入口（session seam 指定 seller）。 */
async function sellerStatusAction(sellerId: string, productId: string, status: string) {
  const { updateProductStatus } = await import("@/actions/product");
  sessionSeam.actionUser.current = { id: sellerId, email: "", name: "" };
  const formData = new FormData();
  formData.set("productId", productId);
  formData.set("status", status);
  return updateProductStatus(formData);
}

beforeAll(async () => {
  if (!rawClient) return;

  const campus = await rawClient.campus.upsert({
    where: { slug: CAMPUS_SLUG },
    create: { name: `8A02 权威校区 ${randomUUID().slice(0, 6)}`, slug: CAMPUS_SLUG, schoolName: "集成测试大学" },
    update: {},
  });
  campusId = campus.id;
  const category = await rawClient.productCategory.create({
    data: { name: `8A02类目-${RUN_TAG}`, slug: RUN_TAG },
  });
  productCategoryId = category.id;
});

afterAll(async () => {
  if (!rawClient) return;

  // 反向 FK 顺序清理（精确 fixture ID 域，不触碰共享数据）。
  // Campus 被 User/Product/CampusMembership/RiskState.campusId 引用，
  // 必须最后删除；禁止 silent catch 吞掉 cleanup failure（CI #187：
  // User_campusId_fkey 违反被吞 → Campus fixture 残留）。
  await rawClient.notification.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.riskState.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.order.deleteMany({ where: { id: { in: orderIds } } });
  await rawClient.product.deleteMany({ where: { id: { in: productIds } } });
  await rawClient.productCategory.deleteMany({ where: { id: productCategoryId } });
  await rawClient.campusMembership.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: userIds } } });
  await rawClient.campus.deleteMany({ where: { id: campusId } });

  // teardown 完整性：fixture campus 必须清零（FK 顺序错误的哨兵断言）
  expect(
    await rawClient.campus.count({ where: { id: campusId } }),
  ).toBe(0);

  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 8A-02 product RESERVED/SOLD authority closure（real PostgreSQL）",
  () => {
    it("PROD-AUTH-01/02：seller 经真实 action 提交 RESERVED/SOLD → validator 拒绝，零写零订单", async () => {
      const seller = await createFixtureUser("AUTH01卖家");
      const product = await createProductFixture(seller.id, "ACTIVE");

      await sellerStatusAction(seller.id, product.id, "RESERVED");
      await sellerStatusAction(seller.id, product.id, "SOLD");

      const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(finalProduct.status).toBe("ACTIVE");
      expect(
        await rawClient!.order.count({ where: { productId: product.id } }),
      ).toBe(0);
    });

    it("PROD-AUTH-03：buyer 真实下单 → Product RESERVED + Order PENDING（system 权威保留）", async () => {
      const seller = await createFixtureUser("AUTH03卖家");
      const buyer = await createFixtureUser("AUTH03买家");
      const product = await createProductFixture(seller.id, "ACTIVE");

      const order = await placeRealOrder({
        buyerId: buyer.id,
        product: { id: product.id, price: "10", sellerId: seller.id, campusId },
      });
      expect(order).not.toBeNull();
      orderIds.push(order!.id);

      const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order!.id } });
      expect(finalProduct.status).toBe("RESERVED");
      expect(finalOrder.status).toBe("PENDING");
    });

    it("PROD-AUTH-04：RESERVED + PENDING order → seller 请求 ACTIVE → DENY（订单仍 PENDING）", async () => {
      const seller = await createFixtureUser("AUTH04卖家");
      const buyer = await createFixtureUser("AUTH04买家");
      const product = await createProductFixture(seller.id, "RESERVED");
      const order = await createOrderFixture({ buyerId: buyer.id, sellerId: seller.id, productId: product.id, status: "PENDING" });

      // 领域直调（as never 绕过类型也不放行）+ 真实 action 双层
      const { updateProductStatusTx } = await import("@/lib/listing-status-service");
      const { withTransaction } = await import("@/lib/prisma");
      const domainResult = await withTransaction((tx: Prisma.TransactionClient) =>
        updateProductStatusTx(tx, seller.id, product.id, "ACTIVE"),
      );
      expect(domainResult).toBe(false);

      await sellerStatusAction(seller.id, product.id, "ACTIVE");

      const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalProduct.status).toBe("RESERVED");
      expect(finalOrder.status).toBe("PENDING");
    });

    it("PROD-AUTH-05（Phase 8F 收紧）：RESERVED + active order → seller OFFLINE DENY；订单取消后 Product 重投影（CASE A/B）", async () => {
      const seller = await createFixtureUser("AUTH05卖家");
      const buyer = await createFixtureUser("AUTH05买家");
      const product = await createProductFixture(seller.id, "RESERVED");
      const order = await createOrderFixture({ buyerId: buyer.id, sellerId: seller.id, productId: product.id, status: "PENDING" });

      // Phase 8F（§4/§48）：RESERVED 是 system-owned projection——active
      // order 存续期间 seller 的 OFFLINE 与 ACTIVE 一律 DENY（真实 action 入口）
      await sellerStatusAction(seller.id, product.id, "OFFLINE");
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("RESERVED");
      expect(
        (await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } })).status,
      ).toBe("PENDING");

      // 取消订单：cancellation projection 拥有 release 后的重投影权威——
      // capability PASS → RESERVED → ACTIVE（CASE A）
      const cancelled = await transitionOrder(buyer.id, order.id, "CANCELLED");
      expect(cancelled).not.toBeNull();

      expect(
        (await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } })).status,
      ).toBe("CANCELLED");
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("ACTIVE");
    });

    it("PROD-AUTH-06/07/08：真实全链成交 → Product SOLD（system）；seller ACTIVE/OFFLINE 均 DENY", async () => {
      const seller = await createFixtureUser("AUTH06卖家");
      const buyer = await createFixtureUser("AUTH06买家");
      const product = await createProductFixture(seller.id, "ACTIVE");

      const order = await placeRealOrder({
        buyerId: buyer.id,
        product: { id: product.id, price: "10", sellerId: seller.id, campusId },
      });
      expect(order).not.toBeNull();
      orderIds.push(order!.id);
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("RESERVED");

      const accepted = await transitionOrder(seller.id, order!.id, "ACCEPTED");
      expect(accepted).not.toBeNull();
      const completed = await transitionOrder(buyer.id, order!.id, "COMPLETED");
      expect(completed).not.toBeNull();

      expect(
        (await rawClient!.order.findUniqueOrThrow({ where: { id: order!.id } })).status,
      ).toBe("COMPLETED");
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("SOLD");

      // SOLD = seller-terminal：ACTIVE / OFFLINE 都不得重新定义生命周期
      const { updateProductStatusTx } = await import("@/lib/listing-status-service");
      const { withTransaction } = await import("@/lib/prisma");
      expect(
        await withTransaction((tx: Prisma.TransactionClient) =>
          updateProductStatusTx(tx, seller.id, product.id, "ACTIVE"),
        ),
      ).toBe(false);
      expect(
        await withTransaction((tx: Prisma.TransactionClient) =>
          updateProductStatusTx(tx, seller.id, product.id, "OFFLINE"),
        ),
      ).toBe(false);

      await sellerStatusAction(seller.id, product.id, "ACTIVE");
      await sellerStatusAction(seller.id, product.id, "OFFLINE");

      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("SOLD");
    });

    it("PROD-AUTH-09：stale RESERVED（无 active order）→ seller ACTIVE 恢复（capability PASS）", async () => {
      const seller = await createFixtureUser("AUTH09卖家");
      const product = await createProductFixture(seller.id, "RESERVED");
      expect(
        await rawClient!.order.count({
          where: { productId: product.id, type: "PRODUCT", status: { in: ["PENDING", "ACCEPTED"] } },
        }),
      ).toBe(0);

      const result = await sellerStatusAction(seller.id, product.id, "ACTIVE");

      expect(result).toBeUndefined(); // action 返回 void；结果以 DB 权威为准
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("ACTIVE");
    });
  },
);
