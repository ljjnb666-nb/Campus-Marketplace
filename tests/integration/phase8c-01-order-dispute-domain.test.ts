import { randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { waitForAdvisoryLockWaiter } from "./helpers/lock-barrier";

// Phase 8C-01（P8-C01）General OrderDispute domain foundation 集成测试
// （真实 PostgreSQL）。
//
// 覆盖（指令 §68-§81）：
//   - 真实 initiate：PRODUCT（ACCEPTED）/ SERVICE（IN_PROGRESS）/ ERRAND
//     （IN_PROGRESS ↔ PENDING_CONFIRMATION canonical pair）→ Order IN_DISPUTE、
//     ErrandTask DISPUTED、snapshots、2 DataHolds、dueAt = createdAt + 48h
//   - 真实 RESTORE：ERRAND 原子恢复（Order + ErrandTask）
//   - 真实 CLOSE：PRODUCT（ACCEPTED 源 → 共享 release projection）/
//     COMPLETED 源（Product SOLD 不复活）/ SERVICE（listing 零改动）
//   - DataHold：initiate 2×ACTIVE → terminal 双方 RELEASED；LEGAL hold 不触碰
//   - Erasure：active dispute BLOCK；terminal 后允许 + reason redacted
//   - Races（pg_locks waiter barrier，零 sleep，NO 40P01）：
//     double initiate / dispute vs PRODUCT complete / complete-then-dispute /
//     errand dispute vs publisher complete（shared full order，无 split-brain）
//   - Communication（§80）：IN_DISPUTE = active obligation → blocked pair
//     ALLOW；CLOSED = terminal → DENY

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

const RUN_TAG = `p8c01-${randomUUID().slice(0, 8)}`;

const createdUserIds: string[] = [];
const createdProductIds: string[] = [];
const createdServiceIds: string[] = [];
const createdErrandIds: string[] = [];
const createdOrderIds: string[] = [];
const createdMembershipIds: string[] = [];
const createdDisputeIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdHoldIds: string[] = [];

let campusId = "";

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
  createdUserIds.push(user.id);
  const membership = await rawClient!.campusMembership.create({
    data: { userId: user.id, campusId, status: "ACTIVE" },
  });
  createdMembershipIds.push(membership.id);
  return user;
}

async function createProductFixture(sellerId: string, status: "ACTIVE" | "RESERVED" | "SOLD" | "OFFLINE" = "ACTIVE") {
  const category = await rawClient!.productCategory.create({
    data: { name: `8C01类目-${randomUUID().slice(0, 8)}`, slug: `p8c01-${randomUUID().slice(0, 8)}` },
  });
  createdCategoryIds.push(category.id);
  const product = await rawClient!.product.create({
    data: {
      title: `8C01 商品 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8C-01 fixture",
      price: 10,
      condition: "NEW",
      locationText: "东门",
      categoryId: category.id,
      campusId,
      sellerId,
      status,
    },
  });
  createdProductIds.push(product.id);
  return product;
}

async function createServiceFixture(providerId: string) {
  const service = await rawClient!.serviceListing.create({
    data: {
      title: `8C01 服务 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8C-01 fixture",
      price: 20,
      pricingUnit: "PER_SESSION",
      locationText: "东门",
      providerId,
      campusId,
      categoryId: (await rawClient!.serviceCategory.create({
        data: { name: `8C01服务类目-${randomUUID().slice(0, 8)}`, slug: `p8c01-svc-${randomUUID().slice(0, 8)}` },
      })).id,
      status: "ACTIVE",
    },
  });
  createdServiceIds.push(service.id);
  return service;
}

async function createErrandFixture(publisherId: string, accepterId: string | null, status: string) {
  const category = await rawClient!.errandCategory.create({
    data: { name: `8C01跑腿类目-${randomUUID().slice(0, 8)}`, slug: `p8c01-err-${randomUUID().slice(0, 8)}` },
  });
  createdCategoryIds.push(category.id);
  const errand = await rawClient!.errandTask.create({
    data: {
      title: `8C01 跑腿 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8C-01 fixture",
      categoryId: category.id,
      reward: "10.00",
      pickupLocation: "北门",
      deliveryLocation: "南门",
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      publisherId,
      accepterId,
      campusId,
      status: status as never,
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
  productReservationExpiresAt?: Date | null;
}) {
  // fixture 直写：status 用 string 宽化（测试时钟/状态直控；运行时权威在
  // 领域函数 fresh 校验）
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
      productReservationExpiresAt: input.productReservationExpiresAt ?? null,
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

/** 真实 PRODUCT 下单（createProductOrderTx 完整事务链）。 */
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

async function initiateDispute(
  input: { orderId: string; userId: string; reason: string },
  options?: { racePoint?: () => Promise<void>; beforeSubjectLocks?: () => Promise<void> },
) {
  const { initiateOrderDisputeTx } = await import("@/lib/order-dispute-machine");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction(async (tx: Prisma.TransactionClient) =>
    initiateOrderDisputeTx(
      tx,
      {
        orderId: input.orderId,
        userId: input.userId,
        reason: input.reason,
        evidencePhotos: [],
        beforeSubjectLocks: options?.beforeSubjectLocks,
        racePoint: options?.racePoint,
      },
    ),
  );
}

async function initiateDisputeRaw(orderId: string, userId: string, racePoint?: () => Promise<void>) {
  const { initiateOrderDisputeTx } = await import("@/lib/order-dispute-machine");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction(async (tx: Prisma.TransactionClient) =>
    initiateOrderDisputeTx(tx, { orderId, userId, reason: "race", evidencePhotos: [], racePoint }),
  );
}

async function claim(input: { actorId: string; disputeId: string }) {
  const { claimOrderDispute } = await import("@/lib/disputes/order-dispute-service");
  return claimOrderDispute(input);
}

async function release(input: { actorId: string; disputeId: string }) {
  const { releaseOrderDispute } = await import("@/lib/disputes/order-dispute-service");
  return releaseOrderDispute(input);
}

async function resolveDispute(input: {
  actorId: string;
  disputeId: string;
  resolutionCode?: "MUTUAL_AGREEMENT" | "EVIDENCE_INSUFFICIENT" | "OTHER";
  resolutionAction: "RESTORE_PREVIOUS" | "CLOSE_ORDER";
}) {
  const { resolveOrderDispute, closeOrderDispute } = await import("@/lib/disputes/order-dispute-service");
  if (input.resolutionCode) {
    return resolveOrderDispute({
      actorId: input.actorId,
      disputeId: input.disputeId,
      resolutionCode: input.resolutionCode,
      resolutionAction: input.resolutionAction,
    });
  }
  return closeOrderDispute({
    actorId: input.actorId,
    disputeId: input.disputeId,
    resolutionAction: input.resolutionAction,
  });
}

function trackHolds(ids: string[]) {
  createdHoldIds.push(...ids.filter((id) => !createdHoldIds.includes(id)));
}

async function activeDisputeHolds(disputeId: string) {
  return rawClient!.dataHold.findMany({
    where: { sourceType: "ORDER_DISPUTE", sourceId: disputeId, status: "ACTIVE" },
  });
}

async function notificationCount(userId: string, title: string, orderId: string) {
  return rawClient!.notification.count({ where: { userId, title, orderId } });
}

function assertNoSerializationFailure(errors: unknown[]) {
  for (const error of errors) {
    const message = String((error as Error)?.message ?? error);
    expect(message).not.toContain("40P01");
    expect(message).not.toContain("deadlock detected");
  }
}

async function requireReviewer(name: string) {
  const reviewer = await createFixtureUser(name);
  // dispute.review permission 已由 Phase 7G seed 固化（Permission 表）——
  // 挂到 CAMPUS-scoped 测试角色并 assignment 到本 campus
  const role = await rawClient!.role.create({
    data: {
      key: `${RUN_TAG}_${randomUUID().slice(0, 8)}`,
      name: `8C01 reviewer ${randomUUID().slice(0, 6)}`,
      scope: "CAMPUS",
      isSystem: false,
      rolePermissions: {
        create: [{ permission: { connect: { key: "dispute.review" } } }],
      },
    },
  });
  await rawClient!.userRoleAssignment.create({
    data: { userId: reviewer.id, roleId: role.id, campusId, scopeKey: `CAMPUS:${campusId}` },
  });
  return reviewer;
}

beforeAll(async () => {
  if (!integrationDatabaseUrl || !rawClient) return;

  const campus = await rawClient.campus.create({
    data: { name: `P8C01-A-${RUN_TAG}`, slug: `p8c01-a-${randomUUID().slice(0, 8)}`, schoolName: "集成测试大学" },
  });
  campusId = campus.id;
});

afterAll(async () => {
  if (!rawClient) return;

  // §88：严格反向 FK 清理；禁止 silent catch；Campus 最后删除 + sentinel
  await rawClient.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await rawClient.dataHold.deleteMany({
    where: { OR: [{ subjectId: { in: createdUserIds } }, { id: { in: createdHoldIds } }] },
  });
  await rawClient.orderDispute.deleteMany({ where: { id: { in: createdDisputeIds } } });
  await rawClient.review.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await rawClient.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await rawClient.errandTask.deleteMany({ where: { id: { in: createdErrandIds } } });
  await rawClient.product.deleteMany({ where: { id: { in: createdProductIds } } });
  await rawClient.serviceListing.deleteMany({ where: { id: { in: createdServiceIds } } });
  await rawClient.productCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await rawClient.errandCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await rawClient.serviceCategory.deleteMany({ where: { slug: { startsWith: "p8c01-svc-" } } });
  await rawClient.userRoleAssignment.deleteMany({ where: { userId: { in: createdUserIds } } });
  await rawClient.role.deleteMany({ where: { key: { startsWith: `${RUN_TAG}_` } } });
  await rawClient.campusMembership.deleteMany({ where: { id: { in: createdMembershipIds } } });
  await rawClient.blockedUser.deleteMany({
    where: {
      OR: [
        { blockerId: { in: createdUserIds } },
        { blockedUserId: { in: createdUserIds } },
      ],
    },
  });
  await rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await rawClient.campus.deleteMany({ where: { id: campusId } });

  const remainingCampus = await rawClient.campus.count({ where: { id: campusId } });
  expect(remainingCampus).toBe(0);

  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl)("Phase 8C-01 general order dispute domain（真实 PG）", () => {
  it("OD-PG-01 PRODUCT ACCEPTED：真实下单+accept → initiate → IN_DISPUTE/RESERVED/OPEN/2 holds/48h SLA", async () => {
    const seller = await createFixtureUser("PG01卖家");
    const buyer = await createFixtureUser("PG01买家");
    const product = await createProductFixture(seller.id);

    const order = await placeRealOrder({
      buyerId: buyer.id,
      product: { id: product.id, price: "10", sellerId: seller.id, campusId },
    });
    expect(order).not.toBeNull();
    expect(await transitionOrder(seller.id, order!.id, "ACCEPTED")).not.toBeNull();

    const outcome = await initiateDispute({
      orderId: order!.id,
      userId: buyer.id,
      reason: "PG01 商品与描述不符",
    });
    expect(outcome).toMatchObject({ success: true });
    const disputeId = (outcome as { success: true; disputeId: string }).disputeId;
    createdDisputeIds.push(disputeId);

    const dispute = await rawClient!.orderDispute.findUniqueOrThrow({ where: { id: disputeId } });
    expect(dispute.status).toBe("OPEN");
    expect(dispute.campusId).toBe(campusId); // snapshot 自 Product.campusId
    expect(dispute.scopeKey).toBe(`CAMPUS:${campusId}`);
    expect(dispute.openedFromOrderStatus).toBe("ACCEPTED");
    expect(dispute.openedFromErrandStatus).toBeNull();
    expect(dispute.evidencePhotos).toEqual([]);
    expect(Math.abs(dispute.dueAt.getTime() - dispute.createdAt.getTime())).toBe(48 * 60 * 60 * 1000);

    const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order!.id } });
    expect(finalOrder.status).toBe("IN_DISPUTE");
    expect(
      (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
    ).toBe("RESERVED"); // IN_DISPUTE 仍是 active occupancy

    const holds = await activeDisputeHolds(disputeId);
    trackHolds(holds.map((h) => h.id));
    expect(holds.map((h) => h.subjectId).sort()).toEqual([buyer.id, seller.id].sort());
    expect(holds.every((h) => h.type === "DISPUTE" && h.reasonCode === "ACTIVE_ORDER_DISPUTE")).toBe(true);

    expect(await notificationCount(buyer.id, "订单纠纷已提交", order!.id)).toBe(1);
    expect(await notificationCount(seller.id, "订单进入纠纷流程", order!.id)).toBe(1);
  });

  it("OD-PG-02 SERVICE IN_PROGRESS：initiate → IN_DISPUTE，listing 零改动", async () => {
    const provider = await createFixtureUser("PG02服务者");
    const buyer = await createFixtureUser("PG02买家");
    const service = await createServiceFixture(provider.id);
    const order = await createGeneralOrder({
      type: "SERVICE", buyerId: buyer.id, sellerId: provider.id,
      serviceListingId: service.id, status: "IN_PROGRESS",
    });

    const outcome = await initiateDispute({ orderId: order.id, userId: buyer.id, reason: "PG02 服务时长争议" });
    expect(outcome).toMatchObject({ success: true });
    createdDisputeIds.push((outcome as { disputeId: string }).disputeId);

    expect(
      (await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe("IN_DISPUTE");
    expect(
      (await rawClient!.serviceListing.findUniqueOrThrow({ where: { id: service.id } })).status,
    ).toBe("ACTIVE");
  });

  it("OD-PG-03 ERRAND canonical pair：initiate → IN_DISPUTE + DISPUTED + 双 snapshot；RESTORE 原子恢复", async () => {
    const publisher = await createFixtureUser("PG03发布者");
    const accepter = await createFixtureUser("PG03接单者");
    const errand = await createErrandFixture(publisher.id, accepter.id, "IN_PROGRESS");
    const order = await createGeneralOrder({
      type: "ERRAND", buyerId: publisher.id, sellerId: accepter.id,
      errandTaskId: errand.id, status: "IN_PROGRESS",
    });

    const outcome = await initiateDispute({ orderId: order.id, userId: publisher.id, reason: "PG03 送错地址" });
    expect(outcome).toMatchObject({ success: true });
    const disputeId = (outcome as { disputeId: string }).disputeId;
    createdDisputeIds.push(disputeId);

    const dispute = await rawClient!.orderDispute.findUniqueOrThrow({ where: { id: disputeId } });
    expect(dispute.openedFromOrderStatus).toBe("IN_PROGRESS");
    expect(dispute.openedFromErrandStatus).toBe("IN_PROGRESS");
    expect(
      (await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errand.id } })).status,
    ).toBe("DISPUTED");

    // claim / release 状态机
    const reviewer = await requireReviewer("PG03审核员");
    expect(await claim({ actorId: reviewer.id, disputeId })).toMatchObject({ outcome: "CLAIMED" });
    expect((await rawClient!.orderDispute.findUniqueOrThrow({ where: { id: disputeId } })).status).toBe("IN_REVIEW");
    expect(await release({ actorId: reviewer.id, disputeId })).toMatchObject({ outcome: "RELEASED" });
    expect((await rawClient!.orderDispute.findUniqueOrThrow({ where: { id: disputeId } })).status).toBe("OPEN");

    // RESTORE 原子恢复
    const result = await resolveDispute({
      actorId: reviewer.id,
      disputeId,
      resolutionCode: "EVIDENCE_INSUFFICIENT",
      resolutionAction: "RESTORE_PREVIOUS",
    });
    expect(result).toMatchObject({ status: "RESOLVED", orderStatus: "IN_PROGRESS", errandStatus: "IN_PROGRESS" });
    expect(
      (await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe("IN_PROGRESS");
    expect(
      (await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errand.id } })).status,
    ).toBe("IN_PROGRESS");
  });

  it("OD-PG-04 CLOSE PRODUCT（ACCEPTED 源）：Order CLOSED + 共享 release projection（seller eligible → ACTIVE）", async () => {
    const seller = await createFixtureUser("PG04卖家");
    const buyer = await createFixtureUser("PG04买家");
    const product = await createProductFixture(seller.id);
    const order = await createGeneralOrder({
      type: "PRODUCT", buyerId: buyer.id, sellerId: seller.id, productId: product.id,
      status: "ACCEPTED",
    });

    const outcome = await initiateDispute({ orderId: order.id, userId: buyer.id, reason: "PG04 不要了" });
    createdDisputeIds.push((outcome as { disputeId: string }).disputeId);
    const disputeId = (outcome as { disputeId: string }).disputeId;

    const reviewer = await requireReviewer("PG04审核员");
    const result = await resolveDispute({
      actorId: reviewer.id,
      disputeId,
      resolutionAction: "CLOSE_ORDER",
    });
    expect(result).toMatchObject({ status: "CLOSED", orderStatus: "CLOSED", errandStatus: null });

    expect(
      (await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe("CLOSED");
    expect(
      (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
    ).toBe("ACTIVE");

    // holds released
    expect(await activeDisputeHolds(disputeId)).toHaveLength(0);
  });

  it("OD-PG-05 CLOSE COMPLETED PRODUCT：Product SOLD 不复活；counters 零补偿", async () => {
    const seller = await createFixtureUser("PG05卖家");
    const buyer = await createFixtureUser("PG05买家");
    const product = await createProductFixture(seller.id);
    const order = await placeRealOrder({
      buyerId: buyer.id,
      product: { id: product.id, price: "10", sellerId: seller.id, campusId },
    });
    expect(order).not.toBeNull();
    expect(await transitionOrder(seller.id, order!.id, "ACCEPTED")).not.toBeNull();
    expect(await transitionOrder(buyer.id, order!.id, "COMPLETED")).not.toBeNull();
    expect(
      (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
    ).toBe("SOLD");

    const beforeBuyer = (await rawClient!.user.findUniqueOrThrow({ where: { id: buyer.id } })).completedOrdersCount;

    // COMPLETED 可 dispute（完成后不丧失纠纷权）
    const outcome = await initiateDispute({ orderId: order!.id, userId: seller.id, reason: "PG05 尾款纠纷" });
    expect(outcome).toMatchObject({ success: true });
    createdDisputeIds.push((outcome as { disputeId: string }).disputeId);
    expect(
      (await rawClient!.orderDispute.findUniqueOrThrow({ where: { id: (outcome as { disputeId: string }).disputeId } })).openedFromOrderStatus,
    ).toBe("COMPLETED");

    const reviewer = await requireReviewer("PG05审核员");
    await resolveDispute({
      actorId: reviewer.id,
      disputeId: (outcome as { disputeId: string }).disputeId,
      resolutionAction: "CLOSE_ORDER",
    });

    expect(
      (await rawClient!.order.findUniqueOrThrow({ where: { id: order!.id } })).status,
    ).toBe("CLOSED");
    expect(
      (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
    ).toBe("SOLD"); // SOLD 不被穿越

    const afterBuyer = (await rawClient!.user.findUniqueOrThrow({ where: { id: buyer.id } })).completedOrdersCount;
    expect(afterBuyer).toEqual(beforeBuyer); // 零 counter compensation
  });

  it("OD-PG-06 DATAHOLD 隔离：LEGAL hold 不被 ORDER_DISPUTE 终局触碰", async () => {
    const seller = await createFixtureUser("PG06卖家");
    const buyer = await createFixtureUser("PG06买家");
    const service = await createServiceFixture(seller.id);
    const order = await createGeneralOrder({
      type: "SERVICE", buyerId: buyer.id, sellerId: seller.id,
      serviceListingId: service.id, status: "ACCEPTED",
    });

    const outcome = await initiateDispute({ orderId: order.id, userId: buyer.id, reason: "PG06" });
    const disputeId = (outcome as { disputeId: string }).disputeId;
    createdDisputeIds.push(disputeId);

    const legalHold = await rawClient!.dataHold.create({
      data: {
        type: "LEGAL",
        subjectType: "USER",
        subjectId: buyer.id,
        reasonCode: "LEGAL_TEST",
        sourceType: "LEGAL_CASE",
        sourceId: `legal-${randomUUID().slice(0, 8)}`,
      },
    });
    trackHolds([legalHold.id]);

    const reviewer = await requireReviewer("PG06审核员");
    await resolveDispute({
      actorId: reviewer.id,
      disputeId,
      resolutionAction: "CLOSE_ORDER",
    });

    expect(
      (await rawClient!.dataHold.findUniqueOrThrow({ where: { id: legalHold.id } })).status,
    ).toBe("ACTIVE"); // 无关 hold 零触碰
    expect(await activeDisputeHolds(disputeId)).toHaveLength(0);
  });

  it("OD-PG-07 ERASURE：active dispute BLOCK；terminal 后允许且 reason redacted / evidence cleared / governance 保留", async () => {
    const seller = await createFixtureUser("PG07卖家");
    const buyer = await createFixtureUser("PG07买家");
    const service = await createServiceFixture(seller.id);
    const order = await createGeneralOrder({
      type: "SERVICE", buyerId: buyer.id, sellerId: seller.id,
      serviceListingId: service.id, status: "ACCEPTED",
    });

    const outcome = await initiateDispute({ orderId: order.id, userId: buyer.id, reason: "PG07 注销前纠纷原文" });
    expect(outcome).toMatchObject({ success: true });
    const disputeId = (outcome as { disputeId: string }).disputeId;
    createdDisputeIds.push(disputeId);

    // active dispute（DataHold）→ erase BLOCK
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");
    await expect(eraseAccount(buyer.id)).rejects.toMatchObject({ code: "ACTIVE_DATA_HOLD" });

    // 终局 CLOSE_ORDER：订单 CLOSED（terminal，无其它 blocker）→ erase 放行。
    // （RESTORE_PREVIOUS → ACCEPTED 属活跃交易，erasure 仍会被
    // ACTIVE_TRANSACTION_BLOCK 阻断——那是另一道独立防线，见
    // account-erasure ACTIVE_ORDER_STATUSES。）
    const reviewer = await requireReviewer("PG07审核员");
    await resolveDispute({
      actorId: reviewer.id,
      disputeId,
      resolutionAction: "CLOSE_ORDER",
    });

    await eraseAccount(buyer.id);

    const erasedDispute = await rawClient!.orderDispute.findUniqueOrThrow({ where: { id: disputeId } });
    expect(erasedDispute.reason).toBe("（该内容已随账号注销删除）");
    expect(erasedDispute.evidencePhotos).toEqual([]);
    // governance 历史保留
    expect(erasedDispute.status).toBe("CLOSED");
    expect(erasedDispute.resolutionCode).toBeNull();
    expect(erasedDispute.resolutionAction).toBe("CLOSE_ORDER");
    expect(erasedDispute.campusId).toBe(campusId);
    expect(erasedDispute.resolvedById).toBe(reviewer.id);
    expect(erasedDispute.resolvedAt).not.toBeNull();
  });

  it("OD-RACE-01 double initiate：T1 持锁挂起 → T2 真实等待（pg_locks）→ 恰 1 个 active dispute + 2 holds + NO 40P01", async () => {
    const seller = await createFixtureUser("RACE01卖家");
    const buyer = await createFixtureUser("RACE01买家");
    const service = await createServiceFixture(seller.id);
    const order = await createGeneralOrder({
      type: "SERVICE", buyerId: buyer.id, sellerId: seller.id,
      serviceListingId: service.id, status: "ACCEPTED",
    });

    // T1：buyer initiate，fresh checks 后挂起
    let signalT1Locked!: () => void;
    const t1Locked = new Promise<void>((resolve) => { signalT1Locked = resolve; });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => { releaseT1 = resolve; });
    const promiseT1 = initiateDisputeRaw(order.id, buyer.id, async () => {
      signalT1Locked();
      await t1Gate;
    });
    await t1Locked;

    // T2：seller initiate（同一 Order），必须阻塞在同一 pair 锁域
    const promiseT2 = initiateDisputeRaw(order.id, seller.id).catch((error: unknown) => error);
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`, `USER:${seller.id}`]);

    releaseT1();
    const [resultT1, resultT2] = await Promise.allSettled([promiseT1, promiseT2]);

    assertNoSerializationFailure(
      [resultT1, resultT2]
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason),
    );

    const winner = (resultT1 as PromiseFulfilledResult<unknown>).value;
    expect(winner).toMatchObject({ success: true });
    // T2 醒来 fresh read：IN_DISPUTE 不再 disputable → DENY（唯一 winner 已
    // 落库；active-dispute 检查为纵深防御）
    expect(resultT2).toEqual({
      status: "fulfilled",
      value: { error: "状态不允许纠纷" },
    });

    const disputes = await rawClient!.orderDispute.findMany({ where: { orderId: order.id } });
    createdDisputeIds.push(...disputes.map((d) => d.id));
    expect(disputes).toHaveLength(1);
    expect(
      (await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe("IN_DISPUTE");

    const holds = await activeDisputeHolds(disputes[0]!.id);
    trackHolds(holds.map((h) => h.id));
    expect(holds).toHaveLength(2); // 恰一对 source-linked holds
    expect(await notificationCount(buyer.id, "订单纠纷已提交", order.id)).toBe(1);
    expect(await notificationCount(seller.id, "订单进入纠纷流程", order.id)).toBe(1);
  });

  it("OD-RACE-02 dispute wins vs PRODUCT complete：buyer initiate 挂起 → COMPLETE 等待 → IN_DISPUTE，complete DENY", async () => {
    const seller = await createFixtureUser("RACE02卖家");
    const buyer = await createFixtureUser("RACE02买家");
    const product = await createProductFixture(seller.id);
    const order = await placeRealOrder({
      buyerId: buyer.id,
      product: { id: product.id, price: "10", sellerId: seller.id, campusId },
    });
    expect(order).not.toBeNull();
    expect(await transitionOrder(seller.id, order!.id, "ACCEPTED")).not.toBeNull();

    // T1：buyer initiate dispute 挂起（holder of USER:buyer 锁 → T2 在 actor 锁处等待）
    let signalT1Locked!: () => void;
    const t1Locked = new Promise<void>((resolve) => { signalT1Locked = resolve; });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => { releaseT1 = resolve; });
    const promiseT1 = initiateDisputeRaw(order!.id, buyer.id, async () => {
      signalT1Locked();
      await t1Gate;
    });
    await t1Locked;

    // T2：buyer COMPLETE——与 T1 同一 buyer USER 锁（pg_locks waiter 证据）
    const promiseT2 = transitionOrder(buyer.id, order!.id, "COMPLETED").catch((error: unknown) => error);
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`]);

    releaseT1();
    const [resultT1, resultT2] = await Promise.allSettled([promiseT1, promiseT2]);

    assertNoSerializationFailure(
      [resultT1, resultT2]
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason),
    );

    expect(resultT1).toMatchObject({ status: "fulfilled" });
    // T2 醒来 fresh re-read：IN_DISPUTE 不在 COMPLETED 的 transition 允许集 → DENY
    expect(resultT2).toEqual({ status: "fulfilled", value: null });

    expect(
      (await rawClient!.order.findUniqueOrThrow({ where: { id: order!.id } })).status,
    ).toBe("IN_DISPUTE");
    expect(
      (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
    ).toBe("RESERVED"); // dispute 期间不释放
    const disputes = await rawClient!.orderDispute.findMany({ where: { orderId: order!.id } });
    createdDisputeIds.push(...disputes.map((d) => d.id));
  });

  it("OD-RACE-03 complete wins then dispute：COMPLETED 先完整提交 → dispute 合法串行（Product stays SOLD）", async () => {
    const seller = await createFixtureUser("RACE03卖家");
    const buyer = await createFixtureUser("RACE03买家");
    const product = await createProductFixture(seller.id);
    const order = await placeRealOrder({
      buyerId: buyer.id,
      product: { id: product.id, price: "10", sellerId: seller.id, campusId },
    });
    expect(order).not.toBeNull();
    expect(await transitionOrder(seller.id, order!.id, "ACCEPTED")).not.toBeNull();

    // complete 先完整提交（合法串行历史）
    expect(await transitionOrder(buyer.id, order!.id, "COMPLETED")).not.toBeNull();
    expect(
      (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
    ).toBe("SOLD");

    // 之后 dispute allowed（COMPLETED 可 dispute）
    const outcome = await initiateDispute({ orderId: order!.id, userId: buyer.id, reason: "RACE03 事后纠纷" });
    expect(outcome).toMatchObject({ success: true });
    createdDisputeIds.push((outcome as { disputeId: string }).disputeId);

    expect(
      (await rawClient!.order.findUniqueOrThrow({ where: { id: order!.id } })).status,
    ).toBe("IN_DISPUTE");
    expect(
      (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
    ).toBe("SOLD"); // stays SOLD
    expect(
      (await rawClient!.orderDispute.findUniqueOrThrow({ where: { id: (outcome as { disputeId: string }).disputeId } })).openedFromOrderStatus,
    ).toBe("COMPLETED");
  });

  it("OD-RACE-04 errand dispute vs publisher complete：共享 USER pair + ErrandTask + Order 全序，无 split-brain pair", async () => {
    const publisher = await createFixtureUser("RACE04发布者");
    const accepter = await createFixtureUser("RACE04接单者");
    const errand = await createErrandFixture(publisher.id, accepter.id, "PENDING_CONFIRMATION");
    const order = await createGeneralOrder({
      type: "ERRAND", buyerId: publisher.id, sellerId: accepter.id,
      errandTaskId: errand.id, status: "IN_PROGRESS",
    });

    // T1：publisher（= buyer）initiate dispute 挂起
    let signalT1Locked!: () => void;
    const t1Locked = new Promise<void>((resolve) => { signalT1Locked = resolve; });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => { releaseT1 = resolve; });
    const promiseT1 = initiateDisputeRaw(order.id, publisher.id, async () => {
      signalT1Locked();
      await t1Gate;
    });
    await t1Locked;

    // T2：publisher COMPLETE（canonical errand lifecycle：同一 pair 锁 +
    // ErrandTask → Order 行锁全序）
    const promiseT2 = transitionOrder(publisher.id, order.id, "COMPLETED").catch((error: unknown) => error);
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${publisher.id}`, `USER:${accepter.id}`]);

    releaseT1();
    const [resultT1, resultT2] = await Promise.allSettled([promiseT1, promiseT2]);

    assertNoSerializationFailure(
      [resultT1, resultT2]
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason),
    );

    expect(resultT1).toMatchObject({ status: "fulfilled" });
    expect(resultT2).toEqual({ status: "fulfilled", value: null }); // canonical transition DENY

    // 终态 A：DISPUTED / IN_DISPUTE canonical pair（无 split-brain）
    const finalErrand = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errand.id } });
    const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalErrand.status).toBe("DISPUTED");
    expect(finalOrder.status).toBe("IN_DISPUTE");

    const disputes = await rawClient!.orderDispute.findMany({ where: { orderId: order.id } });
    createdDisputeIds.push(...disputes.map((d) => d.id));
    expect(disputes).toHaveLength(1);
  });

  it("OD-RACE-05 resolve vs erasure：resolve 挂起 → erase 等待（同一 USER 锁域）→ holds released → erase proceeds", async () => {
    const seller = await createFixtureUser("RACE05卖家");
    const buyer = await createFixtureUser("RACE05买家");
    const service = await createServiceFixture(seller.id);
    const order = await createGeneralOrder({
      type: "SERVICE", buyerId: buyer.id, sellerId: seller.id,
      serviceListingId: service.id, status: "ACCEPTED",
    });

    const outcome = await initiateDispute({ orderId: order.id, userId: buyer.id, reason: "RACE05" });
    const disputeId = (outcome as { disputeId: string }).disputeId;
    createdDisputeIds.push(disputeId);

    const reviewer = await requireReviewer("RACE05审核员");

    // T1：resolve 挂起（持 reviewer+buyer+seller 完整锁集）
    let signalT1Locked!: () => void;
    const t1Locked = new Promise<void>((resolve) => { signalT1Locked = resolve; });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => { releaseT1 = resolve; });
    const { closeOrderDispute } = await import("@/lib/disputes/order-dispute-service");
    const promiseT1 = closeOrderDispute({
      actorId: reviewer.id,
      disputeId,
      resolutionAction: "CLOSE_ORDER",
      racePoint: async () => {
        signalT1Locked();
        await t1Gate;
      },
    });
    await t1Locked;

    // T2：erase initiator（USER:buyer subject 锁 → 真实等待）
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");
    const promiseT2 = eraseAccount(buyer.id).catch((error: unknown) => error);
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${buyer.id}`]);

    releaseT1();
    const [resultT1, resultT2] = await Promise.allSettled([promiseT1, promiseT2]);

    assertNoSerializationFailure(
      [resultT1, resultT2]
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason),
    );

    expect(resultT1).toMatchObject({ status: "fulfilled" });
    // erase 醒来：holds 已 released + 订单 terminal（CLOSED）→ 放行
    expect(resultT2).toEqual({ status: "fulfilled", value: expect.anything() });

    expect(await activeDisputeHolds(disputeId)).toHaveLength(0);
    const erasedUser = await rawClient!.user.findUniqueOrThrow({ where: { id: buyer.id } });
    expect(erasedUser.erasedAt).not.toBeNull();
    const dispute = await rawClient!.orderDispute.findUniqueOrThrow({ where: { id: disputeId } });
    expect(dispute.status).toBe("CLOSED");
    expect(dispute.reason).toBe("（该内容已随账号注销删除）");
  });

  it("OD-COMM-01（§80）：IN_DISPUTE + pair blocked → active obligation ALLOW；CLOSED + pair blocked → DENY", async () => {
    const seller = await createFixtureUser("COMM01卖家");
    const buyer = await createFixtureUser("COMM01买家");
    const service = await createServiceFixture(seller.id);
    const order = await createGeneralOrder({
      type: "SERVICE", buyerId: buyer.id, sellerId: seller.id,
      serviceListingId: service.id, status: "ACCEPTED",
    });

    await rawClient!.blockedUser.create({
      data: { blockerId: buyer.id, blockedUserId: seller.id, reason: "comm-test" },
    });

    const { resolvePairBlockStateTx, hasActiveOrderObligationTx } = await import("@/lib/trust/communication-policy");

    // IN_DISPUTE：active obligation → blocked 双方仍可必要履约沟通
    const outcome = await initiateDispute({ orderId: order.id, userId: seller.id, reason: "COMM01" });
    const disputeId = (outcome as { disputeId: string }).disputeId;
    createdDisputeIds.push(disputeId);

    const pairState = await resolvePairBlockStateTx(rawClient as never, buyer.id, seller.id);
    expect(pairState.pairBlocked).toBe(true);
    expect(
      await hasActiveOrderObligationTx(rawClient as never, order.id, [buyer.id, seller.id]),
    ).toBe(true);

    // CLOSED：terminal → DENY（无 active obligation）
    const reviewer = await requireReviewer("COMM01审核员");
    await resolveDispute({
      actorId: reviewer.id,
      disputeId,
      resolutionAction: "CLOSE_ORDER",
    });
    expect(
      await hasActiveOrderObligationTx(rawClient as never, order.id, [buyer.id, seller.id]),
    ).toBe(false);
  });
});
