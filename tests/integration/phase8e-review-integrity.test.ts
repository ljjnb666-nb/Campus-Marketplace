import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { waitForAdvisoryLockWaiter } from "./helpers/lock-barrier";
import { isCanonicallyVisibleReview } from "@/lib/reviews/review-integrity";

// Phase 8E：General Review Integrity 集成测试（真实 PostgreSQL）。
//
// 关闭的缺口（Phase 8C 记录为 8E debt）：createReview 旧实现 = 事务外读
// Order + 事务内仅 lifecycle + Review.create + 事务外刷新 aggregate——与
// initiateOrderDisputeTx 无共享 serialization point（TOCTOU / review vs
// dispute race / client targetUserId authority / 非原子 aggregate）。
//
// 修复后合同（冻结）：
//   - submitOrderReviewTx 与 initiateOrderDisputeTx 同一核心锁序：
//     candidate discovery → sorted USER:buyer+seller locks → actor ACTIVE
//     → （ERRAND：ErrandTask FOR UPDATE →）Order FOR UPDATE → fresh 谓词
//   - 评价窗口 = completedAt + REVIEW_WINDOW 7d（now == deadline 即 DENY；
//     completedAt null fail closed）
//   - targetUserId 由锁内 Order 行推导（客户端 FormData 注入无效）
//   - dispute 先赢 → review DENY（零 review / 零通知 / 零缓存 mutation）
//   - review 先赢 → dispute 仍允许；review 保留但 canonical 隐藏
//   - 同一 author 并发双提交 → 恰一条 + 稳定 duplicate 拒绝
//   - buyer||seller 并发评价 → 线性化，双方 publishedAt 同 episode 非空
//   - 全程 NO 40P01（racePoint seam + advisory waiter barrier，零 sleep 排序）

vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p8e-${randomUUID().slice(0, 8)}`;
const FIXTURE_PASSWORD_HASH = ["$2a$10$", "itfixtureitfixtureitfixtureitfixtureitfix"].join("");

const createdUserIds: string[] = [];
const createdCampusIds: string[] = [];
const createdMembershipIds: string[] = [];
const createdOrderIds: string[] = [];
const createdDisputeIds: string[] = [];
const createdProductIds: string[] = [];
const createdErrandTaskIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdReviewIds: string[] = [];

let campusA: { id: string };

async function createFixtureUser(name: string) {
  const user = await rawClient!.user.create({
    data: {
      email: `${RUN_TAG}-${createdUserIds.length}-${name}@it.local`,
      name,
      passwordHash: FIXTURE_PASSWORD_HASH,
      schoolName: "集成测试大学",
      campusId: campusA.id,
      role: "STUDENT",
      status: "ACTIVE",
    },
  });
  createdUserIds.push(user.id);
  const membership = await rawClient!.campusMembership.create({
    data: { userId: user.id, campusId: campusA.id, status: "ACTIVE" },
  });
  createdMembershipIds.push(membership.id);
  return user;
}

async function createCompletedProductOrderFixture(options: {
  buyerId: string;
  sellerId: string;
  completedAt?: Date | null;
}) {
  let category = await rawClient!.productCategory.findFirst({
    where: { slug: `it-${RUN_TAG}` },
  });
  if (!category) {
    category = await rawClient!.productCategory.create({
      data: { name: `IT 8E 类目 ${RUN_TAG}`, slug: `it-${RUN_TAG}` },
    });
    createdCategoryIds.push(category.id);
  }
  const product = await rawClient!.product.create({
    data: {
      title: `P8E 商品 ${RUN_TAG}-${createdProductIds.length}`,
      description: "Phase 8E 集成夹具商品",
      price: 50,
      condition: "NEW",
      locationText: "集成测试楼",
      categoryId: category.id,
      campusId: campusA.id,
      sellerId: options.sellerId,
      status: "SOLD",
    },
  });
  createdProductIds.push(product.id);

  const order = await rawClient!.order.create({
    data: {
      orderNo: `P8E-${RUN_TAG}-${createdOrderIds.length}`,
      type: "PRODUCT",
      status: "COMPLETED",
      completedAt:
        options.completedAt === undefined ? new Date() : (options.completedAt ?? null),
      buyerId: options.buyerId,
      sellerId: options.sellerId,
      productId: product.id,
      amount: "50.00",
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

async function createCompletedErrandOrderFixture(options: {
  buyerId: string;
  sellerId: string;
}) {
  let category = await rawClient!.errandCategory.findFirst({
    where: { slug: `it-${RUN_TAG}` },
  });
  if (!category) {
    category = await rawClient!.errandCategory.create({
      data: { name: `IT 8E 跑腿类目 ${RUN_TAG}`, slug: `it-${RUN_TAG}` },
    });
    createdCategoryIds.push(category.id);
  }
  const task = await rawClient!.errandTask.create({
    data: {
      title: `P8E 跑腿 ${RUN_TAG}-${createdErrandTaskIds.length}`,
      description: "Phase 8E 集成夹具跑腿",
      reward: "10.00",
      pickupLocation: "东门",
      deliveryLocation: "西门",
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      status: "COMPLETED",
      publisherId: options.buyerId,
      accepterId: options.sellerId,
      campusId: campusA.id,
      categoryId: category.id,
    },
  });
  createdErrandTaskIds.push(task.id);

  const order = await rawClient!.order.create({
    data: {
      orderNo: `P8EE-${RUN_TAG}-${createdOrderIds.length}`,
      type: "ERRAND",
      status: "COMPLETED",
      completedAt: new Date(),
      buyerId: options.buyerId,
      sellerId: options.sellerId,
      errandTaskId: task.id,
      amount: "10.00",
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

/** NO_40P01：任何拒绝原因都不得是 PG deadlock / serialization failure。 */
function assertNoSerializationFailure(errors: unknown[]) {
  for (const error of errors) {
    const message = String((error as Error)?.message ?? error);
    expect(message).not.toContain("40P01");
    expect(message).not.toContain("deadlock detected");
  }
}

async function reviewNotificationCount(orderId: string) {
  return rawClient!.notification.count({
    where: { orderId, type: "REVIEW" },
  });
}

beforeAll(async () => {
  if (!integrationDatabaseUrl || !rawClient) {
    return;
  }
  campusA = await rawClient.campus.create({
    data: { name: `P8E-A-${RUN_TAG}`, slug: `p8e-a-${RUN_TAG}`, schoolName: "集成测试大学" },
  });
  createdCampusIds.push(campusA.id);
});

afterAll(async () => {
  if (!rawClient) {
    return;
  }

  await rawClient.dataHold.deleteMany({
    where: { OR: [{ subjectId: { in: createdUserIds } }, { sourceId: { in: createdDisputeIds } }] },
  });
  await rawClient.orderDispute.deleteMany({ where: { id: { in: createdDisputeIds } } });
  await rawClient.review.deleteMany({ where: { id: { in: createdReviewIds } } });
  await rawClient.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await rawClient.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await rawClient.errandTask.deleteMany({ where: { id: { in: createdErrandTaskIds } } });
  await rawClient.product.deleteMany({ where: { id: { in: createdProductIds } } });
  await rawClient.productCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await rawClient.errandCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await rawClient.campusMembership.deleteMany({ where: { id: { in: createdMembershipIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await rawClient.campus.deleteMany({ where: { id: { in: createdCampusIds } } });

  const remainingCampus = await rawClient.campus.count({
    where: { id: { in: createdCampusIds } },
  });
  expect(remainingCampus).toBe(0);

  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl)("Phase 8E general review integrity（真实 PG）", () => {
  it("RI-01 baseline：COMPLETED PRODUCT 买家评价成功，blindUntil = deadline、publishedAt null、零通知", async () => {
    const buyer = await createFixtureUser("RI01buyer");
    const seller = await createFixtureUser("RI01seller");
    const order = await createCompletedProductOrderFixture({ buyerId: buyer.id, sellerId: seller.id });

    const { withTransaction } = await import("@/lib/prisma");
    const { submitOrderReviewTx } = await import("@/lib/reviews/order-review-service");

    const result = await withTransaction(async (tx) =>
      submitOrderReviewTx(tx, {
        orderId: order.id,
        userId: buyer.id,
        rating: 5,
        content: "RI-01 很好",
        tags: ["守时"],
      }),
    );

    expect(result).toEqual({ success: true, targetUserId: seller.id, published: false });

    const review = await rawClient!.review.findFirstOrThrow({ where: { orderId: order.id } });
    createdReviewIds.push(review.id);
    expect(review.authorId).toBe(buyer.id);
    expect(review.targetUserId).toBe(seller.id);
    expect(review.blindUntil.getTime()).toBe(
      order.completedAt!.getTime() + 7 * 24 * 60 * 60 * 1000,
    );
    expect(review.publishedAt).toBeNull();
    expect(await reviewNotificationCount(order.id)).toBe(0);
  });

  it("RI-02 双方均提交 → 双方 publishedAt 同 episode 非空 + generic 通知", async () => {
    const buyer = await createFixtureUser("RI02buyer");
    const seller = await createFixtureUser("RI02seller");
    const order = await createCompletedProductOrderFixture({ buyerId: buyer.id, sellerId: seller.id });

    const { withTransaction } = await import("@/lib/prisma");
    const { submitOrderReviewTx } = await import("@/lib/reviews/order-review-service");

    expect(
      await withTransaction(async (tx) =>
        submitOrderReviewTx(tx, { orderId: order.id, userId: buyer.id, rating: 5 }),
      ),
    ).toEqual({ success: true, targetUserId: seller.id, published: false });

    expect(
      await withTransaction(async (tx) =>
        submitOrderReviewTx(tx, { orderId: order.id, userId: seller.id, rating: 1 }),
      ),
    ).toEqual({ success: true, targetUserId: buyer.id, published: true });

    const reviews = await rawClient!.review.findMany({ where: { orderId: order.id } });
    createdReviewIds.push(...reviews.map((r) => r.id));
    expect(reviews).toHaveLength(2);
    expect(reviews.every((r) => r.publishedAt !== null)).toBe(true);

    // §24：generic event 通知双方，不携带评分/内容/作者
    expect(await reviewNotificationCount(order.id)).toBe(2);
    const notifications = await rawClient!.notification.findMany({
      where: { orderId: order.id, type: "REVIEW" },
    });
    expect(
      notifications.every(
        (n) => n.title === "交易评价已公开" && !n.content.includes("5") && !n.content.includes("1"),
      ),
    ).toBe(true);
  });

  it("WINDOW-01..03：T+6d23h 允许；now == deadline DENY；deadline 之后 DENY", async () => {
    const buyer = await createFixtureUser("WIN1buyer");
    const seller = await createFixtureUser("WIN1seller");
    const completedAt = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000 - 23 * 60 * 60 * 1000);
    const order = await createCompletedProductOrderFixture({ buyerId: buyer.id, sellerId: seller.id, completedAt });

    const { withTransaction } = await import("@/lib/prisma");
    const { submitOrderReviewTx } = await import("@/lib/reviews/order-review-service");

    expect(
      await withTransaction(async (tx) =>
        submitOrderReviewTx(tx, { orderId: order.id, userId: buyer.id, rating: 5 }),
      ),
    ).toEqual({ success: true, targetUserId: seller.id, published: false });
    const review = await rawClient!.review.findFirstOrThrow({ where: { orderId: order.id } });
    createdReviewIds.push(review.id);

    // WINDOW-02/03：单方评价后窗口到期，对方提交被拒（同 author 已评的
    // duplicate 语义不同——这里用另一单验证纯窗口拒绝）
    const buyer2 = await createFixtureUser("WIN2buyer");
    const seller2 = await createFixtureUser("WIN2seller");
    const order2 = await createCompletedProductOrderFixture({
      buyerId: buyer2.id,
      sellerId: seller2.id,
      completedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    });
    expect(
      await withTransaction(async (tx) =>
        submitOrderReviewTx(tx, { orderId: order2.id, userId: buyer2.id, rating: 5 }),
      ),
    ).toEqual({ error: "评价期已结束（订单完成后 7 天内可评价）" });
    expect(await rawClient!.review.count({ where: { orderId: order2.id } })).toBe(0);
  });

  it("WINDOW-04：COMPLETED + completedAt null → fail closed DENY", async () => {
    const buyer = await createFixtureUser("WIN4buyer");
    const seller = await createFixtureUser("WIN4seller");
    const order = await createCompletedProductOrderFixture({
      buyerId: buyer.id,
      sellerId: seller.id,
      completedAt: null,
    });

    const { withTransaction } = await import("@/lib/prisma");
    const { submitOrderReviewTx } = await import("@/lib/reviews/order-review-service");

    expect(
      await withTransaction(async (tx) =>
        submitOrderReviewTx(tx, { orderId: order.id, userId: buyer.id, rating: 5 }),
      ),
    ).toEqual({ error: "只有已完成订单可以评价" });
    expect(await rawClient!.review.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("RI-RACE-01 dispute wins：T1 dispute 持锁挂起 → T2 review 真实等待（pg_locks）→ review DENY", async () => {
    const buyer = await createFixtureUser("RACE01buyer");
    const seller = await createFixtureUser("RACE01seller");
    const order = await createCompletedProductOrderFixture({ buyerId: buyer.id, sellerId: seller.id });

    const { withTransaction } = await import("@/lib/prisma");
    const { initiateOrderDisputeTx } = await import("@/lib/order-dispute-machine");
    const { submitOrderReviewTx } = await import("@/lib/reviews/order-review-service");

    // T1：dispute 取得 participant 锁 + Order 行锁后挂起（racePoint，生产不传）
    let signalT1Locked!: () => void;
    const t1Locked = new Promise<void>((resolve) => {
      signalT1Locked = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });
    const promiseT1 = withTransaction(async (tx) =>
      initiateOrderDisputeTx(tx, {
        orderId: order.id,
        userId: buyer.id,
        reason: "RI-RACE-01 竞态纠纷",
        evidencePhotos: [],
        racePoint: async () => {
          signalT1Locked();
          await t1Gate;
        },
      }),
    );
    await t1Locked;

    // T2：review 并发提交，必须阻塞在同一 participant 锁域（pg_locks waiter 证据）
    const promiseT2 = withTransaction(async (tx) =>
      submitOrderReviewTx(tx, { orderId: order.id, userId: seller.id, rating: 1 }),
    ).catch((error: unknown) => error);
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`, `USER:${seller.id}`]);

    releaseT1();
    const [resultT1, resultT2] = await Promise.allSettled([promiseT1, promiseT2]);

    assertNoSerializationFailure(
      [resultT1, resultT2]
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason),
    );

    // dispute 成功结果携带 locked Order type-FK 上下文（Phase 8C-02 合同）
    expect(resultT1).toEqual({
      status: "fulfilled",
      value: expect.objectContaining({ success: true }),
    });
    // T2 醒来后 fresh re-read：status != COMPLETED → DENY
    expect(resultT2).toEqual({
      status: "fulfilled",
      value: { error: "只有已完成订单可以评价" },
    });

    // 最终线性化状态：1 dispute、0 review、0 review 通知
    const disputes = await rawClient!.orderDispute.findMany({ where: { orderId: order.id } });
    createdDisputeIds.push(...disputes.map((d) => d.id));
    const active = disputes.filter((d) => d.status === "OPEN" || d.status === "IN_REVIEW");
    expect(active).toHaveLength(1);
    expect(await rawClient!.review.count({ where: { orderId: order.id } })).toBe(0);
    expect(await reviewNotificationCount(order.id)).toBe(0);

    const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalOrder.status).toBe("IN_DISPUTE");
  });

  it("RI-RACE-02 review wins：T1 review 持锁挂起 → T2 dispute 真实等待 → review 保留但 canonical 隐藏", async () => {
    const buyer = await createFixtureUser("RACE02buyer");
    const seller = await createFixtureUser("RACE02seller");
    const order = await createCompletedProductOrderFixture({ buyerId: buyer.id, sellerId: seller.id });

    const { withTransaction } = await import("@/lib/prisma");
    const { initiateOrderDisputeTx } = await import("@/lib/order-dispute-machine");
    const { submitOrderReviewTx } = await import("@/lib/reviews/order-review-service");

    // T1：review 通过全部 fresh 谓词后挂起（racePoint，生产不传）
    let signalT1Locked!: () => void;
    const t1Locked = new Promise<void>((resolve) => {
      signalT1Locked = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });
    const promiseT1 = withTransaction(async (tx) =>
      submitOrderReviewTx(tx, {
        orderId: order.id,
        userId: buyer.id,
        rating: 5,
        racePoint: async () => {
          signalT1Locked();
          await t1Gate;
        },
      }),
    );
    await t1Locked;

    const promiseT2 = withTransaction(async (tx) =>
      initiateOrderDisputeTx(tx, {
        orderId: order.id,
        userId: seller.id,
        reason: "RI-RACE-02 评价后纠纷",
        evidencePhotos: [],
      }),
    ).catch((error: unknown) => error);
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`, `USER:${seller.id}`]);

    releaseT1();
    const [resultT1, resultT2] = await Promise.allSettled([promiseT1, promiseT2]);

    assertNoSerializationFailure(
      [resultT1, resultT2]
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason),
    );

    // 合法串行历史：review 先提交，dispute 后发起——两者都成功
    expect(resultT1).toEqual({
      status: "fulfilled",
      value: { success: true, targetUserId: seller.id, published: false },
    });
    expect(resultT2).toEqual({
      status: "fulfilled",
      value: expect.objectContaining({ success: true }),
    });

    const reviews = await rawClient!.review.findMany({ where: { orderId: order.id } });
    createdReviewIds.push(...reviews.map((r) => r.id));
    expect(reviews).toHaveLength(1);

    const disputes = await rawClient!.orderDispute.findMany({ where: { orderId: order.id } });
    createdDisputeIds.push(...disputes.map((d) => d.id));
    const active = disputes.filter((d) => d.status === "OPEN" || d.status === "IN_REVIEW");
    expect(active).toHaveLength(1);

    const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalOrder.status).toBe("IN_DISPUTE");

    // Phase 8E §8/§17：review 保留（不删除）但 canonical visible = FALSE
    expect(
      isCanonicallyVisibleReview(reviews[0]!, {
        now: new Date(),
        orderStatus: finalOrder.status,
        hasActiveDispute: true,
      }),
    ).toBe(false);
    // blind 首评 → 零评价通知
    expect(await reviewNotificationCount(order.id)).toBe(0);
  });

  it("RI-RACE-03 same-author double submit：并发双评 → 恰一条，另一条稳定 duplicate 拒绝", async () => {
    const buyer = await createFixtureUser("RACE03buyer");
    const seller = await createFixtureUser("RACE03seller");
    const order = await createCompletedProductOrderFixture({ buyerId: buyer.id, sellerId: seller.id });

    const { withTransaction } = await import("@/lib/prisma");
    const { submitOrderReviewTx } = await import("@/lib/reviews/order-review-service");

    const ratings = [5, 1];
    const results = await Promise.allSettled([
      withTransaction(async (tx) =>
        submitOrderReviewTx(tx, { orderId: order.id, userId: buyer.id, rating: ratings[0]! }),
      ),
      withTransaction(async (tx) =>
        submitOrderReviewTx(tx, { orderId: order.id, userId: buyer.id, rating: ratings[1]! }),
      ),
    ]);

    assertNoSerializationFailure(
      results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason),
    );

    const successIndexes = results
      .map((r, index) => ({ r, index }))
      .filter(
        ({ r }) =>
          r.status === "fulfilled" &&
          (r as PromiseFulfilledResult<unknown>).value !== null &&
          typeof (r as PromiseFulfilledResult<{ success?: boolean }>).value === "object" &&
          (r as PromiseFulfilledResult<{ success?: boolean }>).value.success === true,
      );
    expect(successIndexes).toHaveLength(1);
    const duplicateIndexes = results
      .map((r, index) => ({ r, index }))
      .filter(
        ({ r }) =>
          r.status === "fulfilled" &&
          JSON.stringify((r as PromiseFulfilledResult<unknown>).value) ===
            JSON.stringify({ error: "你已经评价过该订单" }),
      );
    expect(duplicateIndexes).toHaveLength(1);

    const reviews = await rawClient!.review.findMany({ where: { orderId: order.id } });
    createdReviewIds.push(...reviews.map((r) => r.id));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.rating).toBe(ratings[successIndexes[0]!.index]);
    expect(await reviewNotificationCount(order.id)).toBe(0);
  });

  it("RI-RACE-04 buyer || seller 同时评价：线性化，2 rows 双方 publishedAt 非空，无 deadlock", async () => {
    const buyer = await createFixtureUser("RACE04buyer");
    const seller = await createFixtureUser("RACE04seller");
    const order = await createCompletedProductOrderFixture({ buyerId: buyer.id, sellerId: seller.id });

    const { withTransaction } = await import("@/lib/prisma");
    const { submitOrderReviewTx } = await import("@/lib/reviews/order-review-service");

    const results = await Promise.allSettled([
      withTransaction(async (tx) =>
        submitOrderReviewTx(tx, { orderId: order.id, userId: buyer.id, rating: 4 }),
      ),
      withTransaction(async (tx) =>
        submitOrderReviewTx(tx, { orderId: order.id, userId: seller.id, rating: 2 }),
      ),
    ]);

    assertNoSerializationFailure(
      results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason),
    );

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const reviews = await rawClient!.review.findMany({ where: { orderId: order.id } });
    createdReviewIds.push(...reviews.map((r) => r.id));
    expect(reviews).toHaveLength(2);
    expect([...reviews.map((r) => r.authorId)].sort()).toEqual([buyer.id, seller.id].sort());
    expect(reviews.every((r) => r.publishedAt !== null)).toBe(true);

    // 同一 publication episode：双方 publishedAt 同一事务写入（秒级精度一致）
    const publishedAts = reviews.map((r) => r.publishedAt!.getTime());
    expect(new Set(publishedAts).size).toBe(1);

    expect(await reviewNotificationCount(order.id)).toBe(2);
  });

  it("RI-ERRAND-01：COMPLETED Order + COMPLETED ErrandTask → 合法评价成功（锁序 ErrandTask → Order）", async () => {
    const buyer = await createFixtureUser("ERR01buyer");
    const seller = await createFixtureUser("ERR01seller");
    const order = await createCompletedErrandOrderFixture({ buyerId: buyer.id, sellerId: seller.id });

    const { withTransaction } = await import("@/lib/prisma");
    const { submitOrderReviewTx } = await import("@/lib/reviews/order-review-service");

    const result = await withTransaction(async (tx) =>
      submitOrderReviewTx(tx, { orderId: order.id, userId: seller.id, rating: 5 }),
    );

    expect(result).toEqual({ success: true, targetUserId: buyer.id, published: false });
    const review = await rawClient!.review.findFirstOrThrow({ where: { orderId: order.id } });
    createdReviewIds.push(review.id);
    expect(review.blindUntil.getTime()).toBe(
      order.completedAt!.getTime() + 7 * 24 * 60 * 60 * 1000,
    );
    expect(await reviewNotificationCount(order.id)).toBe(0);
  });

  it("RI-ERRAND-02 review wins on ERRAND：review 持锁挂起 → dispute 真实等待 → 皆成功，无 40P01", async () => {
    const buyer = await createFixtureUser("ERR02buyer");
    const seller = await createFixtureUser("ERR02seller");
    const order = await createCompletedErrandOrderFixture({ buyerId: buyer.id, sellerId: seller.id });

    const { withTransaction } = await import("@/lib/prisma");
    const { initiateOrderDisputeTx } = await import("@/lib/order-dispute-machine");
    const { submitOrderReviewTx } = await import("@/lib/reviews/order-review-service");

    let signalT1Locked!: () => void;
    const t1Locked = new Promise<void>((resolve) => {
      signalT1Locked = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });
    const promiseT1 = withTransaction(async (tx) =>
      submitOrderReviewTx(tx, {
        orderId: order.id,
        userId: buyer.id,
        rating: 5,
        racePoint: async () => {
          signalT1Locked();
          await t1Gate;
        },
      }),
    );
    await t1Locked;

    const promiseT2 = withTransaction(async (tx) =>
      initiateOrderDisputeTx(tx, {
        orderId: order.id,
        userId: seller.id,
        reason: "RI-ERRAND-02 评价后纠纷",
        evidencePhotos: [],
      }),
    ).catch((error: unknown) => error);
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`, `USER:${seller.id}`]);

    releaseT1();
    const [resultT1, resultT2] = await Promise.allSettled([promiseT1, promiseT2]);

    assertNoSerializationFailure(
      [resultT1, resultT2]
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason),
    );

    expect(resultT1).toEqual({
      status: "fulfilled",
      value: { success: true, targetUserId: seller.id, published: false },
    });
    expect(resultT2).toEqual({
      status: "fulfilled",
      value: expect.objectContaining({ success: true }),
    });

    const disputes = await rawClient!.orderDispute.findMany({ where: { orderId: order.id } });
    createdDisputeIds.push(...disputes.map((d) => d.id));
    expect(disputes).toHaveLength(1);
  });

  it("RI-ERRAND-03：Task 未 COMPLETED（pair 不合法）→ DENY，零写入", async () => {
    const buyer = await createFixtureUser("ERR03buyer");
    const seller = await createFixtureUser("ERR03seller");
    const order = await createCompletedErrandOrderFixture({ buyerId: buyer.id, sellerId: seller.id });
    // 异常夹具：Order COMPLETED 但 Task 漂移为 IN_PROGRESS
    await rawClient!.errandTask.update({
      where: { id: order.errandTaskId! },
      data: { status: "IN_PROGRESS" },
    });

    const { withTransaction } = await import("@/lib/prisma");
    const { submitOrderReviewTx } = await import("@/lib/reviews/order-review-service");

    expect(
      await withTransaction(async (tx) =>
        submitOrderReviewTx(tx, { orderId: order.id, userId: buyer.id, rating: 5 }),
      ),
    ).toEqual({ error: "只有已完成订单可以评价" });
    expect(await rawClient!.review.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("RI-CACHE-01：publication 时 stored positiveReviewRate 缓存按 visible-only 重算（原口径 avg/5）", async () => {
    const buyer = await createFixtureUser("CACH01buyer");
    const seller = await createFixtureUser("CACH01seller");
    await rawClient!.user.update({
      where: { id: seller.id },
      data: { positiveReviewRate: 0.5 },
    });
    const order = await createCompletedProductOrderFixture({ buyerId: buyer.id, sellerId: seller.id });

    const { withTransaction } = await import("@/lib/prisma");
    const { submitOrderReviewTx } = await import("@/lib/reviews/order-review-service");

    await withTransaction(async (tx) =>
      submitOrderReviewTx(tx, { orderId: order.id, userId: buyer.id, rating: 5 }),
    );
    // blind 首评：缓存零 mutation
    expect(Number((await rawClient!.user.findUniqueOrThrow({ where: { id: seller.id } })).positiveReviewRate)).toBe(0.5);

    await withTransaction(async (tx) =>
      submitOrderReviewTx(tx, { orderId: order.id, userId: seller.id, rating: 3 }),
    );
    // publication 后：seller 收到 1 条 visible 5 星 → avg/5 = 1（原口径冻结）
    expect(Number((await rawClient!.user.findUniqueOrThrow({ where: { id: seller.id } })).positiveReviewRate)).toBe(1);
    // buyer 收到 1 条 visible 3 星 → 3/5 = 0.6
    expect(Number((await rawClient!.user.findUniqueOrThrow({ where: { id: buyer.id } })).positiveReviewRate)).toBe(0.6);
  });
});
