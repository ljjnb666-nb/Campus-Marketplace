import { randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { waitForAdvisoryLockWaiter } from "./helpers/lock-barrier";

// Phase 8D-01（P8-D01）General Order Meetup / MeetupPoint / No-show domain
// foundation 集成测试（真实 PostgreSQL）。
//
// 覆盖（指令 §36-§37）：
//   - custom location / MeetupPoint proposal → counterparty confirm；
//     locationTextSnapshot = transaction snapshot authority（point 改名不改写）
//   - 双向 self-arrival → Meetup COMPLETED（Order 仍 ACCEPTED / Product 仍
//     RESERVED / completedOrdersCount 不变）
//   - cancel → CANCELLED 后允许 reproposal（partial unique 语义）
//   - no-show → Meetup NO_SHOW_REPORTED + OrderDispute OPEN + Order
//     IN_DISPUTE + triggeredDisputeId + 2 source-linked DataHolds（同一事务
//     原子）；PRODUCT 保持 RESERVED
//   - 边界：cross-campus point / ERRAND / 已有 manual dispute → 零 mutation
//   - 隐私：custom location 快照随作者注销 REDACT；catalog 快照保留
//   - Races（pg_locks waiter barrier，零 sleep，NO 40P01）：
//     double proposal / confirm vs cancel / arrival vs no-show /
//     PRODUCT completion vs no-show（双向）/ manual dispute vs no-show（双向）

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

const RUN_TAG = `p8d01-${randomUUID().slice(0, 8)}`;

const createdUserIds: string[] = [];
const createdProductIds: string[] = [];
const createdServiceIds: string[] = [];
const createdErrandIds: string[] = [];
const createdOrderIds: string[] = [];
const createdMembershipIds: string[] = [];
const createdDisputeIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdServiceCategoryIds: string[] = [];
const createdErrandCategoryIds: string[] = [];
const createdPointIds: string[] = [];
const createdMeetupIds: string[] = [];

let campusId = "";

let fixtureSeq = 0;

const HOUR = 60 * 60 * 1000;

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
  createdUserIds.push(user.id);
  const membership = await rawClient!.campusMembership.create({
    data: { userId: user.id, campusId, status: "ACTIVE" },
  });
  createdMembershipIds.push(membership.id);
  return user;
}

async function createProductFixture(sellerId: string) {
  const category = await rawClient!.productCategory.create({
    data: { name: `8D01类目-${randomUUID().slice(0, 8)}`, slug: `p8d01-${randomUUID().slice(0, 8)}` },
  });
  createdCategoryIds.push(category.id);
  const product = await rawClient!.product.create({
    data: {
      title: `8D01 商品 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8D-01 fixture",
      price: 10,
      condition: "NEW",
      locationText: "东门",
      categoryId: category.id,
      campusId,
      sellerId,
      status: "ACTIVE",
    },
  });
  createdProductIds.push(product.id);
  return product;
}

async function createServiceFixture(providerId: string) {
  const service = await rawClient!.serviceListing.create({
    data: {
      title: `8D01 服务 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8D-01 fixture",
      price: 20,
      pricingUnit: "PER_SESSION",
      locationText: "东门",
      providerId,
      campusId,
      categoryId: (await rawClient!.serviceCategory.create({
        data: { name: `8D01服务类目-${randomUUID().slice(0, 8)}`, slug: `p8d01-svc-${randomUUID().slice(0, 8)}` },
      })).id,
      status: "ACTIVE",
    },
  });
  createdServiceIds.push(service.id);
  createdServiceCategoryIds.push(
    (await rawClient!.serviceListing.findUniqueOrThrow({ where: { id: service.id }, select: { categoryId: true } }))
      .categoryId,
  );
  return service;
}

async function createErrandFixture(publisherId: string, accepterId: string) {
  const category = await rawClient!.errandCategory.create({
    data: { name: `8D01跑腿类目-${randomUUID().slice(0, 8)}`, slug: `p8d01-err-${randomUUID().slice(0, 8)}` },
  });
  createdErrandCategoryIds.push(category.id);
  const errand = await rawClient!.errandTask.create({
    data: {
      title: `8D01 跑腿 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8D-01 fixture",
      categoryId: category.id,
      reward: "10.00",
      pickupLocation: "北门",
      deliveryLocation: "南门",
      deadline: new Date(Date.now() + 24 * HOUR),
      publisherId,
      accepterId,
      campusId,
      status: "CLAIMED",
    },
  });
  createdErrandIds.push(errand.id);
  return errand;
}

async function createGeneralOrder(input: {
  type: "PRODUCT" | "SERVICE" | "ERRAND";
  buyerId: string;
  sellerId: string;
  productId?: string | null;
  serviceListingId?: string | null;
  errandTaskId?: string | null;
  status: string;
}) {
  const order = await rawClient!.order.create({
    data: {
      orderNo: `${RUN_TAG}${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
      type: input.type,
      status: input.status as never,
      buyerId: input.buyerId,
      sellerId: input.sellerId,
      productId: input.productId ?? null,
      serviceListingId: input.serviceListingId ?? null,
      errandTaskId: input.errandTaskId ?? null,
      amount: "10.00",
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

/** 真实 PRODUCT 下单（createProductOrderTx 完整事务链，Product → RESERVED）。 */
async function placeRealOrder(input: {
  buyerId: string;
  product: { id: string; price: string; sellerId: string; campusId: string };
}) {
  const { createProductOrderTx } = await import("@/lib/order-creation");
  const { withTransaction } = await import("@/lib/prisma");
  const order = await withTransaction((tx: Prisma.TransactionClient) =>
    createProductOrderTx(tx, {
      buyerId: input.buyerId,
      product: input.product,
      meetingLocation: "东门",
      note: null,
    }),
  );
  if (order) createdOrderIds.push(order.id);
  return order;
}

async function transitionOrder(
  actorId: string,
  orderId: string,
  requestedStatus: "ACCEPTED" | "COMPLETED",
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

async function createMeetupPoint(input: {
  campusId: string;
  name?: string;
  locationText?: string;
  isActive?: boolean;
}) {
  const point = await rawClient!.meetupPoint.create({
    data: {
      campusId: input.campusId,
      name: input.name ?? `8D01见面点-${randomUUID().slice(0, 6)}`,
      locationText: input.locationText ?? "图书馆北门台阶",
      isActive: input.isActive ?? true,
    },
  });
  createdPointIds.push(point.id);
  return point;
}

// ---- canonical service wrappers（withTransaction → Tx service）----

async function proposeMeetup(
  input: {
    orderId: string;
    proposerId: string;
    scheduledAt?: Date;
    meetupPointId?: string | null;
    locationText?: string | null;
  },
  options?: { beforeSubjectLocks?: () => Promise<void>; racePoint?: () => Promise<void> },
) {
  const { proposeOrderMeetupTx } = await import("@/lib/meetups/order-meetup-service");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    proposeOrderMeetupTx(
      tx,
      {
        orderId: input.orderId,
        proposerId: input.proposerId,
        scheduledAt: input.scheduledAt ?? new Date(Date.now() + HOUR),
        meetupPointId: input.meetupPointId ?? null,
        locationText: input.locationText ?? null,
      },
      {
        beforeSubjectLocks: options?.beforeSubjectLocks,
        racePoint: options?.racePoint,
      },
    ),
  ).then((outcome) => {
    if ("success" in outcome && outcome.success) createdMeetupIds.push(outcome.meetupId);
    return outcome;
  });
}

async function confirmMeetup(
  input: { orderId: string; meetupId: string; confirmerId: string },
  options?: { racePoint?: () => Promise<void> },
) {
  const { confirmOrderMeetupTx } = await import("@/lib/meetups/order-meetup-service");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    confirmOrderMeetupTx(tx, input, { racePoint: options?.racePoint }),
  );
}

async function cancelMeetup(input: { orderId: string; meetupId: string; actorId: string }) {
  const { cancelOrderMeetupTx } = await import("@/lib/meetups/order-meetup-service");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    cancelOrderMeetupTx(tx, input),
  );
}

async function arriveMeetup(input: { orderId: string; meetupId: string; actorId: string }) {
  const { markOrderMeetupArrivalTx } = await import("@/lib/meetups/order-meetup-service");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    markOrderMeetupArrivalTx(tx, input),
  );
}

async function reportNoShow(
  input: { orderId: string; meetupId: string; reporterId: string },
  options?: { racePoint?: () => Promise<void> },
) {
  const { reportOrderMeetupNoShowTx } = await import("@/lib/meetups/order-meetup-service");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    reportOrderMeetupNoShowTx(tx, input, { racePoint: options?.racePoint }),
  );
}

async function initiateDisputeRaw(orderId: string, userId: string, racePoint?: () => Promise<void>) {
  const { initiateOrderDisputeTx } = await import("@/lib/order-dispute-machine");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction(async (tx: Prisma.TransactionClient) =>
    initiateOrderDisputeTx(tx, { orderId, userId, reason: "race", evidencePhotos: [], racePoint }),
  );
}

// ---- fixture 状态推进 helpers ----

/** 时间旅行（fixture 直控；scheduledAt 无 CHECK 约束） */
async function setScheduledAt(meetupId: string, scheduledAt: Date) {
  await rawClient!.orderMeetup.update({ where: { id: meetupId }, data: { scheduledAt } });
}

/** propose(buyer) → confirm(seller) → 时间旅行到指定时刻 */
async function confirmedMeetup(input: {
  orderId: string;
  buyerId: string;
  sellerId: string;
  scheduledAt: Date;
  locationText?: string;
  meetupPointId?: string;
}) {
  const proposed = await proposeMeetup({
    orderId: input.orderId,
    proposerId: input.buyerId,
    locationText: input.locationText ?? "东门快递柜旁",
    meetupPointId: input.meetupPointId ?? null,
  });
  expect(proposed).toMatchObject({ success: true });
  const meetupId = (proposed as { meetupId: string }).meetupId;
  expect(await confirmMeetup({ orderId: input.orderId, meetupId, confirmerId: input.sellerId })).toMatchObject({
    success: true,
  });
  await setScheduledAt(meetupId, input.scheduledAt);
  return meetupId;
}

function trackHolds(disputeId: string) {
  return rawClient!.dataHold.findMany({
    where: { sourceType: "ORDER_DISPUTE", sourceId: disputeId, status: "ACTIVE" },
  });
}

async function activeMeetupCount(orderId: string) {
  return rawClient!.orderMeetup.count({
    where: { orderId, status: { in: ["PROPOSED", "CONFIRMED", "COMPLETED", "NO_SHOW_REPORTED"] } },
  });
}

function assertNoSerializationFailure(errors: unknown[]) {
  for (const error of errors) {
    const message = String((error as Error)?.message ?? error);
    expect(message).not.toContain("40P01");
    expect(message).not.toContain("deadlock detected");
  }
}

function rejectedReasons(results: PromiseSettledResult<unknown>[]) {
  return results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason);
}

beforeAll(async () => {
  if (!integrationDatabaseUrl || !rawClient) return;

  const campus = await rawClient.campus.create({
    data: { name: `P8D01-A-${RUN_TAG}`, slug: `p8d01-a-${randomUUID().slice(0, 8)}`, schoolName: "集成测试大学" },
  });
  campusId = campus.id;
});

afterAll(async () => {
  if (!rawClient) return;

  // §38：严格反向 FK 清理；禁止 silent catch；Campus 最后删除 + sentinel
  await rawClient.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await rawClient.dataHold.deleteMany({ where: { subjectType: "USER", subjectId: { in: createdUserIds } } });
  await rawClient.orderMeetup.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await rawClient.orderDispute.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  if (createdOrderIds.length > 0) {
    await rawClient.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  }
  await rawClient.meetupPoint.deleteMany({ where: { id: { in: createdPointIds } } });
  await rawClient.product.deleteMany({ where: { id: { in: createdProductIds } } });
  await rawClient.serviceListing.deleteMany({ where: { id: { in: createdServiceIds } } });
  await rawClient.errandTask.deleteMany({ where: { id: { in: createdErrandIds } } });
  await rawClient.productCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await rawClient.serviceCategory.deleteMany({ where: { id: { in: createdServiceCategoryIds } } });
  await rawClient.errandCategory.deleteMany({ where: { id: { in: createdErrandCategoryIds } } });
  await rawClient.campusMembership.deleteMany({ where: { userId: { in: createdUserIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } });
  const campusDelete = await rawClient.campus.deleteMany({ where: { id: campusId } });
  expect(campusDelete.count).toBe(1);
  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl)("Phase 8D-01 meetup domain（真实 PG）", () => {
  it("D01-PG-01：custom location proposal → counterparty confirm（snapshot 固化 + campus 权威）", async () => {
    const seller = await createFixtureUser("PG01卖家");
    const buyer = await createFixtureUser("PG01买家");
    const service = await createServiceFixture(seller.id);
    const order = await createGeneralOrder({
      type: "SERVICE", buyerId: buyer.id, sellerId: seller.id,
      serviceListingId: service.id, status: "ACCEPTED",
    });

    const proposed = await proposeMeetup({
      orderId: order.id,
      proposerId: buyer.id,
      locationText: "  东门快递柜旁  ",
    });
    expect(proposed).toMatchObject({
      success: true,
      campusId,
      locationTextSnapshot: "东门快递柜旁",
      status: "PROPOSED",
    });
    const meetupId = (proposed as { meetupId: string }).meetupId;

    const stored = await rawClient!.orderMeetup.findUniqueOrThrow({ where: { id: meetupId } });
    expect(stored.status).toBe("PROPOSED");
    expect(stored.campusId).toBe(campusId); // 交易标的（ServiceListing）campus
    expect(stored.meetupPointId).toBeNull();
    expect(stored.proposedById).toBe(buyer.id);
    expect(stored.confirmedById).toBeNull();

    // proposer 自确认 DENY；counterparty 确认成功
    expect(
      await confirmMeetup({ orderId: order.id, meetupId, confirmerId: buyer.id }),
    ).toMatchObject({ error: "MEETUP_FORBIDDEN" });
    expect(
      await confirmMeetup({ orderId: order.id, meetupId, confirmerId: seller.id }),
    ).toEqual({ success: true, status: "CONFIRMED" });

    const confirmedRow = await rawClient!.orderMeetup.findUniqueOrThrow({ where: { id: meetupId } });
    expect(confirmedRow.status).toBe("CONFIRMED");
    expect(confirmedRow.confirmedById).toBe(seller.id);
    expect(confirmedRow.confirmedAt).not.toBeNull();
    expect(confirmedRow.cancelledAt).toBeNull();
  });

  it("D01-PG-02/03：MeetupPoint proposal 用 immutable snapshot；point 改名不改写历史", async () => {
    const seller = await createFixtureUser("PG02卖家");
    const buyer = await createFixtureUser("PG02买家");
    const product = await createProductFixture(seller.id);
    const order = await placeRealOrder({
      buyerId: buyer.id,
      product: { id: product.id, price: "10", sellerId: seller.id, campusId },
    });
    expect(order).not.toBeNull();
    expect(await transitionOrder(seller.id, order!.id, "ACCEPTED")).not.toBeNull();

    const point = await createMeetupPoint({ campusId, locationText: "图书馆北门台阶" });
    const proposed = await proposeMeetup({
      orderId: order!.id,
      proposerId: buyer.id,
      meetupPointId: point.id,
      locationText: "客户端伪造地点",
    });
    expect(proposed).toMatchObject({ success: true, locationTextSnapshot: "图书馆北门台阶" });
    const meetupId = (proposed as { meetupId: string }).meetupId;

    const stored = await rawClient!.orderMeetup.findUniqueOrThrow({ where: { id: meetupId } });
    expect(stored.meetupPointId).toBe(point.id);
    expect(stored.locationTextSnapshot).toBe("图书馆北门台阶");

    // point 改名 / 停用：历史 snapshot 不变
    await rawClient!.meetupPoint.update({
      where: { id: point.id },
      data: { locationText: "改名的南门", isActive: false },
    });
    const afterRename = await rawClient!.orderMeetup.findUniqueOrThrow({ where: { id: meetupId } });
    expect(afterRename.locationTextSnapshot).toBe("图书馆北门台阶");
    expect(afterRename.meetupPointId).toBe(point.id);
  });

  it("D01-PG-04：buyer + seller 依次 self-arrival → Meetup COMPLETED；Order 仍 ACCEPTED / Product 仍 RESERVED / 计数不变", async () => {
    const seller = await createFixtureUser("PG04卖家");
    const buyer = await createFixtureUser("PG04买家");
    const product = await createProductFixture(seller.id);
    const order = await placeRealOrder({
      buyerId: buyer.id,
      product: { id: product.id, price: "10", sellerId: seller.id, campusId },
    });
    expect(order).not.toBeNull();
    expect(await transitionOrder(seller.id, order!.id, "ACCEPTED")).not.toBeNull();

    const countsBefore = await rawClient!.user.findMany({
      where: { id: { in: [buyer.id, seller.id] } },
      select: { id: true, completedOrdersCount: true },
    });

    const meetupId = await confirmedMeetup({
      orderId: order!.id,
      buyerId: buyer.id,
      sellerId: seller.id,
      scheduledAt: new Date(Date.now() - HOUR),
    });

    // 提前 arrival 已由时间旅行排除（scheduledAt 已是过去）；买家先到
    expect(await arriveMeetup({ orderId: order!.id, meetupId, actorId: buyer.id })).toEqual({
      success: true,
      status: "CONFIRMED",
      alreadyArrived: false,
    });
    // 重复 arrival 幂等
    expect(await arriveMeetup({ orderId: order!.id, meetupId, actorId: buyer.id })).toEqual({
      success: true,
      status: "CONFIRMED",
      alreadyArrived: true,
    });

    const afterBuyer = await rawClient!.orderMeetup.findUniqueOrThrow({ where: { id: meetupId } });
    expect(afterBuyer.status).toBe("CONFIRMED");
    expect(afterBuyer.buyerArrivedAt).not.toBeNull();
    expect(afterBuyer.sellerArrivedAt).toBeNull();

    // 卖家后到 → COMPLETED
    expect(await arriveMeetup({ orderId: order!.id, meetupId, actorId: seller.id })).toEqual({
      success: true,
      status: "COMPLETED",
      alreadyArrived: false,
    });

    const completed = await rawClient!.orderMeetup.findUniqueOrThrow({ where: { id: meetupId } });
    expect(completed.status).toBe("COMPLETED");
    expect(completed.buyerArrivedAt).not.toBeNull();
    expect(completed.sellerArrivedAt).not.toBeNull();

    // Order / Product / 计数全部不动（OrderMeetup.COMPLETED != Order.COMPLETED）
    const orderAfter = await rawClient!.order.findUniqueOrThrow({ where: { id: order!.id } });
    expect(orderAfter.status).toBe("ACCEPTED");
    const productAfter = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(productAfter.status).toBe("RESERVED");
    const countsAfter = await rawClient!.user.findMany({
      where: { id: { in: [buyer.id, seller.id] } },
      select: { id: true, completedOrdersCount: true },
    });
    expect(countsAfter).toEqual(countsBefore);
  });

  it("D01-PG-05：cancel → CANCELLED 后允许 reproposal（恰一个 active）", async () => {
    const seller = await createFixtureUser("PG05卖家");
    const buyer = await createFixtureUser("PG05买家");
    const service = await createServiceFixture(seller.id);
    const order = await createGeneralOrder({
      type: "SERVICE", buyerId: buyer.id, sellerId: seller.id,
      serviceListingId: service.id, status: "ACCEPTED",
    });

    const first = await proposeMeetup({ orderId: order.id, proposerId: buyer.id, locationText: "北门" });
    expect(first).toMatchObject({ success: true });
    const firstId = (first as { meetupId: string }).meetupId;
    expect(
      await confirmMeetup({ orderId: order.id, meetupId: firstId, confirmerId: seller.id }),
    ).toMatchObject({ success: true });

    expect(
      await cancelMeetup({ orderId: order.id, meetupId: firstId, actorId: seller.id }),
    ).toEqual({ success: true, status: "CANCELLED" });

    const cancelled = await rawClient!.orderMeetup.findUniqueOrThrow({ where: { id: firstId } });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelledById).toBe(seller.id);
    expect(cancelled.cancelledAt).not.toBeNull();

    // active 唯一性：CANCELLED 不占位 → 第二次 proposal 成功
    expect(await activeMeetupCount(order.id)).toBe(0);
    const second = await proposeMeetup({ orderId: order.id, proposerId: seller.id, locationText: "南门" });
    expect(second).toMatchObject({ success: true, locationTextSnapshot: "南门" });
    expect(await activeMeetupCount(order.id)).toBe(1);

    // total = 2（CANCELLED 历史 + 新 active）
    expect(await rawClient!.orderMeetup.count({ where: { orderId: order.id } })).toBe(2);
  });

  it("D01-PG-06：no-show → NO_SHOW_REPORTED + OrderDispute OPEN + Order IN_DISPUTE + triggeredDisputeId + 2 DataHolds（原子）", async () => {
    const seller = await createFixtureUser("PG06卖家");
    const buyer = await createFixtureUser("PG06买家");
    const service = await createServiceFixture(seller.id);
    const order = await createGeneralOrder({
      type: "SERVICE", buyerId: buyer.id, sellerId: seller.id,
      serviceListingId: service.id, status: "ACCEPTED",
    });

    const meetupId = await confirmedMeetup({
      orderId: order.id,
      buyerId: buyer.id,
      sellerId: seller.id,
      scheduledAt: new Date(Date.now() - 20 * 60 * 1000), // 已过 15min grace
    });

    // buyer 先签到；seller 未到 → buyer 报告 seller no-show
    expect(await arriveMeetup({ orderId: order.id, meetupId, actorId: buyer.id })).toMatchObject({
      success: true,
    });

    const outcome = await reportNoShow({ orderId: order.id, meetupId, reporterId: buyer.id });
    expect(outcome).toMatchObject({ success: true, status: "NO_SHOW_REPORTED" });
    const disputeId = (outcome as { disputeId: string }).disputeId;
    createdDisputeIds.push(disputeId);

    const meetup = await rawClient!.orderMeetup.findUniqueOrThrow({ where: { id: meetupId } });
    expect(meetup.status).toBe("NO_SHOW_REPORTED");
    expect(meetup.noShowReportedById).toBe(buyer.id);
    expect(meetup.noShowTargetId).toBe(seller.id);
    expect(meetup.noShowReportedAt).not.toBeNull();
    expect(meetup.triggeredDisputeId).toBe(disputeId);

    const dispute = await rawClient!.orderDispute.findUniqueOrThrow({ where: { id: disputeId } });
    expect(dispute.status).toBe("OPEN");
    expect(dispute.initiatorId).toBe(buyer.id);
    expect(dispute.reason).toBe("线下见面爽约：交易一方报告对方未按约到场");
    expect(dispute.campusId).toBe(campusId);
    expect(dispute.scopeKey).toBe(`CAMPUS:${campusId}`);
    expect(dispute.openedFromOrderStatus).toBe("ACCEPTED");

    const orderAfter = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(orderAfter.status).toBe("IN_DISPUTE");

    const holds = await trackHolds(disputeId);
    expect(holds).toHaveLength(2);
    expect(holds.map((h) => h.subjectId).sort()).toEqual([buyer.id, seller.id].sort());
    createdDisputeIds.push(disputeId);

    // 通用通知为 system copy（双方各 1；不含 meetup provenance）
    const buyerNotifications = await rawClient!.notification.findMany({
      where: { userId: buyer.id, orderId: order.id },
    });
    const sellerNotifications = await rawClient!.notification.findMany({
      where: { userId: seller.id, orderId: order.id },
    });
    expect(buyerNotifications).toHaveLength(1);
    expect(sellerNotifications).toHaveLength(1);
    for (const notification of [...buyerNotifications, ...sellerNotifications]) {
      expect(notification.content).not.toContain("东门快递柜旁");
      expect(notification.content).not.toContain(meetupId);
    }

    // 终局：no-show 后不可再 arrive / cancel / reproposal
    expect(await arriveMeetup({ orderId: order.id, meetupId, actorId: seller.id })).toMatchObject({
      error: "MEETUP_INVALID_TRANSITION",
    });
    // reproposal 先被 Order 状态门拒绝（IN_DISPUTE ≠ ACCEPTED；partial unique
    // 的 NO_SHOW_REPORTED active 集是第二层兜底）
    expect(await proposeMeetup({ orderId: order.id, proposerId: seller.id, locationText: "西门" })).toMatchObject({
      error: "MEETUP_INVALID_TRANSITION",
    });
  });

  it("D01-PG-07：PRODUCT no-show 后 Product 保持 RESERVED（reservation 不被 meetup 域触碰）", async () => {
    const seller = await createFixtureUser("PG07卖家");
    const buyer = await createFixtureUser("PG07买家");
    const product = await createProductFixture(seller.id);
    const order = await placeRealOrder({
      buyerId: buyer.id,
      product: { id: product.id, price: "10", sellerId: seller.id, campusId },
    });
    expect(order).not.toBeNull();
    expect(await transitionOrder(seller.id, order!.id, "ACCEPTED")).not.toBeNull();
    expect(
      (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
    ).toBe("RESERVED");

    const meetupId = await confirmedMeetup({
      orderId: order!.id,
      buyerId: buyer.id,
      sellerId: seller.id,
      scheduledAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    expect(await arriveMeetup({ orderId: order!.id, meetupId, actorId: seller.id })).toMatchObject({
      success: true,
    });

    const outcome = await reportNoShow({ orderId: order!.id, meetupId, reporterId: seller.id });
    expect(outcome).toMatchObject({ success: true, status: "NO_SHOW_REPORTED" });
    createdDisputeIds.push((outcome as { disputeId: string }).disputeId);

    expect(
      (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
    ).toBe("RESERVED");
    expect(
      (await rawClient!.order.findUniqueOrThrow({ where: { id: order!.id } })).status,
    ).toBe("IN_DISPUTE");
  });

  it("D01-PG-08：cross-campus MeetupPoint → MEETUP_POINT_INVALID，零 mutation", async () => {
    const seller = await createFixtureUser("PG08卖家");
    const buyer = await createFixtureUser("PG08买家");
    const service = await createServiceFixture(seller.id);
    const order = await createGeneralOrder({
      type: "SERVICE", buyerId: buyer.id, sellerId: seller.id,
      serviceListingId: service.id, status: "ACCEPTED",
    });

    const otherCampus = await rawClient!.campus.create({
      data: { name: `P8D01-B-${RUN_TAG}`, slug: `p8d01-b-${randomUUID().slice(0, 8)}`, schoolName: "集成测试大学" },
    });
    const foreignPoint = await createMeetupPoint({ campusId: otherCampus.id, locationText: "他校门口" });

    expect(
      await proposeMeetup({ orderId: order.id, proposerId: buyer.id, meetupPointId: foreignPoint.id }),
    ).toMatchObject({ error: "MEETUP_POINT_INVALID" });
    expect(await rawClient!.orderMeetup.count({ where: { orderId: order.id } })).toBe(0);

    // 清理外校区（无业务行依赖）
    await rawClient!.meetupPoint.delete({ where: { id: foreignPoint.id } });
    createdPointIds.pop();
    await rawClient!.campus.delete({ where: { id: otherCampus.id } });
  });

  it("D01-PG-09：ERRAND → propose DENY，零 mutation（不进入 meetup domain）", async () => {
    const buyer = await createFixtureUser("PG09买家");
    const seller = await createFixtureUser("PG09跑腿员");
    const errand = await createErrandFixture(buyer.id, seller.id);
    const order = await createGeneralOrder({
      type: "ERRAND", buyerId: buyer.id, sellerId: seller.id,
      errandTaskId: errand.id, status: "ACCEPTED",
    });

    expect(
      await proposeMeetup({ orderId: order.id, proposerId: buyer.id, locationText: "北门" }),
    ).toMatchObject({ error: "MEETUP_INVALID_TRANSITION" });
    expect(await rawClient!.orderMeetup.count({ where: { orderId: order.id } })).toBe(0);
    expect(
      (await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errand.id } })).status,
    ).toBe("CLAIMED");
  });

  it("D01-PG-10：已有 manual dispute（Order IN_DISPUTE）→ no-show 零 mutation", async () => {
    const seller = await createFixtureUser("PG10卖家");
    const buyer = await createFixtureUser("PG10买家");
    const service = await createServiceFixture(seller.id);
    const order = await createGeneralOrder({
      type: "SERVICE", buyerId: buyer.id, sellerId: seller.id,
      serviceListingId: service.id, status: "ACCEPTED",
    });

    const meetupId = await confirmedMeetup({
      orderId: order.id,
      buyerId: buyer.id,
      sellerId: seller.id,
      scheduledAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    expect(await arriveMeetup({ orderId: order.id, meetupId, actorId: seller.id })).toMatchObject({
      success: true,
    });

    // buyer 先手动 dispute（合法串行）→ Order IN_DISPUTE
    const manual = await initiateDisputeRaw(order.id, buyer.id);
    expect(manual).toMatchObject({ success: true });
    const manualDisputeId = (manual as { disputeId: string }).disputeId;
    createdDisputeIds.push(manualDisputeId);

    // seller 的 no-show：Order 不再 ACCEPTED → DENY，零 mutation
    const before = await rawClient!.orderMeetup.findUniqueOrThrow({ where: { id: meetupId } });
    expect(
      await reportNoShow({ orderId: order.id, meetupId, reporterId: seller.id }),
    ).toMatchObject({ error: "MEETUP_INVALID_TRANSITION" });
    const after = await rawClient!.orderMeetup.findUniqueOrThrow({ where: { id: meetupId } });
    expect(after.status).toBe("CONFIRMED");
    expect(after.triggeredDisputeId).toBeNull();
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(await rawClient!.orderDispute.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("D01-PG-11：作者注销 → custom location 快照 REDACT；catalog 快照保留（隐私 erasure）", async () => {
    const seller = await createFixtureUser("PG11卖家");
    const buyer = await createFixtureUser("PG11买家");

    // 订单 1：custom location meetup（buyer 提出）
    const product1 = await createProductFixture(seller.id);
    const order1 = await placeRealOrder({
      buyerId: buyer.id,
      product: { id: product1.id, price: "10", sellerId: seller.id, campusId },
    });
    expect(order1).not.toBeNull();
    expect(await transitionOrder(seller.id, order1!.id, "ACCEPTED")).not.toBeNull();
    const customMeetupId = await confirmedMeetup({
      orderId: order1!.id,
      buyerId: buyer.id,
      sellerId: seller.id,
      scheduledAt: new Date(Date.now() - HOUR),
      locationText: "私下小树林入口",
    });
    // 终结订单（erasure 前置：无 active order）
    expect(await transitionOrder(buyer.id, order1!.id, "COMPLETED")).not.toBeNull();

    // 订单 2：catalog point meetup（buyer 提出）
    const product2 = await createProductFixture(seller.id);
    const order2 = await placeRealOrder({
      buyerId: buyer.id,
      product: { id: product2.id, price: "10", sellerId: seller.id, campusId },
    });
    expect(order2).not.toBeNull();
    expect(await transitionOrder(seller.id, order2!.id, "ACCEPTED")).not.toBeNull();
    const point = await createMeetupPoint({ campusId, locationText: "图书馆北门台阶" });
    const catalogMeetupId = await confirmedMeetup({
      orderId: order2!.id,
      buyerId: buyer.id,
      sellerId: seller.id,
      scheduledAt: new Date(Date.now() - HOUR),
      meetupPointId: point.id,
    });
    expect(await transitionOrder(buyer.id, order2!.id, "COMPLETED")).not.toBeNull();

    const { eraseAccount } = await import("@/lib/privacy/account-erasure");
    await eraseAccount(buyer.id);

    const customAfter = await rawClient!.orderMeetup.findUniqueOrThrow({ where: { id: customMeetupId } });
    expect(customAfter.locationTextSnapshot).toBe("（该内容已随账号注销删除）");
    const catalogAfter = await rawClient!.orderMeetup.findUniqueOrThrow({ where: { id: catalogMeetupId } });
    expect(catalogAfter.locationTextSnapshot).toBe("图书馆北门台阶");
    // provenance 结构保留
    expect(customAfter.status).toBe("CONFIRMED");
    expect(customAfter.scheduledAt).not.toBeNull();
  });

  // ============================================================
  // Deterministic races（pg_locks waiter barrier，零 sleep）
  // ============================================================

  it("D01-RACE-01 double proposal：T1 持锁挂起 → T2 真实等待 → 恰 1 个 active meetup + NO 40P01", async () => {
    const seller = await createFixtureUser("RACE01卖家");
    const buyer = await createFixtureUser("RACE01买家");
    const service = await createServiceFixture(seller.id);
    const order = await createGeneralOrder({
      type: "SERVICE", buyerId: buyer.id, sellerId: seller.id,
      serviceListingId: service.id, status: "ACCEPTED",
    });

    // T1：buyer propose，fresh checks 后挂起
    let signalT1Locked!: () => void;
    const t1Locked = new Promise<void>((resolve) => { signalT1Locked = resolve; });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => { releaseT1 = resolve; });
    const promiseT1 = proposeMeetup(
      { orderId: order.id, proposerId: buyer.id, locationText: "东门" },
      { racePoint: async () => { signalT1Locked(); await t1Gate; } },
    );
    await t1Locked;

    // T2：seller propose（同一 Order），必须阻塞在同一 pair 锁域
    const promiseT2 = proposeMeetup({ orderId: order.id, proposerId: seller.id, locationText: "南门" })
      .catch((error: unknown) => error);
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`, `USER:${seller.id}`]);

    releaseT1();
    const [resultT1, resultT2] = await Promise.allSettled([promiseT1, promiseT2]);

    assertNoSerializationFailure(rejectedReasons([resultT1, resultT2]));

    expect(resultT1).toMatchObject({
      status: "fulfilled",
      value: { success: true, status: "PROPOSED" },
    });
    // T2 醒来 fresh read：active meetup 已存在 → DENY
    expect(resultT2).toEqual({
      status: "fulfilled",
      value: { error: "MEETUP_ACTIVE_EXISTS" },
    });

    expect(await rawClient!.orderMeetup.count({ where: { orderId: order.id } })).toBe(1);
    expect(await activeMeetupCount(order.id)).toBe(1);
  });

  it("D01-RACE-02a confirm vs cancel（confirm 先手）→ 线性化终态 CANCELLED（含确认历史，无 split-brain）", async () => {
    const seller = await createFixtureUser("RACE02a卖家");
    const buyer = await createFixtureUser("RACE02a买家");
    const service = await createServiceFixture(seller.id);
    const order = await createGeneralOrder({
      type: "SERVICE", buyerId: buyer.id, sellerId: seller.id,
      serviceListingId: service.id, status: "ACCEPTED",
    });
    const proposed = await proposeMeetup({ orderId: order.id, proposerId: buyer.id, locationText: "东门" });
    const meetupId = (proposed as { meetupId: string }).meetupId;

    // T1：seller confirm 挂起（fresh checks 后、写入前）
    let signalT1Locked!: () => void;
    const t1Locked = new Promise<void>((resolve) => { signalT1Locked = resolve; });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => { releaseT1 = resolve; });
    const promiseT1 = confirmMeetup(
      { orderId: order.id, meetupId, confirmerId: seller.id },
      { racePoint: async () => { signalT1Locked(); await t1Gate; } },
    );
    await t1Locked;

    // T2：buyer cancel，阻塞在同一 pair 锁域
    const promiseT2 = cancelMeetup({ orderId: order.id, meetupId, actorId: buyer.id }).catch(
      (error: unknown) => error,
    );
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`, `USER:${seller.id}`]);

    releaseT1();
    const [resultT1, resultT2] = await Promise.allSettled([promiseT1, promiseT2]);
    assertNoSerializationFailure(rejectedReasons([resultT1, resultT2]));

    // confirm wins the race：CONFIRMED 落库
    expect(resultT1).toMatchObject({
      status: "fulfilled",
      value: { success: true, status: "CONFIRMED" },
    });
    // cancel 线性化在其后：CONFIRMED 仍是合法 cancel 源（now < scheduledAt）
    // → 合法串行取消（历史保留 confirmedAt），终态唯一 CANCELLED
    expect(resultT2).toEqual({
      status: "fulfilled",
      value: { success: true, status: "CANCELLED" },
    });

    const finalRow = await rawClient!.orderMeetup.findUniqueOrThrow({ where: { id: meetupId } });
    expect(finalRow.status).toBe("CANCELLED");
    expect(finalRow.cancelledAt).not.toBeNull();
    expect(finalRow.confirmedAt).not.toBeNull(); // 历史保留
    // 无 split-brain：不存在 status=CONFIRMED + cancelledAt 的组合
    expect(await activeMeetupCount(order.id)).toBe(0);
  });

  it("D01-RACE-02b confirm vs cancel（cancel 先手）→ confirm DENY，终态 CANCELLED", async () => {
    const seller = await createFixtureUser("RACE02b卖家");
    const buyer = await createFixtureUser("RACE02b买家");
    const service = await createServiceFixture(seller.id);
    const order = await createGeneralOrder({
      type: "SERVICE", buyerId: buyer.id, sellerId: seller.id,
      serviceListingId: service.id, status: "ACCEPTED",
    });
    const proposed = await proposeMeetup({ orderId: order.id, proposerId: buyer.id, locationText: "东门" });
    const meetupId = (proposed as { meetupId: string }).meetupId;

    expect(
      await cancelMeetup({ orderId: order.id, meetupId, actorId: seller.id }),
    ).toEqual({ success: true, status: "CANCELLED" });
    expect(
      await confirmMeetup({ orderId: order.id, meetupId, confirmerId: seller.id }),
    ).toEqual({ error: "MEETUP_INVALID_TRANSITION" });

    const finalRow = await rawClient!.orderMeetup.findUniqueOrThrow({ where: { id: meetupId } });
    expect(finalRow.status).toBe("CANCELLED");
    expect(finalRow.confirmedAt).toBeNull();
  });

  it("D01-RACE-03a arrival wins vs no-show：target 到场提交 → no-show fresh read DENY，零 dispute", async () => {
    const seller = await createFixtureUser("RACE03a卖家");
    const buyer = await createFixtureUser("RACE03a买家");
    const service = await createServiceFixture(seller.id);
    const order = await createGeneralOrder({
      type: "SERVICE", buyerId: buyer.id, sellerId: seller.id,
      serviceListingId: service.id, status: "ACCEPTED",
    });
    const meetupId = await confirmedMeetup({
      orderId: order.id,
      buyerId: buyer.id,
      sellerId: seller.id,
      scheduledAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    expect(await arriveMeetup({ orderId: order.id, meetupId, actorId: buyer.id })).toMatchObject({
      success: true,
    });

    // T1：seller arrival 挂起（fresh checks 后、写入前）
    let signalT1Locked!: () => void;
    const t1Locked = new Promise<void>((resolve) => { signalT1Locked = resolve; });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => { releaseT1 = resolve; });
    const { markOrderMeetupArrivalTx } = await import("@/lib/meetups/order-meetup-service");
    const { withTransaction } = await import("@/lib/prisma");
    const parkedT1 = withTransaction((tx: Prisma.TransactionClient) =>
      markOrderMeetupArrivalTx(
        tx,
        { orderId: order.id, meetupId, actorId: seller.id },
        { racePoint: async () => { signalT1Locked(); await t1Gate; } },
      ),
    );
    await t1Locked;

    // T2：buyer report no-show，阻塞在 pair 锁
    const promiseT2 = reportNoShow({ orderId: order.id, meetupId, reporterId: buyer.id }).catch(
      (error: unknown) => error,
    );
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`, `USER:${seller.id}`]);

    releaseT1();
    const [resultT1, resultT2] = await Promise.allSettled([parkedT1, promiseT2]);
    assertNoSerializationFailure(rejectedReasons([resultT1, resultT2]));

    // arrival wins：sellerArrivedAt 落库、COMPLETED
    expect(resultT1).toMatchObject({
      status: "fulfilled",
      value: { success: true, status: "COMPLETED", alreadyArrived: false },
    });
    // no-show 醒来 fresh read：COMPLETED ≠ CONFIRMED → DENY，无 dispute
    expect(resultT2).toEqual({
      status: "fulfilled",
      value: { error: "MEETUP_INVALID_TRANSITION" },
    });

    const finalRow = await rawClient!.orderMeetup.findUniqueOrThrow({ where: { id: meetupId } });
    expect(finalRow.status).toBe("COMPLETED");
    expect(finalRow.sellerArrivedAt).not.toBeNull();
    expect(finalRow.triggeredDisputeId).toBeNull();
    expect(
      (await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe("ACCEPTED");
    expect(await rawClient!.orderDispute.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("D01-RACE-03b no-show wins vs arrival：no-show 提交 → arrival DENY，sellerArrivedAt 保持 null", async () => {
    const seller = await createFixtureUser("RACE03b卖家");
    const buyer = await createFixtureUser("RACE03b买家");
    const service = await createServiceFixture(seller.id);
    const order = await createGeneralOrder({
      type: "SERVICE", buyerId: buyer.id, sellerId: seller.id,
      serviceListingId: service.id, status: "ACCEPTED",
    });
    const meetupId = await confirmedMeetup({
      orderId: order.id,
      buyerId: buyer.id,
      sellerId: seller.id,
      scheduledAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    expect(await arriveMeetup({ orderId: order.id, meetupId, actorId: buyer.id })).toMatchObject({
      success: true,
    });

    // T1：buyer no-show 挂起
    let signalT1Locked!: () => void;
    const t1Locked = new Promise<void>((resolve) => { signalT1Locked = resolve; });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => { releaseT1 = resolve; });
    const promiseT1 = reportNoShow(
      { orderId: order.id, meetupId, reporterId: buyer.id },
      { racePoint: async () => { signalT1Locked(); await t1Gate; } },
    );
    await t1Locked;

    // T2：seller arrival，阻塞在 pair 锁
    const promiseT2 = arriveMeetup({ orderId: order.id, meetupId, actorId: seller.id }).catch(
      (error: unknown) => error,
    );
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`, `USER:${seller.id}`]);

    releaseT1();
    const [resultT1, resultT2] = await Promise.allSettled([promiseT1, promiseT2]);
    assertNoSerializationFailure(rejectedReasons([resultT1, resultT2]));

    expect(resultT1).toMatchObject({
      status: "fulfilled",
      value: { success: true, status: "NO_SHOW_REPORTED" },
    });
    expect(resultT2).toEqual({
      status: "fulfilled",
      value: { error: "MEETUP_INVALID_TRANSITION" },
    });

    const finalRow = await rawClient!.orderMeetup.findUniqueOrThrow({ where: { id: meetupId } });
    expect(finalRow.status).toBe("NO_SHOW_REPORTED");
    expect(finalRow.sellerArrivedAt).toBeNull();
    expect(finalRow.triggeredDisputeId).not.toBeNull();
    createdDisputeIds.push(finalRow.triggeredDisputeId!);
    expect(
      (await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe("IN_DISPUTE");
    // 绝不出现 COMPLETED + no-show IN_DISPUTE 的 split-brain
    expect(await rawClient!.orderDispute.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("D01-RACE-04a no-show wins vs PRODUCT complete：complete DENY，Product 不得 SOLD", async () => {
    const seller = await createFixtureUser("RACE04a卖家");
    const buyer = await createFixtureUser("RACE04a买家");
    const product = await createProductFixture(seller.id);
    const order = await placeRealOrder({
      buyerId: buyer.id,
      product: { id: product.id, price: "10", sellerId: seller.id, campusId },
    });
    expect(order).not.toBeNull();
    expect(await transitionOrder(seller.id, order!.id, "ACCEPTED")).not.toBeNull();

    const meetupId = await confirmedMeetup({
      orderId: order!.id,
      buyerId: buyer.id,
      sellerId: seller.id,
      scheduledAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    // seller 已到场（reporter），buyer（target）未到
    expect(await arriveMeetup({ orderId: order!.id, meetupId, actorId: seller.id })).toMatchObject({
      success: true,
    });

    // T1：seller no-show 挂起
    let signalT1Locked!: () => void;
    const t1Locked = new Promise<void>((resolve) => { signalT1Locked = resolve; });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => { releaseT1 = resolve; });
    const promiseT1 = reportNoShow(
      { orderId: order!.id, meetupId, reporterId: seller.id },
      { racePoint: async () => { signalT1Locked(); await t1Gate; } },
    );
    await t1Locked;

    // T2：buyer 正常完成订单，阻塞在 USER:buyer
    const promiseT2 = transitionOrder(buyer.id, order!.id, "COMPLETED").catch((error: unknown) => error);
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`]);

    releaseT1();
    const [resultT1, resultT2] = await Promise.allSettled([promiseT1, promiseT2]);
    assertNoSerializationFailure(rejectedReasons([resultT1, resultT2]));

    expect(resultT1).toMatchObject({
      status: "fulfilled",
      value: { success: true, status: "NO_SHOW_REPORTED" },
    });
    // complete 醒来 fresh read：IN_DISPUTE 不在 COMPLETED 允许集 → DENY
    expect(resultT2).toEqual({ status: "fulfilled", value: null });

    expect(
      (await rawClient!.order.findUniqueOrThrow({ where: { id: order!.id } })).status,
    ).toBe("IN_DISPUTE");
    expect(
      (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
    ).toBe("RESERVED");
    const dispute = await rawClient!.orderDispute.findFirstOrThrow({ where: { orderId: order!.id } });
    createdDisputeIds.push(dispute.id);
    expect(
      (await rawClient!.orderMeetup.findUniqueOrThrow({ where: { id: meetupId } })).triggeredDisputeId,
    ).toBe(dispute.id);
  });

  it("D01-RACE-04b complete wins vs no-show：no-show fresh check DENY，Product 正常 SOLD", async () => {
    const seller = await createFixtureUser("RACE04b卖家");
    const buyer = await createFixtureUser("RACE04b买家");
    const product = await createProductFixture(seller.id);
    const order = await placeRealOrder({
      buyerId: buyer.id,
      product: { id: product.id, price: "10", sellerId: seller.id, campusId },
    });
    expect(order).not.toBeNull();
    expect(await transitionOrder(seller.id, order!.id, "ACCEPTED")).not.toBeNull();

    const meetupId = await confirmedMeetup({
      orderId: order!.id,
      buyerId: buyer.id,
      sellerId: seller.id,
      scheduledAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    expect(await arriveMeetup({ orderId: order!.id, meetupId, actorId: seller.id })).toMatchObject({
      success: true,
    });

    // T1：buyer completion 挂起（prepareActiveAccountMutation afterCheck：
    // 已持有 USER:buyer，Order read 之前）
    let signalT1Locked!: () => void;
    const t1Locked = new Promise<void>((resolve) => { signalT1Locked = resolve; });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => { releaseT1 = resolve; });
    const promiseT1 = transitionOrder(buyer.id, order!.id, "COMPLETED", {
      afterCheck: async () => {
        signalT1Locked();
        await t1Gate;
      },
    });
    await t1Locked;

    // T2：seller no-show，阻塞在 pair 锁域
    const promiseT2 = reportNoShow({ orderId: order!.id, meetupId, reporterId: seller.id }).catch(
      (error: unknown) => error,
    );
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`, `USER:${seller.id}`]);

    releaseT1();
    const [resultT1, resultT2] = await Promise.allSettled([promiseT1, promiseT2]);
    assertNoSerializationFailure(rejectedReasons([resultT1, resultT2]));

    // complete wins：Order COMPLETED + Product SOLD
    expect(resultT1).toMatchObject({ status: "fulfilled" });
    expect(resultT1).toEqual({
      status: "fulfilled",
      value: expect.objectContaining({ productId: product.id }),
    });
    // no-show 醒来 fresh read：Order COMPLETED ≠ ACCEPTED → DENY，零 mutation
    expect(resultT2).toEqual({
      status: "fulfilled",
      value: { error: "MEETUP_INVALID_TRANSITION" },
    });

    expect(
      (await rawClient!.order.findUniqueOrThrow({ where: { id: order!.id } })).status,
    ).toBe("COMPLETED");
    expect(
      (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
    ).toBe("SOLD");
    const meetupAfter = await rawClient!.orderMeetup.findUniqueOrThrow({ where: { id: meetupId } });
    expect(meetupAfter.status).toBe("CONFIRMED");
    expect(meetupAfter.triggeredDisputeId).toBeNull();
    expect(await rawClient!.orderDispute.count({ where: { orderId: order!.id } })).toBe(0);
  });

  it("D01-RACE-05a no-show wins vs manual dispute：恰 1 个 dispute = no-show 的 canonical dispute", async () => {
    const seller = await createFixtureUser("RACE05a卖家");
    const buyer = await createFixtureUser("RACE05a买家");
    const service = await createServiceFixture(seller.id);
    const order = await createGeneralOrder({
      type: "SERVICE", buyerId: buyer.id, sellerId: seller.id,
      serviceListingId: service.id, status: "ACCEPTED",
    });
    const meetupId = await confirmedMeetup({
      orderId: order.id,
      buyerId: buyer.id,
      sellerId: seller.id,
      scheduledAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    expect(await arriveMeetup({ orderId: order.id, meetupId, actorId: buyer.id })).toMatchObject({
      success: true,
    });

    // T1：buyer no-show 挂起
    let signalT1Locked!: () => void;
    const t1Locked = new Promise<void>((resolve) => { signalT1Locked = resolve; });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => { releaseT1 = resolve; });
    const promiseT1 = reportNoShow(
      { orderId: order.id, meetupId, reporterId: buyer.id },
      { racePoint: async () => { signalT1Locked(); await t1Gate; } },
    );
    await t1Locked;

    // T2：buyer 手动 dispute，阻塞在 pair 锁
    const promiseT2 = initiateDisputeRaw(order.id, buyer.id).catch((error: unknown) => error);
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`, `USER:${seller.id}`]);

    releaseT1();
    const [resultT1, resultT2] = await Promise.allSettled([promiseT1, promiseT2]);
    assertNoSerializationFailure(rejectedReasons([resultT1, resultT2]));

    expect(resultT1).toMatchObject({
      status: "fulfilled",
      value: { success: true, status: "NO_SHOW_REPORTED" },
    });
    // manual dispute 醒来 fresh read：IN_DISPUTE 不再 disputable → DENY
    expect(resultT2).toEqual({
      status: "fulfilled",
      value: { error: "状态不允许纠纷" },
    });

    const disputes = await rawClient!.orderDispute.findMany({ where: { orderId: order.id } });
    expect(disputes).toHaveLength(1);
    createdDisputeIds.push(...disputes.map((d) => d.id));
    expect(
      (await rawClient!.orderMeetup.findUniqueOrThrow({ where: { id: meetupId } })).triggeredDisputeId,
    ).toBe(disputes[0]!.id);
    expect(disputes[0]!.reason).toBe("线下见面爽约：交易一方报告对方未按约到场");
  });

  it("D01-RACE-05b manual dispute wins vs no-show：no-show 零 mutation，meetup 停留 CONFIRMED", async () => {
    const seller = await createFixtureUser("RACE05b卖家");
    const buyer = await createFixtureUser("RACE05b买家");
    const service = await createServiceFixture(seller.id);
    const order = await createGeneralOrder({
      type: "SERVICE", buyerId: buyer.id, sellerId: seller.id,
      serviceListingId: service.id, status: "ACCEPTED",
    });
    const meetupId = await confirmedMeetup({
      orderId: order.id,
      buyerId: buyer.id,
      sellerId: seller.id,
      scheduledAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    // seller 已到场（reporter），buyer 未到
    expect(await arriveMeetup({ orderId: order.id, meetupId, actorId: seller.id })).toMatchObject({
      success: true,
    });

    // T1：buyer 手动 dispute 挂起（dispute machine racePoint：锁 + 复查后、写入前）
    let signalT1Locked!: () => void;
    const t1Locked = new Promise<void>((resolve) => { signalT1Locked = resolve; });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => { releaseT1 = resolve; });
    const promiseT1 = initiateDisputeRaw(order.id, buyer.id, async () => {
      signalT1Locked();
      await t1Gate;
    });
    await t1Locked;

    // T2：seller no-show，阻塞在 pair 锁
    const promiseT2 = reportNoShow({ orderId: order.id, meetupId, reporterId: seller.id }).catch(
      (error: unknown) => error,
    );
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`, `USER:${seller.id}`]);

    releaseT1();
    const [resultT1, resultT2] = await Promise.allSettled([promiseT1, promiseT2]);
    assertNoSerializationFailure(rejectedReasons([resultT1, resultT2]));

    expect(resultT1).toMatchObject({ status: "fulfilled", value: { success: true } });
    // no-show 醒来 fresh read：Order IN_DISPUTE ≠ ACCEPTED → DENY，零 mutation
    expect(resultT2).toEqual({
      status: "fulfilled",
      value: { error: "MEETUP_INVALID_TRANSITION" },
    });

    const disputes = await rawClient!.orderDispute.findMany({ where: { orderId: order.id } });
    expect(disputes).toHaveLength(1);
    createdDisputeIds.push(...disputes.map((d) => d.id));
    expect(disputes[0]!.reason).toBe("race"); // manual dispute 的 reason
    const meetupAfter = await rawClient!.orderMeetup.findUniqueOrThrow({ where: { id: meetupId } });
    expect(meetupAfter.status).toBe("CONFIRMED");
    expect(meetupAfter.triggeredDisputeId).toBeNull();
    expect(meetupAfter.noShowReportedAt).toBeNull();
  });
});
