import { randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Phase 8C-02（P8-C02）General OrderDispute 用户入口 + 统一治理运营面
// 集成测试（真实 PostgreSQL）——surface → canonical domain wiring。
//
// 覆盖（指令 §61-§69）：
//   - §62 USER PRODUCT initiation：真实 createProductOrderTx + seller ACCEPT
//     → 真实 server action initiateGeneralOrderDispute → OrderDispute OPEN /
//     Order IN_DISPUTE / 2 holds / notifications
//   - §63 SERVICE IN_PROGRESS / ERRAND PENDING_CONFIRMATION canonical pair
//     走 production adapter path（真实 action）
//   - §64 GOVERNANCE ORDER claim：真实 action disputeKind=ORDER dispatch →
//     IN_REVIEW + assignedTo；RentalDispute 零 mutation
//   - §65 GOVERNANCE ORDER resolve RESTORE_PREVIOUS（ERRAND 双 entity 原子恢复
//     + holds RELEASED + resolution provenance）
//   - §66 GOVERNANCE ORDER close CLOSE_ORDER（PRODUCT ACCEPTED 源 → Order
//     CLOSED + Product release projection）
//   - §67 混合队列：真实 RentalDispute + OrderDispute 同现、全序、kind 正确、
//     cursor 携带 kind、跨页不重复不遗漏
//   - §68 cross-campus：campus reviewer 仅本校区两类纠纷；filter 不扩大范围；
//     GLOBAL 读者全见
//   - §69 wrong-kind：ORDER id + kind=RENTAL（action/detail 双面）→ 统一 deny /
//     { ok:false }，零 mutation

vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

// 用户/运营入口的 session 身份仅 mock requireUser（RBAC 走真实 DB 授权链）
const requireUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-auth", () => ({ requireUser }));

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p8c02-${randomUUID().slice(0, 8)}`;

const createdUserIds: string[] = [];
const createdProductIds: string[] = [];
const createdServiceIds: string[] = [];
const createdErrandIds: string[] = [];
const createdOrderIds: string[] = [];
const createdRentalOrderIds: string[] = [];
const createdRentalListingIds: string[] = [];
const createdMembershipIds: string[] = [];
const createdDisputeIds: string[] = [];
const createdRentalDisputeIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdRentalCategoryIds: string[] = [];
const createdHoldIds: string[] = [];
const createdAssignmentIds: string[] = [];
const createdRoleKeys: string[] = [];

const campusIds: Record<"A" | "B" | "Q", string> = { A: "", B: "", Q: "" };

let fixtureSeq = 0;

/** 当前 server action 的 session 身份（requireUser mock 读取）。 */
let currentUser: { id: string };

/** 真实 RBAC 授权上下文（non-null 断言后返回）。 */
async function authContextOf(userId: string) {
  const { loadAuthorizationContext } = await import("@/lib/rbac/service");
  const context = await loadAuthorizationContext(userId);
  expect(context).not.toBeNull();
  return context!;
}

async function createFixtureUser(name: string, campusId: string) {
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

/** 校区 scope dispute.review reviewer（真实 RBAC 授权链）。 */
async function requireCampusReviewer(name: string, campusId: string) {
  const reviewer = await createFixtureUser(name, campusId);
  const roleKey = `${RUN_TAG}_rv_${randomUUID().slice(0, 8)}`;
  createdRoleKeys.push(roleKey);
  const role = await rawClient!.role.create({
    data: {
      key: roleKey,
      name: `8C02 reviewer ${randomUUID().slice(0, 6)}`,
      scope: "CAMPUS",
      isSystem: false,
      rolePermissions: {
        create: [{ permission: { connect: { key: "dispute.review" } } }],
      },
    },
  });
  const assignment = await rawClient!.userRoleAssignment.create({
    data: { userId: reviewer.id, roleId: role.id, campusId, scopeKey: `CAMPUS:${campusId}` },
  });
  createdAssignmentIds.push(assignment.id);
  return reviewer;
}

/** GLOBAL scope dispute.review 读者（§68 global 臂）。 */
async function requireGlobalReviewer(name: string, campusId: string) {
  const reviewer = await createFixtureUser(name, campusId);
  const roleKey = `${RUN_TAG}_gv_${randomUUID().slice(0, 8)}`;
  createdRoleKeys.push(roleKey);
  const role = await rawClient!.role.create({
    data: {
      key: roleKey,
      name: `8C02 global ${randomUUID().slice(0, 6)}`,
      scope: "GLOBAL",
      isSystem: false,
      rolePermissions: {
        create: [{ permission: { connect: { key: "dispute.review" } } }],
      },
    },
  });
  const assignment = await rawClient!.userRoleAssignment.create({
    data: { userId: reviewer.id, roleId: role.id, campusId: null, scopeKey: "GLOBAL" },
  });
  createdAssignmentIds.push(assignment.id);
  return reviewer;
}

async function createProductFixture(sellerId: string, campusId: string, status: "ACTIVE" | "RESERVED" = "ACTIVE") {
  const category = await rawClient!.productCategory.create({
    data: { name: `8C02类目-${randomUUID().slice(0, 8)}`, slug: `p8c02-${randomUUID().slice(0, 8)}` },
  });
  createdCategoryIds.push(category.id);
  const product = await rawClient!.product.create({
    data: {
      title: `8C02 商品 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8C-02 fixture",
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

async function createServiceFixture(providerId: string, campusId: string) {
  const service = await rawClient!.serviceListing.create({
    data: {
      title: `8C02 服务 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8C-02 fixture",
      price: 20,
      pricingUnit: "PER_SESSION",
      locationText: "东门",
      providerId,
      campusId,
      categoryId: (
        await rawClient!.serviceCategory.create({
          data: { name: `8C02服务类目-${randomUUID().slice(0, 8)}`, slug: `p8c02-svc-${randomUUID().slice(0, 8)}` },
        })
      ).id,
      status: "ACTIVE",
    },
  });
  createdServiceIds.push(service.id);
  return service;
}

async function createErrandFixture(
  publisherId: string,
  accepterId: string | null,
  campusId: string,
  status: string,
) {
  const category = await rawClient!.errandCategory.create({
    data: { name: `8C02跑腿类目-${randomUUID().slice(0, 8)}`, slug: `p8c02-err-${randomUUID().slice(0, 8)}` },
  });
  createdCategoryIds.push(category.id);
  const errand = await rawClient!.errandTask.create({
    data: {
      title: `8C02 跑腿 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8C-02 fixture",
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
) {
  const { updateOrderStatusTx } = await import("@/lib/order-status-service");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    updateOrderStatusTx(tx, actorId, orderId, { requestedStatus }),
  );
}

/** 真实用户 server action 入口（§62：surface 必须真的到 canonical domain）。 */
async function initiateViaAction(orderId: string, userId: string, reason: string) {
  currentUser = { id: userId };
  requireUser.mockResolvedValue({ id: userId });
  const { initiateGeneralOrderDispute } = await import("@/actions/order-dispute");
  const fd = new FormData();
  fd.set("orderId", orderId);
  fd.set("reason", reason);
  return initiateGeneralOrderDispute(fd);
}

async function governanceClaim(disputeId: string, userId: string, disputeKind: "RENTAL" | "ORDER") {
  currentUser = { id: userId };
  requireUser.mockResolvedValue({ id: userId });
  const { claimGovernanceDispute } = await import("@/actions/governance-disputes");
  const fd = new FormData();
  fd.set("disputeId", disputeId);
  fd.set("disputeKind", disputeKind);
  return claimGovernanceDispute(fd);
}

async function governanceResolve(
  disputeId: string,
  userId: string,
  disputeKind: "RENTAL" | "ORDER",
  payload: { resolutionCode?: string; resolutionAction: string; adminNote?: string },
) {
  currentUser = { id: userId };
  requireUser.mockResolvedValue({ id: userId });
  const { resolveGovernanceDispute } = await import("@/actions/governance-disputes");
  const fd = new FormData();
  fd.set("disputeId", disputeId);
  fd.set("disputeKind", disputeKind);
  if (payload.resolutionCode) {
    fd.set("resolutionCode", payload.resolutionCode);
  }
  fd.set("resolutionAction", payload.resolutionAction);
  if (payload.adminNote) {
    fd.set("adminNote", payload.adminNote);
  }
  return resolveGovernanceDispute(fd);
}

async function governanceClose(
  disputeId: string,
  userId: string,
  disputeKind: "RENTAL" | "ORDER",
  resolutionAction: string,
) {
  currentUser = { id: userId };
  requireUser.mockResolvedValue({ id: userId });
  const { closeGovernanceDispute } = await import("@/actions/governance-disputes");
  const fd = new FormData();
  fd.set("disputeId", disputeId);
  fd.set("disputeKind", disputeKind);
  fd.set("resolutionAction", resolutionAction);
  return closeGovernanceDispute(fd);
}

/** 直接 seed OrderDispute（队列读模型测试用；领域行为另有真实链覆盖）。 */
async function seedOrderDisputeDirectly(options: {
  orderId: string;
  initiatorId: string;
  campusId: string;
  status?: "OPEN" | "IN_REVIEW" | "RESOLVED" | "CLOSED";
  openedFromOrderStatus?: string;
  dueAt: Date;
  createdAt?: Date;
}) {
  const dispute = await rawClient!.orderDispute.create({
    data: {
      orderId: options.orderId,
      initiatorId: options.initiatorId,
      reason: `集成测试普通订单纠纷 ${RUN_TAG}`,
      evidencePhotos: [],
      status: options.status ?? "OPEN",
      campusId: options.campusId,
      scopeKey: `CAMPUS:${options.campusId}`,
      openedFromOrderStatus: (options.openedFromOrderStatus ?? "ACCEPTED") as never,
      openedFromErrandStatus: null,
      assignedToId: null,
      dueAt: options.dueAt,
      createdAt: options.createdAt ?? new Date(),
    },
  });
  createdDisputeIds.push(dispute.id);
  return dispute;
}

async function createRentalFixture(options: {
  ownerId: string;
  renterId: string;
  campusId: string;
}) {
  const category = await rawClient!.rentalCategory.create({
    data: { name: `8C02租赁类目-${randomUUID().slice(0, 8)}`, slug: `p8c02-rental-${randomUUID().slice(0, 8)}`, isActive: true },
  });
  createdRentalCategoryIds.push(category.id);
  const listing = await rawClient!.rentalListing.create({
    data: {
      ownerId: options.ownerId,
      categoryId: category.id,
      campusId: options.campusId,
      title: `8C02 租赁 ${randomUUID().slice(0, 6)}`,
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
      depositAmount: 50,
      finalAmount: 150,
      paymentStatus: "OFFLINE_PENDING",
      depositStatus: "PENDING_PAYMENT",
      status: "IN_RENTAL",
      pickupLocationSnapshot: "门口",
      returnLocationSnapshot: "门口",
    },
  });
  createdRentalOrderIds.push(order.id);
  await rawClient!.rentalOrderStatusLog.create({
    data: {
      orderId: order.id,
      fromStatus: "PENDING_PICKUP",
      toStatus: "IN_RENTAL",
      operatorId: options.renterId,
      note: "fixture",
    },
  });
  return { listing, order };
}

async function seedRentalDisputeDirectly(options: {
  orderId: string;
  initiatorId: string;
  campusId: string;
  dueAt: Date;
  createdAt?: Date;
}) {
  const dispute = await rawClient!.rentalDispute.create({
    data: {
      orderId: options.orderId,
      initiatorId: options.initiatorId,
      reason: `集成测试租赁纠纷 ${RUN_TAG}`,
      evidencePhotos: [],
      status: "OPEN",
      campusId: options.campusId,
      scopeKey: `CAMPUS:${options.campusId}`,
      openedFromOrderStatus: "IN_RENTAL",
      assignedToId: null,
      dueAt: options.dueAt,
      createdAt: options.createdAt ?? new Date(),
    },
  });
  createdRentalDisputeIds.push(dispute.id);
  return dispute;
}

beforeAll(async () => {
  if (!integrationDatabaseUrl || !rawClient) return;

  for (const key of ["A", "B", "Q"] as const) {
    const campus = await rawClient.campus.create({
      data: {
        name: `P8C02-${key}-${RUN_TAG}`,
        slug: `p8c02-${key.toLowerCase()}-${randomUUID().slice(0, 8)}`,
        schoolName: "集成测试大学",
      },
    });
    campusIds[key] = campus.id;
  }
});

afterAll(async () => {
  if (!rawClient) return;

  // §88：严格反向 FK 清理；禁止 silent catch；Campus 最后删除 + sentinel
  await rawClient.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await rawClient.adminLog.deleteMany({ where: { adminId: { in: createdUserIds } } });
  await rawClient.dataHold.deleteMany({
    where: { OR: [{ subjectId: { in: createdUserIds } }, { id: { in: createdHoldIds } }] },
  });
  await rawClient.orderDispute.deleteMany({ where: { id: { in: createdDisputeIds } } });
  await rawClient.rentalDispute.deleteMany({ where: { id: { in: createdRentalDisputeIds } } });
  await rawClient.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await rawClient.rentalOrderStatusLog.deleteMany({ where: { orderId: { in: createdRentalOrderIds } } });
  await rawClient.rentalOrder.deleteMany({ where: { id: { in: createdRentalOrderIds } } });
  await rawClient.errandTask.deleteMany({ where: { id: { in: createdErrandIds } } });
  await rawClient.product.deleteMany({ where: { id: { in: createdProductIds } } });
  await rawClient.serviceListing.deleteMany({ where: { id: { in: createdServiceIds } } });
  await rawClient.rentalListing.deleteMany({ where: { id: { in: createdRentalListingIds } } });
  await rawClient.productCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await rawClient.rentalCategory.deleteMany({ where: { id: { in: createdRentalCategoryIds } } });
  await rawClient.errandCategory.deleteMany({ where: { slug: { startsWith: "p8c02-err-" } } });
  await rawClient.serviceCategory.deleteMany({ where: { slug: { startsWith: "p8c02-svc-" } } });
  await rawClient.userRoleAssignment.deleteMany({ where: { id: { in: createdAssignmentIds } } });
  await rawClient.role.deleteMany({ where: { key: { in: createdRoleKeys } } });
  await rawClient.campusMembership.deleteMany({ where: { id: { in: createdMembershipIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } });
  for (const key of ["A", "B", "Q"] as const) {
    await rawClient.campus.deleteMany({ where: { id: campusIds[key] } });
    const remaining = await rawClient.campus.count({ where: { id: campusIds[key] } });
    expect(remaining).toBe(0);
  }

  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl)("Phase 8C-02 dispute surfaces（真实 PG）", () => {
  it("IT-01 §62：USER PRODUCT initiation——真实下单+accept → 真实 action → canonical domain", async () => {
    const seller = await createFixtureUser("IT01卖家", campusIds.A);
    const buyer = await createFixtureUser("IT01买家", campusIds.A);
    const product = await createProductFixture(seller.id, campusIds.A);

    const order = await placeRealOrder({
      buyerId: buyer.id,
      product: { id: product.id, price: "10", sellerId: seller.id, campusId: campusIds.A },
    });
    expect(order).not.toBeNull();
    expect(await transitionOrder(seller.id, order!.id, "ACCEPTED")).not.toBeNull();

    const actionResult = await initiateViaAction(order!.id, buyer.id, "IT01 商品与描述不符，要求处理");
    expect(actionResult).toEqual({ success: true, message: "纠纷已提交，订单已进入处理流程" });

    const dispute = await rawClient!.orderDispute.findFirstOrThrow({
      where: { orderId: order!.id },
    });
    createdDisputeIds.push(dispute.id);
    expect(dispute.status).toBe("OPEN");
    expect(dispute.initiatorId).toBe(buyer.id);
    expect(dispute.campusId).toBe(campusIds.A);
    expect(dispute.evidencePhotos).toEqual([]);

    const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order!.id } });
    expect(finalOrder.status).toBe("IN_DISPUTE");

    const holds = await rawClient!.dataHold.findMany({
      where: { sourceType: "ORDER_DISPUTE", sourceId: dispute.id, status: "ACTIVE" },
    });
    createdHoldIds.push(...holds.map((h) => h.id));
    expect(holds.map((h) => h.subjectId).sort()).toEqual([buyer.id, seller.id].sort());

    expect(
      await rawClient!.notification.count({ where: { userId: buyer.id, orderId: order!.id } }),
    ).toBeGreaterThan(0);
    expect(
      await rawClient!.notification.count({ where: { userId: seller.id, orderId: order!.id } }),
    ).toBeGreaterThan(0);
  });

  it("IT-02 §63：SERVICE / ERRAND canonical pair 走 production adapter path", async () => {
    const provider = await createFixtureUser("IT02服务者", campusIds.A);
    const buyer = await createFixtureUser("IT02买家", campusIds.A);
    const service = await createServiceFixture(provider.id, campusIds.A);
    const serviceOrder = await createGeneralOrder({
      type: "SERVICE",
      buyerId: buyer.id,
      sellerId: provider.id,
      serviceListingId: service.id,
      status: "IN_PROGRESS",
    });

    const serviceResult = await initiateViaAction(serviceOrder.id, provider.id, "IT02 服务未按约定交付");
    expect(serviceResult.success).toBe(true);
    const serviceDispute = await rawClient!.orderDispute.findFirstOrThrow({
      where: { orderId: serviceOrder.id },
    });
    createdDisputeIds.push(serviceDispute.id);
    expect(serviceDispute.openedFromOrderStatus).toBe("IN_PROGRESS");
    expect((await rawClient!.serviceListing.findUniqueOrThrow({ where: { id: service.id } })).status).toBe("ACTIVE");

    // ERRAND canonical pair：Order IN_PROGRESS ↔ ErrandTask PENDING_CONFIRMATION
    const publisher = await createFixtureUser("IT02发布者", campusIds.A);
    const accepter = await createFixtureUser("IT02接单者", campusIds.A);
    const errand = await createErrandFixture(publisher.id, accepter.id, campusIds.A, "PENDING_CONFIRMATION");
    const errandOrder = await createGeneralOrder({
      type: "ERRAND",
      buyerId: publisher.id,
      sellerId: accepter.id,
      errandTaskId: errand.id,
      status: "IN_PROGRESS",
    });

    const errandResult = await initiateViaAction(errandOrder.id, accepter.id, "IT02 跑腿交付存在争议说明");
    expect(errandResult.success).toBe(true);
    const errandDispute = await rawClient!.orderDispute.findFirstOrThrow({
      where: { orderId: errandOrder.id },
    });
    createdDisputeIds.push(errandDispute.id);
    expect(errandDispute.openedFromOrderStatus).toBe("IN_PROGRESS");
    expect(errandDispute.openedFromErrandStatus).toBe("PENDING_CONFIRMATION");
    expect((await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errand.id } })).status).toBe("DISPUTED");
  });

  it("IT-03 §64：GOVERNANCE ORDER claim——action dispatch → IN_REVIEW；RentalDispute 零 mutation", async () => {
    const seller = await createFixtureUser("IT03卖家", campusIds.A);
    const buyer = await createFixtureUser("IT03买家", campusIds.A);
    const product = await createProductFixture(seller.id, campusIds.A);
    const order = await placeRealOrder({
      buyerId: buyer.id,
      product: { id: product.id, price: "10", sellerId: seller.id, campusId: campusIds.A },
    });
    await transitionOrder(seller.id, order!.id, "ACCEPTED");
    const disputeOutcome = await initiateViaAction(order!.id, buyer.id, "IT03 发起纠纷原因说明");
    expect(disputeOutcome.success).toBe(true);
    const dispute = await rawClient!.orderDispute.findFirstOrThrow({ where: { orderId: order!.id } });
    createdDisputeIds.push(dispute.id);

    // 同校区 rental dispute 夹具：ORDER claim 不得触碰
    const owner = await createFixtureUser("IT03出租者", campusIds.A);
    const renter = await createFixtureUser("IT03租客", campusIds.A);
    const rental = await createRentalFixture({ ownerId: owner.id, renterId: renter.id, campusId: campusIds.A });
    const rentalDispute = await seedRentalDisputeDirectly({
      orderId: rental.order.id,
      initiatorId: renter.id,
      campusId: campusIds.A,
      dueAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    });

    const reviewer = await requireCampusReviewer("IT03审核员", campusIds.A);
    const claimResult = await governanceClaim(dispute.id, reviewer.id, "ORDER");
    expect(claimResult).toEqual({ success: true, outcome: "CLAIMED" });

    const after = await rawClient!.orderDispute.findUniqueOrThrow({ where: { id: dispute.id } });
    expect(after.status).toBe("IN_REVIEW");
    expect(after.assignedToId).toBe(reviewer.id);

    const rentalAfter = await rawClient!.rentalDispute.findUniqueOrThrow({ where: { id: rentalDispute.id } });
    expect(rentalAfter.status).toBe("OPEN");
    expect(rentalAfter.assignedToId).toBeNull();
  });

  it("IT-04 §65：GOVERNANCE ORDER resolve RESTORE_PREVIOUS——ERRAND 双 entity 原子恢复 + holds 释放 + provenance", async () => {
    const publisher = await createFixtureUser("IT04发布者", campusIds.A);
    const accepter = await createFixtureUser("IT04接单者", campusIds.A);
    const errand = await createErrandFixture(publisher.id, accepter.id, campusIds.A, "PENDING_CONFIRMATION");
    const order = await createGeneralOrder({
      type: "ERRAND",
      buyerId: publisher.id,
      sellerId: accepter.id,
      errandTaskId: errand.id,
      status: "IN_PROGRESS",
    });

    const initiateResult = await initiateViaAction(order.id, accepter.id, "IT04 跑腿纠纷原因说明");
    expect(initiateResult.success).toBe(true);
    const dispute = await rawClient!.orderDispute.findFirstOrThrow({ where: { orderId: order.id } });
    createdDisputeIds.push(dispute.id);
    createdHoldIds.push(
      ...(await rawClient!.dataHold.findMany({ where: { sourceType: "ORDER_DISPUTE", sourceId: dispute.id } })).map((h) => h.id),
    );

    const reviewer = await requireCampusReviewer("IT04审核员", campusIds.A);
    const resolveResult = await governanceResolve(dispute.id, reviewer.id, "ORDER", {
      resolutionCode: "MUTUAL_AGREEMENT",
      resolutionAction: "RESTORE_PREVIOUS",
      adminNote: "双方协商一致恢复",
    });
    expect(resolveResult).toEqual({ success: true });

    const afterDispute = await rawClient!.orderDispute.findUniqueOrThrow({ where: { id: dispute.id } });
    expect(afterDispute.status).toBe("RESOLVED");
    expect(afterDispute.resolutionCode).toBe("MUTUAL_AGREEMENT");
    expect(afterDispute.resolutionAction).toBe("RESTORE_PREVIOUS");
    expect(afterDispute.resolvedById).toBe(reviewer.id);
    expect(afterDispute.resolvedAt).not.toBeNull();
    expect(afterDispute.adminNote).toBe("双方协商一致恢复");

    const afterOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(afterOrder.status).toBe("IN_PROGRESS"); // restored openedFrom
    const afterErrand = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errand.id } });
    expect(afterErrand.status).toBe("PENDING_CONFIRMATION"); // restored pair

    const holds = await rawClient!.dataHold.findMany({
      where: { sourceType: "ORDER_DISPUTE", sourceId: dispute.id },
    });
    expect(holds).toHaveLength(2);
    expect(holds.every((h) => h.status === "RELEASED")).toBe(true);
  });

  it("IT-05 §66：GOVERNANCE ORDER close CLOSE_ORDER——Order CLOSED + Product release projection", async () => {
    const seller = await createFixtureUser("IT05卖家", campusIds.A);
    const buyer = await createFixtureUser("IT05买家", campusIds.A);
    const product = await createProductFixture(seller.id, campusIds.A);
    const order = await placeRealOrder({
      buyerId: buyer.id,
      product: { id: product.id, price: "10", sellerId: seller.id, campusId: campusIds.A },
    });
    await transitionOrder(seller.id, order!.id, "ACCEPTED");
    expect((await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status).toBe("RESERVED");

    const initiateResult = await initiateViaAction(order!.id, buyer.id, "IT05 商品争议关闭场景");
    expect(initiateResult.success).toBe(true);
    const dispute = await rawClient!.orderDispute.findFirstOrThrow({ where: { orderId: order!.id } });
    createdDisputeIds.push(dispute.id);

    const reviewer = await requireCampusReviewer("IT05审核员", campusIds.A);
    const closeResult = await governanceClose(dispute.id, reviewer.id, "ORDER", "CLOSE_ORDER");
    expect(closeResult).toEqual({ success: true });

    const afterOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: order!.id } });
    expect(afterOrder.status).toBe("CLOSED");
    const afterDispute = await rawClient!.orderDispute.findUniqueOrThrow({ where: { id: dispute.id } });
    expect(afterDispute.status).toBe("CLOSED");
    expect(afterDispute.resolutionAction).toBe("CLOSE_ORDER");

    // PRODUCT release projection：RESERVED + 无其它 active order + seller ACTIVE → ACTIVE
    const productAfter = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(productAfter.status).toBe("ACTIVE");

    const holds = await rawClient!.dataHold.findMany({
      where: { sourceType: "ORDER_DISPUTE", sourceId: dispute.id },
    });
    expect(holds.every((h) => h.status === "RELEASED")).toBe(true);
  });

  it("IT-06 §67：混合队列——真实 RentalDispute + OrderDispute 同现/全序/kind/cursor/跨页", async () => {
    const owner = await createFixtureUser("IT06出租者", campusIds.Q);
    const renter = await createFixtureUser("IT06租客", campusIds.Q);
    const seller = await createFixtureUser("IT06卖家", campusIds.Q);
    const buyer = await createFixtureUser("IT06买家", campusIds.Q);

    const rental = await createRentalFixture({ ownerId: owner.id, renterId: renter.id, campusId: campusIds.Q });
    const productTie = await createProductFixture(seller.id, campusIds.Q);
    const orderTieOrder = await createGeneralOrder({
      type: "PRODUCT",
      buyerId: buyer.id,
      sellerId: seller.id,
      productId: productTie.id,
      status: "ACCEPTED",
    });
    const productEarly = await createProductFixture(seller.id, campusIds.Q);
    const orderEarlyOrder = await createGeneralOrder({
      type: "PRODUCT",
      buyerId: buyer.id,
      sellerId: seller.id,
      productId: productEarly.id,
      status: "ACCEPTED",
    });

    const tieDue = new Date("2030-01-03T00:00:00.000Z");
    const tieCreated = new Date("2030-01-02T00:00:00.000Z");
    const earlyDue = new Date("2030-01-01T00:00:00.000Z");

    const rentalTie = await seedRentalDisputeDirectly({
      orderId: rental.order.id,
      initiatorId: renter.id,
      campusId: campusIds.Q,
      dueAt: tieDue,
      createdAt: tieCreated,
    });
    const orderTie = await seedOrderDisputeDirectly({
      orderId: orderTieOrder.id,
      initiatorId: buyer.id,
      campusId: campusIds.Q,
      dueAt: tieDue,
      createdAt: tieCreated,
    });
    const orderEarly = await seedOrderDisputeDirectly({
      orderId: orderEarlyOrder.id,
      initiatorId: buyer.id,
      campusId: campusIds.Q,
      dueAt: earlyDue,
      createdAt: new Date("2030-01-02T00:00:00.000Z"),
      openedFromOrderStatus: "ACCEPTED",
    });

    const reviewer = await requireCampusReviewer("IT06审核员", campusIds.Q);
    const { loadAuthorizationContext } = await import("@/lib/rbac/service");
    const { deriveDisputeReviewAccess } = await import("@/lib/disputes/dispute-access");
    const { loadAuthorizedDisputeQueue } = await import("@/lib/disputes/dispute-query");
    const context = await loadAuthorizationContext(reviewer.id);
    const access = deriveDisputeReviewAccess(context);
    expect(access.campusIds).toContain(campusIds.Q);

    const page = await loadAuthorizedDisputeQueue({
      viewerId: reviewer.id,
      access,
      limit: 25,
      filters: { campusId: campusIds.Q },
    });

    const qItems = page.items.filter((i) => i.campusId === campusIds.Q);
    expect(qItems.map((i) => `${i.disputeKind}:${i.disputeId}`)).toEqual([
      `ORDER:${orderEarly.id}`,
      `ORDER:${orderTie.id}`,
      `RENTAL:${rentalTie.id}`,
    ]);
    expect(qItems[0]!.transactionKindLabel).toBe("商品订单纠纷");
    expect(qItems[0]!.safeOrderLabel).toContain("二手商品");
    expect(qItems[2]!.transactionKindLabel).toBe("租赁纠纷");
    // queue DTO 不含敏感字段
    for (const item of qItems) {
      expect(JSON.stringify(item)).not.toContain("集成测试");
      expect(Object.keys(item)).not.toContain("reason");
    }

    // kind filter
    const orderOnly = await loadAuthorizedDisputeQueue({
      viewerId: reviewer.id,
      access,
      limit: 25,
      filters: { campusId: campusIds.Q, kind: "ORDER" },
    });
    expect(orderOnly.items.every((i) => i.disputeKind === "ORDER")).toBe(true);
    expect(orderOnly.items.some((i) => i.disputeId === rentalTie.id)).toBe(false);

    // 跨页不重复不遗漏（limit=1 全量走完）
    const seen: string[] = [];
    const { decodeDisputeCursor } = await import("@/lib/disputes/dispute-query");
    let cursor: ReturnType<typeof decodeDisputeCursor> = null;
    for (let i = 0; i < 10; i += 1) {
      const result = await loadAuthorizedDisputeQueue({
        viewerId: reviewer.id,
        access,
        limit: 1,
        filters: { campusId: campusIds.Q },
        cursor: cursor ?? undefined,
      });
      for (const item of result.items) {
        seen.push(`${item.disputeKind}:${item.disputeId}`);
      }
      if (!result.nextCursor) break;
      const decoded = decodeDisputeCursor(result.nextCursor);
      expect(decoded).not.toBeNull();
      expect(["ORDER", "RENTAL"]).toContain(decoded!.kind); // cursor 携带 kind
      cursor = decoded;
    }
    expect(seen).toEqual([
      `ORDER:${orderEarly.id}`,
      `ORDER:${orderTie.id}`,
      `RENTAL:${rentalTie.id}`,
    ]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("IT-07 §68：cross-campus——campus reviewer 仅本校区两类纠纷；filter 不扩大范围；GLOBAL 全见", async () => {
    const ownerA = await createFixtureUser("IT07出租A", campusIds.A);
    const renterA = await createFixtureUser("IT07租客A", campusIds.A);
    const sellerB = await createFixtureUser("IT07卖家B", campusIds.B);
    const buyerB = await createFixtureUser("IT07买家B", campusIds.B);

    const rentalA = await createRentalFixture({ ownerId: ownerA.id, renterId: renterA.id, campusId: campusIds.A });
    const productB = await createProductFixture(sellerB.id, campusIds.B);
    const orderB = await createGeneralOrder({
      type: "PRODUCT",
      buyerId: buyerB.id,
      sellerId: sellerB.id,
      productId: productB.id,
      status: "ACCEPTED",
    });

    const rentalDisputeA = await seedRentalDisputeDirectly({
      orderId: rentalA.order.id,
      initiatorId: renterA.id,
      campusId: campusIds.A,
      dueAt: new Date("2030-02-01T00:00:00.000Z"),
    });
    const orderDisputeB = await seedOrderDisputeDirectly({
      orderId: orderB.id,
      initiatorId: buyerB.id,
      campusId: campusIds.B,
      dueAt: new Date("2030-02-02T00:00:00.000Z"),
    });

    const reviewerA = await requireCampusReviewer("IT07审核A", campusIds.A);
    const { loadAuthorizationContext } = await import("@/lib/rbac/service");
    const { deriveDisputeReviewAccess } = await import("@/lib/disputes/dispute-access");
    const { loadAuthorizedDisputeQueue } = await import("@/lib/disputes/dispute-query");

    const accessA = deriveDisputeReviewAccess(await loadAuthorizationContext(reviewerA.id));
    const pageA = await loadAuthorizedDisputeQueue({ viewerId: reviewerA.id, access: accessA, limit: 50 });
    expect(pageA.items.some((i) => i.disputeId === rentalDisputeA.id)).toBe(true);
    expect(pageA.items.some((i) => i.disputeId === orderDisputeB.id)).toBe(false);

    // kind filter 不扩大校区授权范围（仅 campus A 的 ORDER 行）
    const pageAOrder = await loadAuthorizedDisputeQueue({
      viewerId: reviewerA.id,
      access: accessA,
      limit: 50,
      filters: { kind: "ORDER" },
    });
    expect(pageAOrder.items.every((i) => i.disputeKind === "ORDER" && i.campusId === campusIds.A)).toBe(true);

    // GLOBAL 读者两类全见
    const globalReviewer = await requireGlobalReviewer("IT07全局审核", campusIds.A);
    const accessG = deriveDisputeReviewAccess(await loadAuthorizationContext(globalReviewer.id));
    expect(accessG.global).toBe(true);
    const pageG = await loadAuthorizedDisputeQueue({ viewerId: globalReviewer.id, access: accessG, limit: 50 });
    expect(pageG.items.some((i) => i.disputeId === rentalDisputeA.id)).toBe(true);
    expect(pageG.items.some((i) => i.disputeId === orderDisputeB.id)).toBe(true);

    // 详情 cross-campus：reviewer A 打不开 campus B 的 ORDER dispute
    const { loadAuthorizedDisputeDetail } = await import("@/lib/disputes/dispute-query");
    const detailDenied = await loadAuthorizedDisputeDetail({
      viewerId: reviewerA.id,
      context: await authContextOf(reviewerA.id),
      access: accessA,
      disputeId: orderDisputeB.id,
      kind: "ORDER",
    });
    expect(detailDenied).toEqual({ ok: false });
  });

  it("IT-08 §69：wrong-kind——action 统一 deny + detail { ok:false } + 零 mutation", async () => {
    const owner = await createFixtureUser("IT08出租者", campusIds.A);
    const renter = await createFixtureUser("IT08租客", campusIds.A);
    const rental = await createRentalFixture({ ownerId: owner.id, renterId: renter.id, campusId: campusIds.A });
    const rentalDispute = await seedRentalDisputeDirectly({
      orderId: rental.order.id,
      initiatorId: renter.id,
      campusId: campusIds.A,
      dueAt: new Date("2030-03-01T00:00:00.000Z"),
    });

    const reviewer = await requireCampusReviewer("IT08审核员", campusIds.A);

    // RENTAL dispute id + disputeKind=ORDER → 统一 deny，零 mutation
    const denyResult = await governanceClaim(rentalDispute.id, reviewer.id, "ORDER");
    expect(denyResult).toEqual({ success: false, error: "没有权限处理该纠纷" });
    const rentalAfter = await rawClient!.rentalDispute.findUniqueOrThrow({ where: { id: rentalDispute.id } });
    expect(rentalAfter.status).toBe("OPEN");
    expect(rentalAfter.assignedToId).toBeNull();

    // ORDER dispute id + kind=RENTAL detail → notFound 同形
    const seller = await createFixtureUser("IT08卖家", campusIds.A);
    const buyer = await createFixtureUser("IT08买家", campusIds.A);
    const product = await createProductFixture(seller.id, campusIds.A);
    const order = await placeRealOrder({
      buyerId: buyer.id,
      product: { id: product.id, price: "10", sellerId: seller.id, campusId: campusIds.A },
    });
    await transitionOrder(seller.id, order!.id, "ACCEPTED");
    await initiateViaAction(order!.id, buyer.id, "IT08 普通订单纠纷原因");
    const orderDispute = await rawClient!.orderDispute.findFirstOrThrow({ where: { orderId: order!.id } });
    createdDisputeIds.push(orderDispute.id);

    const { loadAuthorizationContext } = await import("@/lib/rbac/service");
    const { deriveDisputeReviewAccess } = await import("@/lib/disputes/dispute-access");
    const { loadAuthorizedDisputeDetail } = await import("@/lib/disputes/dispute-query");
    const detailWrongKind = await loadAuthorizedDisputeDetail({
      viewerId: reviewer.id,
      context: await authContextOf(reviewer.id),
      access: deriveDisputeReviewAccess(await loadAuthorizationContext(reviewer.id)),
      disputeId: orderDispute.id,
      kind: "RENTAL",
    });
    expect(detailWrongKind).toEqual({ ok: false });

    // 正向仍可达：kind=ORDER → Stage B（同一 reviewer）
    const detailRightKind = await loadAuthorizedDisputeDetail({
      viewerId: reviewer.id,
      context: await authContextOf(reviewer.id),
      access: deriveDisputeReviewAccess(await loadAuthorizationContext(reviewer.id)),
      disputeId: orderDispute.id,
      kind: "ORDER",
    });
    expect(detailRightKind).toMatchObject({ ok: true, kind: "ORDER" });
    if (detailRightKind.ok && detailRightKind.kind === "ORDER") {
      expect(detailRightKind.detail.reason).toBe("IT08 普通订单纠纷原因");
    }
  });

  it("IT-09 §11：cross-kind 对抗翻页——cursor 过 ORDER 后，同刻 (D, c<C) RENTAL 绝不重现", async () => {
    const seller = await createFixtureUser("IT09卖家", campusIds.Q);
    const buyer = await createFixtureUser("IT09买家", campusIds.Q);

    // same dueAt D；createdAt 错开——kind 仅在 dueAt+createdAt 都相等时参与排序
    const D = new Date("2030-04-01T00:00:00.000Z");
    const C = new Date("2030-04-01T12:00:00.000Z");
    const hour = 60 * 60 * 1000;

    const mkRental = async (name: string, createdAt: Date) => {
      const o = await createFixtureUser(`${name}出租`, campusIds.Q);
      const r = await createFixtureUser(`${name}租客`, campusIds.Q);
      const fixture = await createRentalFixture({ ownerId: o.id, renterId: r.id, campusId: campusIds.Q });
      return seedRentalDisputeDirectly({
        orderId: fixture.order.id,
        initiatorId: r.id,
        campusId: campusIds.Q,
        dueAt: D,
        createdAt,
      });
    };
    const rentalBefore = await mkRental("IT09B", new Date(C.getTime() - hour));
    const rentalSame = await mkRental("IT09S", C);
    const rentalAfter = await mkRental("IT09A", new Date(C.getTime() + hour));

    const product = await createProductFixture(seller.id, campusIds.Q);
    const orderCursorOrder = await createGeneralOrder({
      type: "PRODUCT",
      buyerId: buyer.id,
      sellerId: seller.id,
      productId: product.id,
      status: "ACCEPTED",
    });
    const orderCursor = await seedOrderDisputeDirectly({
      orderId: orderCursorOrder.id,
      initiatorId: buyer.id,
      campusId: campusIds.Q,
      dueAt: D,
      createdAt: C,
    });

    const reviewer = await requireCampusReviewer("IT09审核员", campusIds.Q);
    const { loadAuthorizationContext } = await import("@/lib/rbac/service");
    const { deriveDisputeReviewAccess } = await import("@/lib/disputes/dispute-access");
    const { encodeDisputeCursor, decodeDisputeCursor, loadAuthorizedDisputeQueue } = await import(
      "@/lib/disputes/dispute-query"
    );
    const access = deriveDisputeReviewAccess(await loadAuthorizationContext(reviewer.id));

    // ── 显式 cursor = ORDER-cursor：limit=1 走到结尾。global truth：
    // rental-before → order-cursor → rental-same → rental-after；
    // cursor 过 ORDER 后只能返回 rental-same / rental-after，
    // (D, c<C) 的 rental-before 绝不可重现（review blocker 回归）
    const seen: string[] = [];
    let rawCursor: string | null = encodeDisputeCursor({
      dueAt: D,
      createdAt: C,
      kind: "ORDER",
      id: orderCursor.id,
    });
    for (let i = 0; i < 5 && rawCursor; i += 1) {
      const decoded = decodeDisputeCursor(rawCursor);
      expect(decoded).not.toBeNull();
      const result = await loadAuthorizedDisputeQueue({
        viewerId: reviewer.id,
        access,
        limit: 1,
        filters: { campusId: campusIds.Q },
        cursor: decoded!,
      });
      seen.push(...result.items.map((item) => `${item.disputeKind}:${item.disputeId}`));
      rawCursor = result.nextCursor;
    }
    expect(seen).toEqual([`RENTAL:${rentalSame.id}`, `RENTAL:${rentalAfter.id}`]);
    expect(seen).not.toContain(`RENTAL:${rentalBefore.id}`);

    // ── 完整遍历（campus Q 全量，limit=1）：zero duplicate；adversarial 四行
    // 按独立计算的 canonical tuple 顺序出现（dueAt → createdAt → kind → id；
    // 测试自建 comparator，不复用生产 comparator）
    const KIND_RANK = { ORDER: 0, RENTAL: 1 } as const;
    const adversarial = [
      { kind: "RENTAL" as const, id: rentalBefore.id, createdAt: new Date(C.getTime() - hour) },
      { kind: "ORDER" as const, id: orderCursor.id, createdAt: C },
      { kind: "RENTAL" as const, id: rentalSame.id, createdAt: C },
      { kind: "RENTAL" as const, id: rentalAfter.id, createdAt: new Date(C.getTime() + hour) },
    ];
    const adversarialExpected = adversarial
      .slice()
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
          (a.id < b.id ? -1 : 1),
      )
      .map((r) => `${r.kind}:${r.id}`);

    const allSeen: string[] = [];
    let walkCursor: Awaited<ReturnType<typeof decodeDisputeCursor>> = null;
    for (let i = 0; i < 30; i += 1) {
      const result = await loadAuthorizedDisputeQueue({
        viewerId: reviewer.id,
        access,
        limit: 1,
        filters: { campusId: campusIds.Q },
        cursor: walkCursor ?? undefined,
      });
      allSeen.push(...result.items.map((item) => `${item.disputeKind}:${item.disputeId}`));
      if (!result.nextCursor) break;
      walkCursor = decodeDisputeCursor(result.nextCursor);
      expect(walkCursor).not.toBeNull();
      expect(["ORDER", "RENTAL"]).toContain(walkCursor!.kind);
    }

    expect(new Set(allSeen).size).toBe(allSeen.length);
    expect(allSeen.filter((s) => adversarialExpected.includes(s))).toEqual(adversarialExpected);
    expect(allSeen).toContain(`ORDER:${orderCursor.id}`);
  });
});
