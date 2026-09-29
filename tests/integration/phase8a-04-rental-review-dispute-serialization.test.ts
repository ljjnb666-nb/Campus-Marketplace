import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { waitForAdvisoryLockWaiter } from "./helpers/lock-barrier";

// Phase 8A-04（P8-B04）Rental Review vs Dispute Serialization 集成测试
// （真实 PostgreSQL）。
//
// 关闭的缺口（Phase 8 Pre-flight 审计 P8-B04）：
//   submitRentalReviewTx 旧实现 = actor-only USER 锁 + 无行锁 findFirst，
//   与 initiateDisputeTx（sorted participant USER 锁 + RentalOrder FOR
//   UPDATE）没有共享 serialization point——COMPLETED 订单上 review 与
//   dispute 并发时 review 可能基于 stale 快照落库。
//
// 修复后合同（冻结）：
//   - review 与 dispute 同一核心锁序：candidate discovery（仅发现锁键）
//     → sorted USER owner+renter locks → actor ACTIVE 复核 →
//     RentalOrder FOR UPDATE → fresh 谓词（pre-read 非 authority）
//   - dispute 先赢 → review DENY（零 review / 零好评率 mutation / 零通知）
//   - review 先赢 → dispute 仍允许（合法串行历史；既有 review 保留，
//     不回滚/不隐藏——retroactive 处理属 Phase 8E Review Integrity）
//   - 提交评价 ≠ 放弃发起纠纷权利（review 存在不是 dispute eligibility 输入）
//   - 纵深防御：COMPLETED + active RentalDispute 异常 → DENY 新评价
//     （ordinary read，不取 RentalDispute 行锁，避免与 dispute
//     resolution 的 RentalDispute→RentalOrder 锁序成环）
//   - RB-03 seam 语义冻结（beforeLock = pair 锁前；afterCheck = pair 锁 +
//     actor 复核后、行锁前）；新增 afterOrderRowLock（fresh 谓词通过后、
//     写入前，生产不传）
//   - 双向评价保留：@@unique([orderId, authorId])，owner/renter 各评一次
//   - 全程 NO 40P01（racePoint / afterOrderRowLock seam + advisory waiter
//     轮询 barrier，零 sleep 排序）

vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p8a04-${randomUUID().slice(0, 8)}`;
const FIXTURE_PASSWORD_HASH = ["$2a$10$", "itfixtureitfixtureitfixtureitfixtureitfix"].join("");

const createdUserIds: string[] = [];
const createdCampusIds: string[] = [];
const createdMembershipIds: string[] = [];
const createdListingIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdOrderIds: string[] = [];
const createdDisputeIds: string[] = [];

let campusA: { id: string; name: string };

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

async function createCompletedOrderFixture(options: { ownerId: string; renterId: string }) {
  let category = await rawClient!.rentalCategory.findFirst({
    where: { slug: `it-${RUN_TAG}` },
  });
  if (!category) {
    category = await rawClient!.rentalCategory.create({
      data: {
        name: `IT 8A-04 夹具分类 ${RUN_TAG}`,
        slug: `it-${RUN_TAG}`,
        isActive: true,
      },
    });
    createdCategoryIds.push(category.id);
  }
  const listing = await rawClient!.rentalListing.create({
    data: {
      ownerId: options.ownerId,
      categoryId: category.id,
      campusId: campusA.id,
      title: `IT 8A-04 夹具 ${RUN_TAG}-${createdListingIds.length}`,
      description: "集成测试租赁物品",
      condition: "NORMAL_USED",
      price: 100,
      pricingUnit: "PER_DAY",
      depositAmount: 50,
      minimumDuration: 1,
      maximumDuration: 30,
      pickupLocation: "门口",
      returnLocation: "门口",
      status: "AVAILABLE",
    },
  });
  createdListingIds.push(listing.id);

  const now = new Date();
  const order = await rawClient!.rentalOrder.create({
    data: {
      orderNumber: `IT-${RUN_TAG}-${createdOrderIds.length}`,
      rentalListingId: listing.id,
      ownerId: options.ownerId,
      renterId: options.renterId,
      startTime: now,
      endTime: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      quantity: 1,
      unitPriceSnapshot: 100,
      pricingUnitSnapshot: "PER_DAY",
      rentalDuration: 1,
      rentalAmount: 100,
      depositAmount: 50,
      finalAmount: 150,
      paymentStatus: "OFFLINE_PENDING",
      depositStatus: "PENDING_PAYMENT",
      status: "COMPLETED",
      pickupLocationSnapshot: "门口",
      returnLocationSnapshot: "门口",
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

async function seedActiveDispute(options: { orderId: string; initiatorId: string }) {
  const now = new Date();
  const dispute = await rawClient!.rentalDispute.create({
    data: {
      orderId: options.orderId,
      initiatorId: options.initiatorId,
      reason: `集成测试纠纷 ${RUN_TAG}-${createdDisputeIds.length}`,
      evidencePhotos: [],
      status: "OPEN",
      campusId: campusA.id,
      scopeKey: `CAMPUS:${campusA.id}`,
      openedFromOrderStatus: "COMPLETED",
      dueAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
      createdAt: now,
    },
  });
  createdDisputeIds.push(dispute.id);
  return dispute;
}

/** NO_40P01：任何拒绝原因都不得是 PG deadlock / serialization failure。 */
function assertNoSerializationFailure(errors: unknown[]) {
  for (const error of errors) {
    const message = String((error as Error)?.message ?? error);
    expect(message).not.toContain("40P01");
    expect(message).not.toContain("deadlock detected");
  }
}

async function reviewNotificationCount(userId: string) {
  // 评价通知不带 orderId（RentalOrder 无通知 FK），以 title + 目标用户精确计数
  return rawClient!.notification.count({
    where: { userId, title: "收到新评价" },
  });
}

beforeAll(async () => {
  if (!integrationDatabaseUrl || !rawClient) {
    return;
  }
  campusA = await rawClient.campus.create({
    data: { name: `P8A04-A-${RUN_TAG}`, slug: `p8a04-a-${RUN_TAG}`, schoolName: "集成测试大学" },
  });
  createdCampusIds.push(campusA.id);
});

// §49：反向 FK 顺序清理（精确 fixture ID 域；禁止 silent catch 吞 cleanup
// failure）；Campus 最后删除 + 哨兵断言 fixture campus 归零。
afterAll(async () => {
  if (!rawClient) {
    return;
  }

  await rawClient.dataHold.deleteMany({
    where: { OR: [{ subjectId: { in: createdUserIds } }, { sourceId: { in: createdDisputeIds } }] },
  });
  await rawClient.rentalDispute.deleteMany({ where: { id: { in: createdDisputeIds } } });
  await rawClient.rentalReview.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await rawClient.rentalOrderStatusLog.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await rawClient.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await rawClient.rentalOrder.deleteMany({ where: { id: { in: createdOrderIds } } });
  await rawClient.rentalListing.deleteMany({ where: { id: { in: createdListingIds } } });
  await rawClient.rentalCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await rawClient.campusMembership.deleteMany({ where: { id: { in: createdMembershipIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await rawClient.campus.deleteMany({ where: { id: { in: createdCampusIds } } });

  // 哨兵：fixture campus 域完全归零（残留任何关联行时上面的 FK 删除已先失败）
  const remainingCampus = await rawClient.campus.count({
    where: { id: { in: createdCampusIds } },
  });
  expect(remainingCampus).toBe(0);

  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl)("Phase 8A-04 review vs dispute serialization（真实 PG）", () => {
  it("RD-01 baseline normal review：COMPLETED 订单 renter 评价成功，好评率/通知/订单状态一致", async () => {
    const owner = await createFixtureUser("RD01owner");
    const renter = await createFixtureUser("RD01renter");
    await rawClient!.user.update({
      where: { id: owner.id },
      data: { rentalPositiveRate: 0.83 },
    });
    const order = await createCompletedOrderFixture({ ownerId: owner.id, renterId: renter.id });

    const { withTransaction } = await import("@/lib/prisma");
    const { submitRentalReviewTx } = await import("@/lib/rental-order-machine");

    const result = await withTransaction(async (tx) =>
      submitRentalReviewTx(tx, {
        orderId: order.id,
        userId: renter.id,
        overallRating: 5,
        content: "RD-01 物品与描述一致",
      }),
    );
    expect(result).toEqual({ success: true });

    const review = await rawClient!.rentalReview.findFirstOrThrow({ where: { orderId: order.id } });
    expect(review.authorId).toBe(renter.id);
    expect(review.targetUserId).toBe(owner.id);
    expect(review.overallRating).toBe(5);

    // 好评率重算：1 条评价全部好评 → 1
    const target = await rawClient!.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(Number(target.rentalPositiveRate)).toBe(1);

    expect(await reviewNotificationCount(owner.id)).toBe(1);

    const finalOrder = await rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalOrder.status).toBe("COMPLETED");
  });

  it("RD-02 dispute first：dispute 先开（IN_DISPUTE）→ review DENY，零 review/零好评率/零评价通知", async () => {
    const owner = await createFixtureUser("RD02owner");
    const renter = await createFixtureUser("RD02renter");
    await rawClient!.user.update({
      where: { id: owner.id },
      data: { rentalPositiveRate: 0.5 },
    });
    const order = await createCompletedOrderFixture({ ownerId: owner.id, renterId: renter.id });

    const { withTransaction } = await import("@/lib/prisma");
    const { initiateDisputeTx, submitRentalReviewTx } = await import("@/lib/rental-order-machine");

    expect(
      await withTransaction(async (tx) =>
        initiateDisputeTx(tx, {
          orderId: order.id,
          userId: renter.id,
          reason: "RD-02 归还物品有损坏",
          evidencePhotos: [],
        }),
      ),
    ).toEqual({ success: true });

    const dispute = await rawClient!.rentalDispute.findFirstOrThrow({ where: { orderId: order.id } });
    createdDisputeIds.push(dispute.id);
    expect(dispute.status).toBe("OPEN");
    const disputedOrder = await rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(disputedOrder.status).toBe("IN_DISPUTE");

    const reviewResult = await withTransaction(async (tx) =>
      submitRentalReviewTx(tx, {
        orderId: order.id,
        userId: renter.id,
        overallRating: 5,
      }),
    );
    expect(reviewResult).toEqual({ error: "订单状态错误" });

    expect(await rawClient!.rentalReview.count({ where: { orderId: order.id } })).toBe(0);
    const target = await rawClient!.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(Number(target.rentalPositiveRate)).toBe(0.5);
    expect(await reviewNotificationCount(owner.id)).toBe(0);
  });

  it("RD-03 review then dispute：review 先提交 → dispute 仍允许（不弃权），既有 review 完整保留", async () => {
    const owner = await createFixtureUser("RD03owner");
    const renter = await createFixtureUser("RD03renter");
    const order = await createCompletedOrderFixture({ ownerId: owner.id, renterId: renter.id });

    const { withTransaction } = await import("@/lib/prisma");
    const { initiateDisputeTx, submitRentalReviewTx } = await import("@/lib/rental-order-machine");

    expect(
      await withTransaction(async (tx) =>
        submitRentalReviewTx(tx, {
          orderId: order.id,
          userId: renter.id,
          overallRating: 4,
        }),
      ),
    ).toEqual({ success: true });

    expect(
      await withTransaction(async (tx) =>
        initiateDisputeTx(tx, {
          orderId: order.id,
          userId: renter.id,
          reason: "RD-03 评价后补充纠纷",
          evidencePhotos: [],
        }),
      ),
    ).toEqual({ success: true });

    const dispute = await rawClient!.rentalDispute.findFirstOrThrow({ where: { orderId: order.id } });
    createdDisputeIds.push(dispute.id);
    expect(dispute.status).toBe("OPEN");
    // openedFromOrderStatus = 提交纠纷时的真实订单状态（COMPLETED）
    expect(dispute.openedFromOrderStatus).toBe("COMPLETED");

    // 既有 review 不被删除/隐藏
    const reviews = await rawClient!.rentalReview.findMany({ where: { orderId: order.id } });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.authorId).toBe(renter.id);

    const finalOrder = await rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalOrder.status).toBe("IN_DISPUTE");

    // dispute 常规副作用正常：双 holds + status log
    const holds = await rawClient!.dataHold.findMany({
      where: { sourceType: "RENTAL_DISPUTE", sourceId: dispute.id, status: "ACTIVE" },
    });
    expect(holds).toHaveLength(2);
    const logs = await rawClient!.rentalOrderStatusLog.findMany({
      where: { orderId: order.id, toStatus: "IN_DISPUTE" },
    });
    expect(logs).toHaveLength(1);
  });

  it("RD-04 owner and renter both review：双向评价保留（@@unique(orderId, authorId) 而非 orderId）", async () => {
    const owner = await createFixtureUser("RD04owner");
    const renter = await createFixtureUser("RD04renter");
    const order = await createCompletedOrderFixture({ ownerId: owner.id, renterId: renter.id });

    const { withTransaction } = await import("@/lib/prisma");
    const { submitRentalReviewTx } = await import("@/lib/rental-order-machine");

    expect(
      await withTransaction(async (tx) =>
        submitRentalReviewTx(tx, { orderId: order.id, userId: renter.id, overallRating: 5 }),
      ),
    ).toEqual({ success: true });
    expect(
      await withTransaction(async (tx) =>
        submitRentalReviewTx(tx, { orderId: order.id, userId: owner.id, overallRating: 4 }),
      ),
    ).toEqual({ success: true });

    const reviews = await rawClient!.rentalReview.findMany({ where: { orderId: order.id } });
    expect(reviews).toHaveLength(2);
    expect([...reviews.map((r) => r.authorId)].sort()).toEqual([owner.id, renter.id].sort());
    expect([...reviews.map((r) => r.targetUserId)].sort()).toEqual([owner.id, renter.id].sort());
  });

  it("RD-ANOMALY-01 active dispute anomaly：COMPLETED 订单 + OPEN dispute → DENY 新评价（纵深防御）", async () => {
    const owner = await createFixtureUser("RDAN01owner");
    const renter = await createFixtureUser("RDAN01renter");
    const order = await createCompletedOrderFixture({ ownerId: owner.id, renterId: renter.id });
    // 历史异常：订单保持 COMPLETED 但存在 active dispute（canonical invariant
    // 应为 active dispute ↔ IN_DISPUTE；defense-in-depth 不让异常继续产生评价）
    await seedActiveDispute({ orderId: order.id, initiatorId: renter.id });

    const { withTransaction } = await import("@/lib/prisma");
    const { submitRentalReviewTx } = await import("@/lib/rental-order-machine");

    const result = await withTransaction(async (tx) =>
      submitRentalReviewTx(tx, { orderId: order.id, userId: owner.id, overallRating: 1 }),
    );

    expect(result).toEqual({ error: "该订单存在进行中的纠纷，无法评价" });
    expect(await rawClient!.rentalReview.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("RD-RACE-01 dispute wins：T1 dispute 持锁挂起 → T2 review 真实等待（pg_locks）→ dispute 提交后 review DENY", async () => {
    const owner = await createFixtureUser("RACE01owner");
    const renter = await createFixtureUser("RACE01renter");
    await rawClient!.user.update({
      where: { id: owner.id },
      data: { rentalPositiveRate: 0.83 },
    });
    const order = await createCompletedOrderFixture({ ownerId: owner.id, renterId: renter.id });

    const { withTransaction } = await import("@/lib/prisma");
    const { initiateDisputeTx, submitRentalReviewTx } = await import("@/lib/rental-order-machine");

    // T1：dispute 取得 participant 锁 + RentalOrder 行锁后挂起（racePoint，生产不传）
    let signalT1Locked!: () => void;
    const t1Locked = new Promise<void>((resolve) => {
      signalT1Locked = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });
    const promiseT1 = withTransaction(async (tx) =>
      initiateDisputeTx(tx, {
        orderId: order.id,
        userId: renter.id,
        reason: "RD-RACE-01 竞态纠纷",
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
      submitRentalReviewTx(tx, { orderId: order.id, userId: renter.id, overallRating: 5 }),
    ).catch((error: unknown) => error);
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${owner.id}`, `USER:${renter.id}`]);

    releaseT1();
    const [resultT1, resultT2] = await Promise.allSettled([promiseT1, promiseT2]);

    assertNoSerializationFailure(
      [resultT1, resultT2]
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason),
    );

    expect(resultT1).toEqual({
      status: "fulfilled",
      value: { success: true },
    });
    // T2 醒来后 fresh re-read IN_DISPUTE → DENY（pre-read 快照不是 authority）
    expect(resultT2).toEqual({
      status: "fulfilled",
      value: { error: "订单状态错误" },
    });

    // 最终线性化状态：dispute 赢，review 零
    const disputes = await rawClient!.rentalDispute.findMany({ where: { orderId: order.id } });
    createdDisputeIds.push(...disputes.map((d) => d.id));
    const active = disputes.filter((d) => d.status === "OPEN" || d.status === "IN_REVIEW");
    expect(active).toHaveLength(1);

    expect(await rawClient!.rentalReview.count({ where: { orderId: order.id } })).toBe(0);
    const target = await rawClient!.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(Number(target.rentalPositiveRate)).toBe(0.83);
    expect(await reviewNotificationCount(owner.id)).toBe(0);

    const finalOrder = await rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalOrder.status).toBe("IN_DISPUTE");
  });

  it("RD-RACE-02 review wins：T1 review 持锁挂起（afterOrderRowLock）→ T2 dispute 真实等待 → 两者皆成功（合法串行）", async () => {
    const owner = await createFixtureUser("RACE02owner");
    const renter = await createFixtureUser("RACE02renter");
    const order = await createCompletedOrderFixture({ ownerId: owner.id, renterId: renter.id });

    const { withTransaction } = await import("@/lib/prisma");
    const { initiateDisputeTx, submitRentalReviewTx } = await import("@/lib/rental-order-machine");

    // T1：review 通过全部 fresh 谓词后挂起（afterOrderRowLock seam，生产不传）
    let signalT1Locked!: () => void;
    const t1Locked = new Promise<void>((resolve) => {
      signalT1Locked = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });
    const promiseT1 = withTransaction(async (tx) =>
      submitRentalReviewTx(
        tx,
        {
          orderId: order.id,
          userId: renter.id,
          overallRating: 5,
          afterOrderRowLock: async () => {
            signalT1Locked();
            await t1Gate;
          },
        },
      ),
    );
    await t1Locked;

    // T2：dispute 并发发起，阻塞在同一 participant 锁域（pg_locks waiter 证据）
    const promiseT2 = withTransaction(async (tx) =>
      initiateDisputeTx(tx, {
        orderId: order.id,
        userId: renter.id,
        reason: "RD-RACE-02 评价后纠纷",
        evidencePhotos: [],
      }),
    ).catch((error: unknown) => error);
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${owner.id}`, `USER:${renter.id}`]);

    releaseT1();
    const [resultT1, resultT2] = await Promise.allSettled([promiseT1, promiseT2]);

    assertNoSerializationFailure(
      [resultT1, resultT2]
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason),
    );

    // 合法串行历史：review committed THEN dispute initiated——两者都成功
    expect(resultT1).toEqual({ status: "fulfilled", value: { success: true } });
    expect(resultT2).toEqual({ status: "fulfilled", value: { success: true } });

    const reviews = await rawClient!.rentalReview.findMany({ where: { orderId: order.id } });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.authorId).toBe(renter.id);

    const disputes = await rawClient!.rentalDispute.findMany({ where: { orderId: order.id } });
    createdDisputeIds.push(...disputes.map((d) => d.id));
    const active = disputes.filter((d) => d.status === "OPEN" || d.status === "IN_REVIEW");
    expect(active).toHaveLength(1);

    const finalOrder = await rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalOrder.status).toBe("IN_DISPUTE");

    // review 侧副作用恰好一次；dispute 侧副作用正常
    expect(await reviewNotificationCount(owner.id)).toBe(1);
    const holds = await rawClient!.dataHold.findMany({
      where: { sourceType: "RENTAL_DISPUTE", sourceId: active[0]!.id, status: "ACTIVE" },
    });
    expect(holds).toHaveLength(2);
  });

  it("RD-RACE-03 same-author double review：同一 author 并发双评价 → 恰一条，另一条稳定「已经评价过」", async () => {
    const owner = await createFixtureUser("RACE03owner");
    const renter = await createFixtureUser("RACE03renter");
    const order = await createCompletedOrderFixture({ ownerId: owner.id, renterId: renter.id });

    const { withTransaction } = await import("@/lib/prisma");
    const { submitRentalReviewTx } = await import("@/lib/rental-order-machine");

    const results = await Promise.allSettled([
      withTransaction(async (tx) =>
        submitRentalReviewTx(tx, { orderId: order.id, userId: renter.id, overallRating: 5 }),
      ),
      withTransaction(async (tx) =>
        submitRentalReviewTx(tx, { orderId: order.id, userId: renter.id, overallRating: 1 }),
      ),
    ]);

    assertNoSerializationFailure(
      results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason),
    );

    const values = results.map((r) => (r as PromiseFulfilledResult<unknown>).value);
    expect(values.filter((v) => JSON.stringify(v) === JSON.stringify({ success: true }))).toHaveLength(1);
    expect(values.filter((v) => JSON.stringify(v) === JSON.stringify({ error: "已经评价过" }))).toHaveLength(1);

    const reviews = await rawClient!.rentalReview.findMany({ where: { orderId: order.id } });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.overallRating).toBe(5);
    expect(await reviewNotificationCount(owner.id)).toBe(1);
  });
});
