import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  getPublishedGeneralReviewStats,
  getMyReviewsReadModel,
  getPublishedRentalReviewStats,
} from "@/lib/reviews/review-query";
import { getPublicTrustSnapshot } from "@/lib/trust/trust-snapshot";
import { submitOrderReviewTx } from "@/lib/reviews/order-review-service";
import { submitRentalReviewTx } from "@/lib/rental-order-machine";
import { resolveOrderDispute } from "@/lib/disputes/order-dispute-service";


// Phase 8E Commit 4：canonical review visibility 集成测试（真实 PostgreSQL）。
//
// 覆盖（§38 RR-BLIND/RR-DISPUTE、§40 VIS-01..06、§48 trust 快照不变性、
// §17 rental retroactive contract、§43 读失败分类——读写分离由同一 policy
// where 保证）：
//   - VIS-01 first review：作者可见（written 全量），target 不可见，
//     public aggregate 不变
//   - VIS-02 both reviewed：双方立即可见
//   - VIS-03 single review + blindUntil 过期：target 可见 + aggregate 纳入
//     （无 scheduler）
//   - VIS-04 active dispute：保留但 target/public/trust 不可见
//   - VIS-05 RESTORE_PREVIOUS → COMPLETED：恢复可见
//   - VIS-06 CLOSE_ORDER → CLOSED：不公开/不进 trust
//   - RR-*：RentalReview 同款合同（blind → 公开 → 纠纷隐藏 → 恢复/关闭）
//   - §48：隐藏 1-star 不改变 getPublicTrustSnapshot；公开后按原口径计算

vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p8e04-${randomUUID().slice(0, 8)}`;
const FIXTURE_PASSWORD_HASH = ["$2a$10$", "itfixtureitfixtureitfixtureitfixtureitfix"].join("");

const createdUserIds: string[] = [];
const createdCampusIds: string[] = [];
const createdMembershipIds: string[] = [];
const createdOrderIds: string[] = [];
const createdRentalOrderIds: string[] = [];
const createdProductIds: string[] = [];
const createdRentalListingIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdDisputeIds: string[] = [];
const createdReviewIds: string[] = [];
const createdRentalReviewIds: string[] = [];

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
  completedAt?: Date;
}) {
  let category = await rawClient!.productCategory.findFirst({
    where: { slug: `it-${RUN_TAG}` },
  });
  if (!category) {
    category = await rawClient!.productCategory.create({
      data: { name: `IT 8E04 类目 ${RUN_TAG}`, slug: `it-${RUN_TAG}` },
    });
    createdCategoryIds.push(category.id);
  }
  const product = await rawClient!.product.create({
    data: {
      title: `P8E04 商品 ${RUN_TAG}-${createdProductIds.length}`,
      description: "Phase 8E04 集成夹具商品",
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
      orderNo: `P8E04-${RUN_TAG}-${createdOrderIds.length}`,
      type: "PRODUCT",
      status: "COMPLETED",
      completedAt: options.completedAt ?? new Date(),
      buyerId: options.buyerId,
      sellerId: options.sellerId,
      productId: product.id,
      amount: "50.00",
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

async function createCompletedRentalOrderFixture(options: { ownerId: string; renterId: string }) {
  let category = await rawClient!.rentalCategory.findFirst({
    where: { slug: `it-${RUN_TAG}` },
  });
  if (!category) {
    category = await rawClient!.rentalCategory.create({
      data: { name: `IT 8E04 租赁类目 ${RUN_TAG}`, slug: `it-${RUN_TAG}`, isActive: true },
    });
    createdCategoryIds.push(category.id);
  }
  const listing = await rawClient!.rentalListing.create({
    data: {
      ownerId: options.ownerId,
      categoryId: category.id,
      campusId: campusA.id,
      title: `IT 8E04 夹具 ${RUN_TAG}-${createdRentalListingIds.length}`,
      description: "集成测试租赁物品",
      condition: "NORMAL_USED",
      price: 100,
      pricingUnit: "PER_DAY",
      depositAmount: 0,
      minimumDuration: 1,
      maximumDuration: 30,
      pickupLocation: "门口",
      returnLocation: "门口",
      status: "AVAILABLE",
    },
  });
  createdRentalListingIds.push(listing.id);

  const now = new Date();
  const order = await rawClient!.rentalOrder.create({
    data: {
      orderNumber: `IT-${RUN_TAG}-${createdRentalOrderIds.length}`,
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
      depositAmount: 0,
      finalAmount: 100,
      paymentStatus: "OFFLINE_PENDING",
      depositStatus: "NOT_REQUIRED",
      status: "COMPLETED",
      completedAt: now,
      pickupLocationSnapshot: "门口",
      returnLocationSnapshot: "门口",
    },
  });
  createdRentalOrderIds.push(order.id);
  return order;
}

async function seedActiveOrderDispute(options: { orderId: string; initiatorId: string }) {
  const now = new Date();
  const dispute = await rawClient!.orderDispute.create({
    data: {
      orderId: options.orderId,
      initiatorId: options.initiatorId,
      reason: `8E04 纠纷 ${RUN_TAG}-${createdDisputeIds.length}`,
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

/**
 * dispute.review reviewer fixture（Phase 7G seed 已固化 Permission——
 * 挂 CAMPUS-scoped 测试角色并 assignment 到本 campus，与 8C-01 同款）。
 */
async function requireDisputeReviewer(name: string) {
  const reviewer = await createFixtureUser(name);
  const role = await rawClient!.role.create({
    data: {
      key: `${RUN_TAG}_${randomUUID().slice(0, 8)}`,
      name: `8E04 reviewer ${randomUUID().slice(0, 6)}`,
      scope: "CAMPUS",
      isSystem: false,
      rolePermissions: {
        create: [{ permission: { connect: { key: "dispute.review" } } }],
      },
    },
  });
  await rawClient!.userRoleAssignment.create({
    data: { userId: reviewer.id, roleId: role.id, campusId: campusA.id, scopeKey: `CAMPUS:${campusA.id}` },
  });
  return reviewer;
}

/** 通过 canonical dispute 终局服务推进 General Order 状态（RESTORE_PREVIOUS / CLOSE_ORDER） */
async function resolveDisputeToTerminal(options: {
  disputeId: string;
  resolutionAction: "RESTORE_PREVIOUS" | "CLOSE_ORDER";
}) {
  const admin = await requireDisputeReviewer(`admin${createdUserIds.length}`);
  return resolveOrderDispute({
    actorId: admin.id,
    disputeId: options.disputeId,
    resolutionAction: options.resolutionAction,
    // RESTORE_PREVIOUS 走 RESOLVED（带中性 code）；CLOSE_ORDER 走 closeOrderDispute
    ...(options.resolutionAction === "RESTORE_PREVIOUS"
      ? { resolutionCode: "MUTUAL_AGREEMENT" as const }
      : {}),
  } as Parameters<typeof resolveOrderDispute>[0]);
}

beforeAll(async () => {
  if (!integrationDatabaseUrl || !rawClient) {
    return;
  }
  campusA = await rawClient.campus.create({
    data: { name: `P8E04-A-${RUN_TAG}`, slug: `p8e04-a-${RUN_TAG}`, schoolName: "集成测试大学" },
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
  await rawClient.rentalReview.deleteMany({ where: { id: { in: createdRentalReviewIds } } });
  await rawClient.adminLog.deleteMany({ where: { adminId: { in: createdUserIds } } });
  await rawClient.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await rawClient.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await rawClient.rentalOrder.deleteMany({ where: { id: { in: createdRentalOrderIds } } });
  await rawClient.product.deleteMany({ where: { id: { in: createdProductIds } } });
  await rawClient.rentalListing.deleteMany({ where: { id: { in: createdRentalListingIds } } });
  await rawClient.productCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await rawClient.errandCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await rawClient.rentalCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await rawClient.campusMembership.deleteMany({ where: { id: { in: createdMembershipIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await rawClient.campus.deleteMany({ where: { id: { in: createdCampusIds } } });

  const remainingCampus = await rawClient.campus.count({
    where: { id: { in: createdCampusIds } },
  });
  expect(remainingCampus).toBe(0);

  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl)("Phase 8E canonical visibility（真实 PG）", () => {
  it("VIS-01 first review：作者 written 可见、target received 不可见、public aggregate 不变", async () => {
    const buyer = await createFixtureUser("VIS01buyer");
    const seller = await createFixtureUser("VIS01seller");
    const order = await createCompletedProductOrderFixture({ buyerId: buyer.id, sellerId: seller.id });

    const { withTransaction } = await import("@/lib/prisma");
    await withTransaction(async (tx) =>
      submitOrderReviewTx(tx, { orderId: order.id, userId: buyer.id, rating: 1 }),
    );

    const review = await rawClient!.review.findFirstOrThrow({ where: { orderId: order.id } });
    createdReviewIds.push(review.id);

    const buyerView = await getMyReviewsReadModel(buyer.id);
    expect(buyerView.written).toHaveLength(1);
    expect(buyerView.written[0]!.rating).toBe(1);

    const sellerView = await getMyReviewsReadModel(seller.id);
    expect(sellerView.received).toHaveLength(0);

    // public aggregate 不变（blind 1-star 不进入）
    const stats = await getPublishedGeneralReviewStats(seller.id);
    expect(stats).toEqual({ count: 0, positiveRate: 0 });
    const snapshot = await getPublicTrustSnapshot(seller.id);
    expect(snapshot?.reviewSignals).toEqual({ positiveReviewRate: 0, receivedReviewsCount: 0 });
  });

  it("VIS-02 both reviewed：双方立即互相可见（含 1-star counterparty）", async () => {
    const buyer = await createFixtureUser("VIS02buyer");
    const seller = await createFixtureUser("VIS02seller");
    const order = await createCompletedProductOrderFixture({ buyerId: buyer.id, sellerId: seller.id });

    const { withTransaction } = await import("@/lib/prisma");
    await withTransaction(async (tx) =>
      submitOrderReviewTx(tx, { orderId: order.id, userId: buyer.id, rating: 1 }),
    );
    await withTransaction(async (tx) =>
      submitOrderReviewTx(tx, { orderId: order.id, userId: seller.id, rating: 5 }),
    );

    const reviews = await rawClient!.review.findMany({ where: { orderId: order.id } });
    createdReviewIds.push(...reviews.map((r) => r.id));

    const buyerView = await getMyReviewsReadModel(buyer.id);
    expect(buyerView.received).toHaveLength(1);
    expect(buyerView.received[0]!.rating).toBe(5);
    const sellerView = await getMyReviewsReadModel(seller.id);
    expect(sellerView.received).toHaveLength(1);
    expect(sellerView.received[0]!.rating).toBe(1);

    // §48 原口径：seller 收到 1 条 visible 1 星 → 1/5 = 0.2
    const stats = await getPublishedGeneralReviewStats(seller.id);
    expect(stats).toEqual({ count: 1, positiveRate: 0.2 });
  });

  it("VIS-03 single review + blindUntil 过期 → query-time 可见 + aggregate 纳入（无 scheduler）", async () => {
    const buyer = await createFixtureUser("VIS03buyer");
    const seller = await createFixtureUser("VIS03seller");
    const order = await createCompletedProductOrderFixture({ buyerId: buyer.id, sellerId: seller.id });

    const { withTransaction } = await import("@/lib/prisma");
    await withTransaction(async (tx) =>
      submitOrderReviewTx(tx, { orderId: order.id, userId: buyer.id, rating: 4 }),
    );
    const review = await rawClient!.review.findFirstOrThrow({ where: { orderId: order.id } });
    createdReviewIds.push(review.id);
    expect(await getMyReviewsReadModel(seller.id)).toMatchObject({ received: [] });

    // TEST-ONLY REVIEW WINDOW ADVANCE：把 blindUntil 推进到过去（不绕过
    // production submission service 创建评价）
    await rawClient!.review.update({
      where: { id: review.id },
      data: { blindUntil: new Date(Date.now() - 1000) },
    });

    const sellerView = await getMyReviewsReadModel(seller.id);
    expect(sellerView.received).toHaveLength(1);
    expect(sellerView.received[0]!.rating).toBe(4);

    const stats = await getPublishedGeneralReviewStats(seller.id);
    expect(stats).toEqual({ count: 1, positiveRate: 0.8 });
  });

  it("VIS-04/05 dispute 隐藏 → RESTORE_PREVIOUS 恢复可见（review 保留不删除）", async () => {
    const buyer = await createFixtureUser("VIS04buyer");
    const seller = await createFixtureUser("VIS04seller");
    const order = await createCompletedProductOrderFixture({ buyerId: buyer.id, sellerId: seller.id });

    const { withTransaction } = await import("@/lib/prisma");
    await withTransaction(async (tx) =>
      submitOrderReviewTx(tx, { orderId: order.id, userId: buyer.id, rating: 5 }),
    );
    const review = await rawClient!.review.findFirstOrThrow({ where: { orderId: order.id } });
    createdReviewIds.push(review.id);
    // 提前公开（双方 episode 已走）便于区分 dispute 隐藏与 blind 隐藏
    await rawClient!.review.update({
      where: { id: review.id },
      data: { publishedAt: new Date() },
    });

    const dispute = await seedActiveOrderDispute({ orderId: order.id, initiatorId: buyer.id });
    await rawClient!.order.update({ where: { id: order.id }, data: { status: "IN_DISPUTE" } });

    // IN_DISPUTE：review 保留但全读面隐藏
    expect(await rawClient!.review.count({ where: { orderId: order.id } })).toBe(1);
    expect((await getMyReviewsReadModel(seller.id)).received).toHaveLength(0);
    expect(await getPublishedGeneralReviewStats(seller.id)).toEqual({ count: 0, positiveRate: 0 });

    // RESTORE_PREVIOUS → COMPLETED：恢复可见（§17 不删除/不改写评价）
    await resolveDisputeToTerminal({ disputeId: dispute.id, resolutionAction: "RESTORE_PREVIOUS" });
    const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalOrder.status).toBe("COMPLETED");

    const sellerView = await getMyReviewsReadModel(seller.id);
    expect(sellerView.received).toHaveLength(1);
    expect(await getPublishedGeneralReviewStats(seller.id)).toEqual({ count: 1, positiveRate: 1 });
  });

  it("VIS-06 CLOSE_ORDER → CLOSED：review 历史保留但不公开/不进 trust", async () => {
    const buyer = await createFixtureUser("VIS06buyer");
    const seller = await createFixtureUser("VIS06seller");
    const order = await createCompletedProductOrderFixture({ buyerId: buyer.id, sellerId: seller.id });

    const { withTransaction } = await import("@/lib/prisma");
    await withTransaction(async (tx) =>
      submitOrderReviewTx(tx, { orderId: order.id, userId: buyer.id, rating: 1 }),
    );
    const review = await rawClient!.review.findFirstOrThrow({ where: { orderId: order.id } });
    createdReviewIds.push(review.id);
    await rawClient!.review.update({
      where: { id: review.id },
      data: { publishedAt: new Date() },
    });

    const dispute = await seedActiveOrderDispute({ orderId: order.id, initiatorId: buyer.id });
    await rawClient!.order.update({ where: { id: order.id }, data: { status: "IN_DISPUTE" } });

    await resolveDisputeToTerminal({ disputeId: dispute.id, resolutionAction: "CLOSE_ORDER" });
    const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalOrder.status).toBe("CLOSED");

    // review 行仍在（历史事实），但不进入任何公开/trust 读面
    expect(await rawClient!.review.count({ where: { orderId: order.id } })).toBe(1);
    expect((await getMyReviewsReadModel(seller.id)).received).toHaveLength(0);
    expect(await getPublishedGeneralReviewStats(seller.id)).toEqual({ count: 0, positiveRate: 0 });
    const snapshot = await getPublicTrustSnapshot(seller.id);
    expect(snapshot?.reviewSignals).toEqual({ positiveReviewRate: 0, receivedReviewsCount: 0 });
  });

  it("RR-BLIND-01/02 rental：首评 blind → 双评 publish；§48 rental 原口径聚合", async () => {
    const owner = await createFixtureUser("RR01owner");
    const renter = await createFixtureUser("RR01renter");
    const order = await createCompletedRentalOrderFixture({ ownerId: owner.id, renterId: renter.id });

    const { withTransaction } = await import("@/lib/prisma");
    await withTransaction(async (tx) =>
      submitRentalReviewTx(tx, { orderId: order.id, userId: renter.id, overallRating: 2 }),
    );

    const first = await rawClient!.rentalReview.findFirstOrThrow({ where: { orderId: order.id } });
    createdRentalReviewIds.push(first.id);
    // RR-BLIND-01：owner 不可见 + trust 不变
    expect((await getMyReviewsReadModel(owner.id)).received).toHaveLength(0);
    expect(await getPublishedRentalReviewStats(owner.id)).toEqual({ count: 0, positiveRate: 0 });

    // RR-BLIND-02：owner 提交 → 双方 published
    await withTransaction(async (tx) =>
      submitRentalReviewTx(tx, { orderId: order.id, userId: owner.id, overallRating: 5 }),
    );
    const reviews = await rawClient!.rentalReview.findMany({ where: { orderId: order.id } });
    expect(reviews).toHaveLength(2);
    expect(reviews.every((r) => r.publishedAt !== null)).toBe(true);

    // §48 原口径：owner 收到 1 条 visible（rating 2 < 4，非好评）→ 0/1 = 0
    expect(await getPublishedRentalReviewStats(owner.id)).toEqual({ count: 1, positiveRate: 0 });
    // renter 收到 1 条 5 星好评 → 1/1 = 1
    expect(await getPublishedRentalReviewStats(renter.id)).toEqual({ count: 1, positiveRate: 1 });

    const ownerView = await getMyReviewsReadModel(owner.id);
    expect(ownerView.received).toHaveLength(1);
    expect(ownerView.received[0]!.rating).toBe(2);
  });

  it("RR-DISPUTE-01..03 rental：review → dispute 隐藏 → RESTORE 恢复 / CLOSE 排除", async () => {
    const owner = await createFixtureUser("RRD1owner");
    const renter = await createFixtureUser("RRD1renter");
    const order = await createCompletedRentalOrderFixture({ ownerId: owner.id, renterId: renter.id });

    const { withTransaction } = await import("@/lib/prisma");
    const { initiateDisputeTx } = await import("@/lib/rental-order-machine");

    // 双方已公开的评价
    await withTransaction(async (tx) =>
      submitRentalReviewTx(tx, { orderId: order.id, userId: renter.id, overallRating: 5 }),
    );
    await withTransaction(async (tx) =>
      submitRentalReviewTx(tx, { orderId: order.id, userId: owner.id, overallRating: 4 }),
    );
    const reviews = await rawClient!.rentalReview.findMany({ where: { orderId: order.id } });
    createdRentalReviewIds.push(...reviews.map((r) => r.id));

    // RR-DISPUTE-01：review 后 dispute → 保留但隐藏
    expect(
      await withTransaction(async (tx) =>
        initiateDisputeTx(tx, {
          orderId: order.id,
          userId: renter.id,
          reason: "RR-DISPUTE-01 评价后纠纷",
          evidencePhotos: [],
        }),
      ),
    ).toEqual({ success: true });

    expect(await rawClient!.rentalReview.count({ where: { orderId: order.id } })).toBe(2);
    expect((await getMyReviewsReadModel(owner.id)).received).toHaveLength(0);
    expect(await getPublishedRentalReviewStats(owner.id)).toEqual({ count: 0, positiveRate: 0 });

    const dispute = await rawClient!.rentalDispute.findFirstOrThrow({ where: { orderId: order.id } });
    createdDisputeIds.push(dispute.id);
    await rawClient!.rentalOrder.update({
      where: { id: order.id },
      data: { status: "IN_DISPUTE" },
    });

    // RR-DISPUTE-02：RESTORE_PREVIOUS → COMPLETED → 恢复可见
    const { resolveDispute, closeDispute } = await import("@/lib/disputes/dispute-service");
    const admin = await requireDisputeReviewer("RRD1admin");
    await resolveDispute({
      actorId: admin.id,
      disputeId: dispute.id,
      resolutionCode: "MUTUAL_AGREEMENT",
      resolutionAction: "RESTORE_PREVIOUS",
    });
    expect((await rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "COMPLETED",
    );
    expect((await getMyReviewsReadModel(owner.id)).received).toHaveLength(1);
    expect(await getPublishedRentalReviewStats(owner.id)).toEqual({ count: 1, positiveRate: 1 });

    // RR-DISPUTE-03：再次 dispute + CLOSE_ORDER → 不再进入公开信号
    expect(
      await withTransaction(async (tx) =>
        initiateDisputeTx(tx, {
          orderId: order.id,
          userId: owner.id,
          reason: "RR-DISPUTE-03 二次纠纷",
          evidencePhotos: [],
        }),
      ),
    ).toEqual({ success: true });
    const dispute2 = await rawClient!.rentalDispute.findFirstOrThrow({
      where: { orderId: order.id, status: { in: ["OPEN", "IN_REVIEW"] } },
    });
    createdDisputeIds.push(dispute2.id);
    await rawClient!.rentalOrder.update({
      where: { id: order.id },
      data: { status: "IN_DISPUTE" },
    });
    await closeDispute({
      actorId: admin.id,
      disputeId: dispute2.id,
      resolutionAction: "CLOSE_ORDER",
    });
    expect((await rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "CLOSED",
    );
    expect(await rawClient!.rentalReview.count({ where: { orderId: order.id } })).toBe(2);
    expect((await getMyReviewsReadModel(owner.id)).received).toHaveLength(0);
    expect(await getPublishedRentalReviewStats(owner.id)).toEqual({ count: 0, positiveRate: 0 });
  });
});
