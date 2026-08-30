import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";

/**
 * ERRAND 完成 exactly-once 真实数据库集成测试。
 *
 * 仅当 INTEGRATION_DATABASE_URL 指向已应用迁移的真实 PostgreSQL 时执行。
 * 覆盖（对应 Release Gate 修复的三条硬要求）：
 *
 * 1. 伪造/提前完成（forged request）：Order IN_PROGRESS + ErrandTask
 *    IN_PROGRESS（接单者未提交完成）→ canonical 完成被拒，
 *    两表状态、双方计数、完成通知数量全部不变
 * 2. 并发完成（exactly-once）：PENDING_CONFIRMATION + IN_PROGRESS 状态下
 *    并发触发两次 canonical completion → 恰好一个胜者；
 *    Order/ErrandTask 均为 COMPLETED；双方计数恰好 +1；完成通知无重复
 * 3. 重试幂等：已 COMPLETED 后再次提交 → 状态/计数/通知全部不变
 */

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

describe.skipIf(!integrationDatabaseUrl)("ERRAND 完成 exactly-once 集成测试 (errand-completion)", () => {
  // 与 db-smoke 同理：必须用独立 PrismaClient 连 INTEGRATION_DATABASE_URL。
  // @/lib/prisma 单例读取 .env 的 DATABASE_URL（开发库），无法切换目标库。
  type PrismaModule = typeof import("@prisma/client");
  type CompletionModule = typeof import("@/lib/errand-completion");
  let prisma: InstanceType<PrismaModule["PrismaClient"]>;
  let completeErrandOrderTx: CompletionModule["completeErrandOrderTx"];

  /** 交互事务（与 withTransaction 语义一致：默认超时的 $transaction 包装） */
  function runInTransaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(callback, { timeout: 15_000 });
  }

  let campusId: string;
  let categoryId: string;
  let buyerId: string;
  let sellerId: string;
  let orderSeq = 0;

  beforeAll(async () => {
    const { PrismaClient } = await import("@prisma/client");
    ({ completeErrandOrderTx } = await import("@/lib/errand-completion"));
    prisma = new PrismaClient({
      datasources: { db: { url: integrationDatabaseUrl } },
    });
    await prisma.$connect();

    const campus = await prisma.campus.create({
      data: {
        name: "跑腿完成集成测试校区",
        slug: `it-errand-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        schoolName: "集成测试大学",
      },
    });
    campusId = campus.id;

    const category = await prisma.errandCategory.create({
      data: {
        name: "跑腿完成集成测试分类",
        slug: `it-errand-cat-${Date.now()}`,
        sortOrder: 999,
      },
    });
    categoryId = category.id;

    const [buyer, seller] = await Promise.all([
      prisma.user.create({
        data: {
          name: "errand-it-buyer",
          email: `errand-it-buyer-${Date.now()}@campus.local`,
          passwordHash: "test-only",
          schoolName: "集成测试大学",
          campusId,
          completedOrdersCount: 0,
        },
      }),
      prisma.user.create({
        data: {
          name: "errand-it-seller",
          email: `errand-it-seller-${Date.now()}@campus.local`,
          passwordHash: "test-only",
          schoolName: "集成测试大学",
          campusId,
          completedOrdersCount: 0,
        },
      }),
    ]);
    buyerId = buyer.id;
    sellerId = seller.id;
  });

  afterAll(async () => {
    if (!prisma) {
      return;
    }
    const campusUsers = await prisma.user.findMany({
      where: { campusId },
      select: { id: true },
    });
    const userIds = campusUsers.map((u) => u.id);

    // 原生客户端（无软删除扩展）：deleteMany 即物理删除
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.order.deleteMany({ where: { buyerId: { in: userIds } } });
    await prisma.errandTask.deleteMany({ where: { campusId } });
    await prisma.errandCategory.deleteMany({ where: { id: categoryId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.campus.deleteMany({ where: { id: campusId } });
    await prisma.$disconnect();
  });

  /** 建一对 (ErrandTask, Order)：任务状态与订单状态可分别指定 */
  async function createErrandWithOrder(options: {
    taskStatus: "IN_PROGRESS" | "PENDING_CONFIRMATION" | "COMPLETED";
    orderStatus: "IN_PROGRESS" | "COMPLETED";
  }) {
    orderSeq += 1;
    const task = await prisma.errandTask.create({
      data: {
        title: `跑腿完成集成测试 ${orderSeq}`,
        description: "exactly-once 集成测试任务",
        categoryId,
        reward: "8.00",
        pickupLocation: "测试取件点",
        deliveryLocation: "测试送达点",
        deadline: new Date(Date.now() + 3_600_000),
        status: options.taskStatus,
        publisherId: buyerId,
        accepterId: sellerId,
        campusId,
      },
    });

    const order = await prisma.order.create({
      data: {
        orderNo: `ITERRAND${Date.now()}${String(orderSeq).padStart(4, "0")}`,
        type: "ERRAND",
        status: options.orderStatus,
        paymentStatus: "OFFLINE_PENDING",
        amount: "8.00",
        meetingLocation: "测试面交点",
        buyerId,
        sellerId,
        errandTaskId: task.id,
      },
    });

    return { task, order };
  }

  async function readCounts() {
    const [buyer, seller] = await prisma.user.findMany({
      where: { id: { in: [buyerId, sellerId] } },
      select: { id: true, completedOrdersCount: true },
    });
    return {
      buyer: buyer!.completedOrdersCount,
      seller: seller!.completedOrdersCount,
    };
  }

  async function countCompletionNotifications(orderId: string) {
    return prisma.notification.count({
      where: { orderId, title: "跑腿订单已完成" },
    });
  }

  // 扩展客户端运行时满足事务客户端能力，类型差异为项目已知坑
  function txClient(): Prisma.TransactionClient {
    return prisma as unknown as Prisma.TransactionClient;
  }

  it("伪造/提前完成被硬闸门拒绝：状态、计数、通知全部不变", async () => {
    // 接单者已开始履约（Order IN_PROGRESS）但尚未提交完成（Task IN_PROGRESS）
    const { task, order } = await createErrandWithOrder({
      taskStatus: "IN_PROGRESS",
      orderStatus: "IN_PROGRESS",
    });
    const before = await readCounts();
    const notificationsBefore = await countCompletionNotifications(order.id);

    const result = await completeErrandOrderTx(txClient(), {
      orderId: order.id,
      errandTaskId: task.id,
      buyerId,
      sellerId,
    });

    expect(result).toEqual({ completed: false });

    const taskAfter = await prisma.errandTask.findUnique({ where: { id: task.id } });
    const orderAfter = await prisma.order.findUnique({ where: { id: order.id } });
    expect(taskAfter?.status).toBe("IN_PROGRESS");
    expect(orderAfter?.status).toBe("IN_PROGRESS");

    const after = await readCounts();
    expect(after.buyer).toBe(before.buyer);
    expect(after.seller).toBe(before.seller);
    expect(await countCompletionNotifications(order.id)).toBe(notificationsBefore);
  });

  it("并发完成 exactly-once：单胜者、计数恰好 +1、完成通知无重复", async () => {
    const { task, order } = await createErrandWithOrder({
      taskStatus: "PENDING_CONFIRMATION",
      orderStatus: "IN_PROGRESS",
    });
    const before = await readCounts();
    const notificationsBefore = await countCompletionNotifications(order.id);
    expect(notificationsBefore).toBe(0);

    // 并发触发两次 canonical completion（模拟双击 / 两个入口同时到达）
    const results = await Promise.all([
      runInTransaction((tx) =>
        completeErrandOrderTx(tx, {
          orderId: order.id,
          errandTaskId: task.id,
          buyerId,
          sellerId,
        }),
      ),
      runInTransaction((tx) =>
        completeErrandOrderTx(tx, {
          orderId: order.id,
          errandTaskId: task.id,
          buyerId,
          sellerId,
        }),
      ),
    ]);

    // 恰好一个胜者
    expect(results.filter((r) => r.completed)).toHaveLength(1);
    expect(results.filter((r) => !r.completed)).toHaveLength(1);

    const taskAfter = await prisma.errandTask.findUnique({ where: { id: task.id } });
    const orderAfter = await prisma.order.findUnique({ where: { id: order.id } });
    expect(taskAfter?.status).toBe("COMPLETED");
    expect(orderAfter?.status).toBe("COMPLETED");
    expect(orderAfter?.completedAt).not.toBeNull();

    // 计数恰好各 +1，不能 +2
    const after = await readCounts();
    expect(after.buyer).toBe(before.buyer + 1);
    expect(after.seller).toBe(before.seller + 1);

    // 完成通知：每个接收者恰好一条（共 2 条），无 duplicate
    expect(await countCompletionNotifications(order.id)).toBe(2);
    const perUser = await prisma.notification.groupBy({
      by: ["userId"],
      where: { orderId: order.id, title: "跑腿订单已完成" },
      _count: { userId: true },
    });
    expect(perUser).toHaveLength(2);
    for (const group of perUser) {
      expect(group._count.userId).toBe(1);
    }
  });

  it("重试幂等：已 COMPLETED 后再次提交完成不产生第二次副作用", async () => {
    const { task, order } = await createErrandWithOrder({
      taskStatus: "COMPLETED",
      orderStatus: "COMPLETED",
    });
    const before = await readCounts();
    const notificationsBefore = await countCompletionNotifications(order.id);
    expect(notificationsBefore).toBe(0); // 本用例的订单从未被完成过

    // 状态已 COMPLETED，任何入口再次触发都在闸门处 no-op
    const result = await completeErrandOrderTx(txClient(), {
      orderId: order.id,
      errandTaskId: task.id,
      buyerId,
      sellerId,
    });

    expect(result).toEqual({ completed: false });

    const taskAfter = await prisma.errandTask.findUnique({ where: { id: task.id } });
    const orderAfter = await prisma.order.findUnique({ where: { id: order.id } });
    expect(taskAfter?.status).toBe("COMPLETED");
    expect(orderAfter?.status).toBe("COMPLETED");

    const after = await readCounts();
    expect(after.buyer).toBe(before.buyer);
    expect(after.seller).toBe(before.seller);
    expect(await countCompletionNotifications(order.id)).toBe(notificationsBefore);
  });
});
