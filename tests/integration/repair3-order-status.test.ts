import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * RB-03 REVIEW FIX（GROUP 2）：General Order status × suspend lifecycle
 * 真实 PostgreSQL 竞态（ORDER-RACE-01 SUSPEND WINS）。
 *
 * 卖家对 PENDING PRODUCT order 请求 ACCEPTED：entry auth 后、USER 锁前
 * 挂起 → suspendAccount（production 路径）先提交 → T1 锁内 fresh 复核
 * 失败 → AUTH_ACCOUNT_INACTIVE，零 Order/通知写。
 */

vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const prisma = integrationDatabaseUrl ? (await import("@/lib/prisma")).prisma : null;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `rb03ord-${randomUUID().slice(0, 8)}`;
const RB03_ORDER_CAMPUS_SLUG = "rb03-order-it";

const { integrationRequireUser } = vi.hoisted(() => ({
  integrationRequireUser: vi.fn(),
}));

vi.mock("@/lib/server-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server-auth")>();
  return { ...actual, requireUser: integrationRequireUser };
});

describe.skipIf(!integrationDatabaseUrl)("order status × suspend (RB-03, real PostgreSQL)", () => {
  let campusId = "";
  const userIds: string[] = [];
  const orderIds: string[] = [];
  const productIds: string[] = [];
  let productCategoryId = "";

  async function createFixtureUser(name: string) {
    const user = await rawClient!.user.create({
      data: {
        email: `${RUN_TAG}-${userIds.length}-${name}@it.local`,
        name,
        passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
        schoolName: "集成测试大学",
        campusId,
        role: "STUDENT",
        status: "ACTIVE",
      },
    });
    userIds.push(user.id);
    return user;
  }

  beforeAll(async () => {
    const campus = await rawClient!.campus.upsert({
      where: { slug: RB03_ORDER_CAMPUS_SLUG },
      create: { name: "RB03 订单集成校区", slug: RB03_ORDER_CAMPUS_SLUG, schoolName: "集成测试大学" },
      update: {},
    });
    campusId = campus.id;
    const category = await rawClient!.productCategory.create({
      data: { name: `RB03订单类目-${RUN_TAG}`, slug: RUN_TAG },
    });
    productCategoryId = category.id;
  });

  afterAll(async () => {
    await rawClient!.notification.deleteMany({ where: { userId: { in: userIds } } });
    await rawClient!.enforcementAction.deleteMany({
      where: { OR: [{ actorId: { in: userIds } }, { targetId: { in: userIds } }] },
    });
    await rawClient!.adminLog.deleteMany({
      where: { OR: [{ adminId: { in: userIds } }, { targetId: { in: userIds } }] },
    });
    await rawClient!.order.deleteMany({ where: { id: { in: orderIds } } });
    await rawClient!.product.deleteMany({ where: { id: { in: productIds } } });
    await rawClient!.productCategory.deleteMany({ where: { id: productCategoryId } });
    await rawClient!.campusMembership.deleteMany({ where: { userId: { in: userIds } } });
    await rawClient!.user.deleteMany({ where: { id: { in: userIds } } });
    // 不删除 Campus 行（稳定 slug 复用）
    await rawClient!.$disconnect();
    await prisma?.$disconnect();
  });

  it("ORDER-RACE-01 suspend wins：entry 后挂起 → suspend 提交 → stale ACCEPTED 被拒零写入", async () => {
    const { updateOrderStatusTx } = await import("@/lib/order-status-service");
    const { withTransaction } = await import("@/lib/prisma");
    const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");

    const suspender = await createFixtureUser("RB03 订单停用操作者");
    const seller = await createFixtureUser("RB03 订单卖家");
    const buyer = await createFixtureUser("RB03 订单买家");
    for (const u of [suspender, seller, buyer]) {
      await rawClient!.campusMembership.create({
        data: { userId: u.id, campusId, status: "ACTIVE" },
      });
    }

    const product = await rawClient!.product.create({
      data: {
        title: `RB03 订单商品 ${randomUUID().slice(0, 6)}`,
        description: "RB03 order race",
        price: 10,
        condition: "NEW",
        locationText: "北门",
        categoryId: productCategoryId,
        campusId,
        sellerId: seller.id,
        status: "ACTIVE",
      },
    });
    productIds.push(product.id);

    const order = await rawClient!.order.create({
      data: {
        orderNo: `${RUN_TAG}${Math.floor(Math.random() * 0xffff).toString(16)}`,
        type: "PRODUCT",
        status: "PENDING",
        buyerId: buyer.id,
        sellerId: seller.id,
        productId: product.id,
        amount: "10.00",
      },
    });
    orderIds.push(order.id);

    // T1：seller 的 stale ACCEPTED 请求，USER 锁前挂起
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    const t1 = withTransaction((tx: Prisma.TransactionClient) =>
      updateOrderStatusTx(tx, seller.id, order.id, { requestedStatus: "ACCEPTED" }, {
        beforeLock: async () => {
          signalEntered();
          await t1Gate;
        },
      }),
    );
    await entered;

    // T2：suspend seller（production enforcement 路径）
    const enforcer = await createFixtureUser("RB03 订单停用操作者");
    const enforcement = await import("@/lib/enforcement/account-enforcement-service");
    const role = await rawClient!.role.create({
      data: {
        key: `${RUN_TAG}_SUSPENDER`,
        name: `${RUN_TAG}_SUSPENDER`,
        scope: "GLOBAL",
        isSystem: false,
        rolePermissions: {
          create: [{ permission: { connect: { key: "user.suspend" } } }],
        },
      },
    });
    await rawClient!.userRoleAssignment.create({
      data: { userId: enforcer.id, roleId: role.id, campusId: null, scopeKey: "GLOBAL" },
    });

    const suspendResult = await enforcement.suspendAccount({
      actorId: enforcer.id,
      targetUserId: seller.id,
      reasonCode: "MANUAL_REVIEW",
      note: "RB-03 ORDER-RACE-01",
    });
    expect(suspendResult.status).toBe("SUSPENDED");

    releaseT1();
    await expect(t1).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });

    // zero Order mutation：PENDING 保持，product 仍 ACTIVE（未被 ACCEPTED 触发任何流转）
    const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalOrder.status).toBe("PENDING");
    const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(finalProduct.status).toBe("ACTIVE");
    // 无通知写入
    const orderNotifications = await rawClient!.notification.count({
      where: { orderId: order.id },
    });
    // stale ACCEPTED 被拒：零订单状态通知
    expect(orderNotifications).toBe(0);
  });
});
