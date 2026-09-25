import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * AUDIT2-RB01：PRODUCT listing / order authority closure 真实 PostgreSQL
 * 集成验证。
 *
 * 冻结不变量：ORDER WIND-DOWN ≠ LISTING EXPOSURE AUTHORITY——
 * 订单取消不得覆盖卖家显式 OFFLINE / 软删除 / 其它 active reservation /
 * seller 重新曝光资格；竞态全部使用 Promise barrier / advisory-lock waiter
 * 证据（禁止 sleep 排序），状态突变全部为真实 DB 行。
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const prisma = integrationDatabaseUrl ? (await import("@/lib/prisma")).prisma : null;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `a2rb01-${randomUUID().slice(0, 8)}`;
const CAMPUS_SLUG = "a2rb01-authority-it";

const { waitForAdvisoryLockWaiter } = await import("./helpers/lock-barrier");

describe.skipIf(!integrationDatabaseUrl)(
  "AUDIT2-RB01 product listing / order authority (real PostgreSQL)",
  () => {
    let campusId = "";
    let productCategoryId = "";
    const userIds: string[] = [];
    const productIds: string[] = [];
    const orderIds: string[] = [];

    // 同步自增序号：并发 fixture 创建下 userIds.length 会读到相同值导致
    // email 唯一约束碰撞
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

    async function createReservedProductWithPendingOrder(
      input?: { productStatus?: "ACTIVE" | "RESERVED" | "SOLD" | "OFFLINE" },
    ) {
      const seller = await createFixtureUser("卖家");
      const buyer = await createFixtureUser("买家");
      const product = await rawClient!.product.create({
        data: {
          title: `A2RB01 商品 ${randomUUID().slice(0, 6)}`,
          description: "AUDIT2-RB01 authority fixture",
          price: 10,
          condition: "NEW",
          locationText: "东门",
          categoryId: productCategoryId,
          campusId,
          sellerId: seller.id,
          status: input?.productStatus ?? "RESERVED",
        },
      });
      productIds.push(product.id);
      const order = await rawClient!.order.create({
        data: {
          orderNo: `${RUN_TAG}${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
          type: "PRODUCT",
          status: "PENDING",
          buyerId: buyer.id,
          sellerId: seller.id,
          productId: product.id,
          amount: "10.00",
        },
      });
      orderIds.push(order.id);
      return { seller, buyer, product, order };
    }

    async function cancelOrder(actorId: string, orderId: string) {
      const { updateOrderStatusTx } = await import("@/lib/order-status-service");
      const { withTransaction } = await import("@/lib/prisma");
      return withTransaction((tx: Prisma.TransactionClient) =>
        updateOrderStatusTx(tx, actorId, orderId, { requestedStatus: "CANCELLED" }),
      );
    }

    beforeAll(async () => {
      const campus = await rawClient!.campus.upsert({
        where: { slug: CAMPUS_SLUG },
        create: { name: "A2RB01 权威校区", slug: CAMPUS_SLUG, schoolName: "集成测试大学" },
        update: {},
      });
      campusId = campus.id;
      const category = await rawClient!.productCategory.create({
        data: { name: `A2RB01类目-${RUN_TAG}`, slug: RUN_TAG },
      });
      productCategoryId = category.id;
    });

    afterAll(async () => {
      await rawClient!.notification.deleteMany({ where: { userId: { in: userIds } } });
      await rawClient!.riskState.deleteMany({ where: { userId: { in: userIds } } });
      await rawClient!.order.deleteMany({ where: { id: { in: orderIds } } });
      await rawClient!.product.deleteMany({ where: { id: { in: productIds } } });
      await rawClient!.productCategory.deleteMany({ where: { id: productCategoryId } });
      await rawClient!.campusMembership.deleteMany({ where: { userId: { in: userIds } } });
      await rawClient!.user.deleteMany({ where: { id: { in: userIds } } });
      await rawClient!.$disconnect();
      await prisma?.$disconnect();
    });

    it("PRODUCT-CANCEL-07 正常取消：RESERVED + 无其它 active order + 双方 eligible → ACTIVE（既有体验保持）", async () => {
      const { seller, buyer, product, order } = await createReservedProductWithPendingOrder();

      const result = await cancelOrder(buyer.id, order.id);

      expect(result).toMatchObject({ productId: product.id, isBuyer: true });
      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.status).toBe("CANCELLED");
      expect(finalOrder.cancelReason).toBe("用户主动取消");
      const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(finalProduct.status).toBe("ACTIVE");
      // 单次 transition → 一对通知
      const notifications = await rawClient!.notification.count({
        where: { orderId: order.id, userId: { in: [buyer.id, seller.id] } },
      });
      expect(notifications).toBe(2);
    });

    it("PRODUCT-CANCEL-RACE-01 / counterexample A：卖家显式 OFFLINE 先提交 → 取消不得复活 ACTIVE", async () => {
      const { seller, buyer, product, order } = await createReservedProductWithPendingOrder();
      const { updateProductStatusTx } = await import("@/lib/listing-status-service");
      const { withTransaction } = await import("@/lib/prisma");

      // seller 经 production 路径先提交 OFFLINE（wind-down：无 capability 要求）
      const offline = await withTransaction((tx: Prisma.TransactionClient) =>
        updateProductStatusTx(tx, seller.id, product.id, "OFFLINE"),
      );
      expect(offline).toBe(true);

      const result = await cancelOrder(buyer.id, order.id);

      expect(result).not.toBeNull();
      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.status).toBe("CANCELLED");
      const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(finalProduct.status).toBe("OFFLINE");
    });

    it("PRODUCT-CANCEL-RACE-03 / counterexample B：软删除（deletedAt + OFFLINE）→ 取消后不得形成 deleted+ACTIVE 矛盾态", async () => {
      const { buyer, product, order } = await createReservedProductWithPendingOrder();

      // deleteProduct 的 domain mutation 等价提交：status=OFFLINE + deletedAt
      await rawClient!.product.update({
        where: { id: product.id },
        data: { status: "OFFLINE", deletedAt: new Date() },
      });

      const result = await cancelOrder(buyer.id, order.id);

      expect(result).not.toBeNull();
      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.status).toBe("CANCELLED");
      const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(finalProduct.deletedAt).not.toBeNull();
      expect(finalProduct.status).not.toBe("ACTIVE");
    });

    it("PRODUCT-CANCEL-04 seller RESTRICTED：取消成功提交，Product → OFFLINE（不 rollback）", async () => {
      const { GLOBAL_SCOPE_KEY } = await import("@/lib/rbac/roles");
      const { seller, buyer, product, order } = await createReservedProductWithPendingOrder();

      await rawClient!.riskState.create({
        data: {
          userId: seller.id,
          scopeKey: GLOBAL_SCOPE_KEY,
          state: "RESTRICTED",
          reasonCode: "MANUAL_REVIEW",
        },
      });

      const result = await cancelOrder(buyer.id, order.id);

      expect(result).not.toBeNull();
      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.status).toBe("CANCELLED");
      const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(finalProduct.status).toBe("OFFLINE");
    });

    it("PRODUCT-CANCEL-05 seller membership SUSPENDED：取消成功，Product → OFFLINE", async () => {
      const { seller, buyer, product, order } = await createReservedProductWithPendingOrder();

      await rawClient!.campusMembership.update({
        where: { userId_campusId: { userId: seller.id, campusId } },
        data: { status: "SUSPENDED" },
      });

      const result = await cancelOrder(buyer.id, order.id);

      expect(result).not.toBeNull();
      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.status).toBe("CANCELLED");
      const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(finalProduct.status).toBe("OFFLINE");
    });

    it("PRODUCT-CANCEL-06 seller account SUSPENDED：buyer 仍可取消既有订单（counterparty 不阻断 wind-down）", async () => {
      const { seller, buyer, product, order } = await createReservedProductWithPendingOrder();

      await rawClient!.user.update({
        where: { id: seller.id },
        data: { status: "SUSPENDED" },
      });

      const result = await cancelOrder(buyer.id, order.id);

      expect(result).not.toBeNull();
      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.status).toBe("CANCELLED");
      const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(finalProduct.status).toBe("OFFLINE");
    });

    it("PRODUCT-CANCEL-08 历史 anomaly（同商品双 PENDING order）：取消 A → 不得 ACTIVE（B 仍占用 reservation）", async () => {
      const { seller, buyer, product, order: orderA } =
        await createReservedProductWithPendingOrder();

      // 直接构造 historical anomaly：第二个 PENDING order 绕过创建校验
      const orderB = await rawClient!.order.create({
        data: {
          orderNo: `${RUN_TAG}${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
          type: "PRODUCT",
          status: "PENDING",
          buyerId: buyer.id,
          sellerId: seller.id,
          productId: product.id,
          amount: "10.00",
        },
      });
      orderIds.push(orderB.id);

      const result = await cancelOrder(buyer.id, orderA.id);

      expect(result).not.toBeNull();
      const finalA = await rawClient!.order.findUniqueOrThrow({ where: { id: orderA.id } });
      expect(finalA.status).toBe("CANCELLED");
      const finalB = await rawClient!.order.findUniqueOrThrow({ where: { id: orderB.id } });
      expect(finalB.status).toBe("PENDING");
      const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(finalProduct.status).toBe("RESERVED");
    });

    it("PRODUCT-STATUS-01 手动重新曝光：RESERVED + PENDING order → ACTIVE 安全 NO-OP", async () => {
      const { seller, product } = await createReservedProductWithPendingOrder();
      const { updateProductStatusTx } = await import("@/lib/listing-status-service");
      const { withTransaction } = await import("@/lib/prisma");

      const ok = await withTransaction((tx: Prisma.TransactionClient) =>
        updateProductStatusTx(tx, seller.id, product.id, "ACTIVE"),
      );

      expect(ok).toBe(false);
      const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(finalProduct.status).toBe("RESERVED");
    });

    it("PRODUCT-STATUS-02 手动重新曝光：OFFLINE + 无 active order + eligible → ACTIVE", async () => {
      const { seller, buyer, product, order } = await createReservedProductWithPendingOrder();
      const { updateProductStatusTx } = await import("@/lib/listing-status-service");
      const { withTransaction } = await import("@/lib/prisma");

      // 先走正常取消（无其它 active order + eligible → ACTIVE），再下架
      await cancelOrder(buyer.id, order.id);
      const offline = await withTransaction((tx: Prisma.TransactionClient) =>
        updateProductStatusTx(tx, seller.id, product.id, "OFFLINE"),
      );
      expect(offline).toBe(true);

      const ok = await withTransaction((tx: Prisma.TransactionClient) =>
        updateProductStatusTx(tx, seller.id, product.id, "ACTIVE"),
      );

      expect(ok).toBe(true);
      const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(finalProduct.status).toBe("ACTIVE");
    });

    it("PRODUCT-STATUS-03 手动重新曝光：seller RESTRICTED → 既有 MARKETPLACE_RESTRICTED taxonomy 不变", async () => {
      const { GLOBAL_SCOPE_KEY } = await import("@/lib/rbac/roles");
      const { seller, product } = await createReservedProductWithPendingOrder({
        productStatus: "OFFLINE",
      });
      const { updateProductStatusTx } = await import("@/lib/listing-status-service");
      const { withTransaction } = await import("@/lib/prisma");

      await rawClient!.riskState.create({
        data: {
          userId: seller.id,
          scopeKey: GLOBAL_SCOPE_KEY,
          state: "RESTRICTED",
          reasonCode: "MANUAL_REVIEW",
        },
      });

      await expect(
        withTransaction((tx: Prisma.TransactionClient) =>
          updateProductStatusTx(tx, seller.id, product.id, "ACTIVE"),
        ),
      ).rejects.toMatchObject({ code: "MARKETPLACE_RESTRICTED" });

      const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(finalProduct.status).toBe("OFFLINE");
    });

    it("PRODUCT-CANCEL-RACE-02 真实竞态：cancel 持全部权威暂停 → seller OFFLINE 等待共享 seller 锁 → cancel 先提交 → seller 显式 OFFLINE 最终权威", async () => {
      const { updateOrderStatusTx } = await import("@/lib/order-status-service");
      const { updateProductStatusTx } = await import("@/lib/listing-status-service");
      const { withTransaction } = await import("@/lib/prisma");
      const { seller, buyer, product, order } = await createReservedProductWithPendingOrder();

      // cancel 事务在 participant locks + Order/Product 行锁权威齐备后受控暂停
      let authorityHeld!: () => void;
      const authority = new Promise<void>((resolve) => {
        authorityHeld = resolve;
      });
      let releaseCancel!: () => void;
      const cancelGate = new Promise<void>((resolve) => {
        releaseCancel = resolve;
      });

      const cancelSeams = {
        afterProductRowLock: async () => {
          authorityHeld();
          await cancelGate;
        },
      } as Parameters<typeof updateOrderStatusTx>[4];

      const cancelTx = withTransaction((tx: Prisma.TransactionClient) =>
        updateOrderStatusTx(tx, buyer.id, order.id, { requestedStatus: "CANCELLED" }, cancelSeams),
      );
      await authority;

      // seller OFFLINE：必须真实阻塞在共享 USER:seller 治理锁上
      const sellerTx = withTransaction((tx: Prisma.TransactionClient) =>
        updateProductStatusTx(tx, seller.id, product.id, "OFFLINE"),
      );
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${seller.id}`]);

      // cancel 先完成（提交 ACTIVE 投影），seller 随后完成 → 显式 OFFLINE 不被覆盖
      releaseCancel();
      const cancelResult = await cancelTx;
      expect(cancelResult).not.toBeNull();
      expect(await sellerTx).toBe(true);

      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.status).toBe("CANCELLED");
      const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(finalProduct.status).toBe("OFFLINE");
    });

    it("DOUBLE-CANCEL：同订单两路并发取消 → 恰一次 transition、一对通知、投影只算一次", async () => {
      const { seller, buyer, product, order } = await createReservedProductWithPendingOrder();

      const [byBuyer, bySeller] = await Promise.all([
        cancelOrder(buyer.id, order.id),
        cancelOrder(seller.id, order.id),
      ]);

      const outcomes = [byBuyer, bySeller].filter((r) => r !== null);
      expect(outcomes).toHaveLength(1);

      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.status).toBe("CANCELLED");
      const notifications = await rawClient!.notification.count({
        where: { orderId: order.id, userId: { in: [buyer.id, seller.id] } },
      });
      expect(notifications).toBe(2);
      const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(finalProduct.status).toBe("ACTIVE");
    });

    it("NO-OVERSALE 回归：9 buyer 并发抢购同一 ACTIVE 商品 → 恰一个 PENDING order、RESERVED 不超卖", async () => {
      const { createProductOrderTx } = await import("@/lib/order-creation");
      const { withTransaction } = await import("@/lib/prisma");
      const seller = await createFixtureUser("抢购卖家");
      const product = await rawClient!.product.create({
        data: {
          title: `A2RB01 抢购商品 ${randomUUID().slice(0, 6)}`,
          description: "AUDIT2-RB01 oversale regression",
          price: 10,
          condition: "NEW",
          locationText: "东门",
          categoryId: productCategoryId,
          campusId,
          sellerId: seller.id,
          status: "ACTIVE",
        },
      });
      productIds.push(product.id);

      const contenders = await Promise.all(
        Array.from({ length: 9 }, async () => {
          const buyer = await createFixtureUser("抢购买家");
          return withTransaction((tx: Prisma.TransactionClient) =>
            createProductOrderTx(tx, {
              buyerId: buyer.id,
              product: {
                id: product.id,
                price: "10.00",
                sellerId: seller.id,
                campusId,
              },
              meetingLocation: "东门",
              note: null,
            }),
          );
        }),
      );

      const winners = contenders.filter((order) => order !== null);
      expect(winners).toHaveLength(1);
      const orders = await rawClient!.order.findMany({
        where: { productId: product.id, type: "PRODUCT" },
      });
      expect(orders).toHaveLength(1);
      expect(orders[0]!.status).toBe("PENDING");
      orderIds.push(orders[0]!.id);
      const finalProduct = await rawClient!.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(finalProduct.status).toBe("RESERVED");
    });
  },
);
