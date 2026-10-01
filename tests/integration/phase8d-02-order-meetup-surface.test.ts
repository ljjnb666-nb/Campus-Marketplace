import { randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MEETUP_HISTORY_LIMIT, getOrderMeetupView } from "@/lib/meetups/order-meetup-query";

// Phase 8D-02（P8-D02）Meetup 用户面 read projection / query 集成测试
// （真实 PostgreSQL）——read authorization + snapshot 权威 + campus 隔离。
//
// 覆盖（指令 §21 + §19 READ-01..06）：
//   - participant visibility：buyer / seller 可读自己的 PRODUCT / SERVICE
//     meetup 投影；第三方统一 null 且不泄露 meetup 是否存在 / 地点 / 时间
//   - type authority：ERRAND 参与方也 null（不进入 General Meetup 面）
//   - campus MeetupPoint list isolation：候选列表只含 authoritative campus
//     + isActive 的点；cross-campus 点 / inactive 点不泄漏
//   - deleted catalog point snapshot preservation：MeetupPoint 行删除
//     （meetupPointId → SET NULL）后历史仍显示 locationTextSnapshot +
//     MEETUP_POINT provenance，绝不 REDACT / blank
//   - current + history ordering：createdAt 倒序、≤ MEETUP_HISTORY_LIMIT
//     明确有序截断
//   - custom proposer erasure：locationSource=CUSTOM + REDACT marker 仍按
//     快照原样展示合法 marker（read 面不做"恢复"或改写）

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

const RUN_TAG = `p8d02-${randomUUID().slice(0, 8)}`;

const createdUserIds: string[] = [];
const createdProductIds: string[] = [];
const createdServiceIds: string[] = [];
const createdErrandIds: string[] = [];
const createdOrderIds: string[] = [];
const createdMembershipIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdServiceCategoryIds: string[] = [];
const createdErrandCategoryIds: string[] = [];
const createdPointIds: string[] = [];
const createdMeetupIds: string[] = [];

const campusIds: Record<"A" | "B", string> = { A: "", B: "" };

let fixtureSeq = 0;

const HOUR = 60 * 60 * 1000;

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

async function createProductFixture(sellerId: string, campusId: string) {
  const category = await rawClient!.productCategory.create({
    data: { name: `8D02类目-${randomUUID().slice(0, 8)}`, slug: `p8d02-${randomUUID().slice(0, 8)}` },
  });
  createdCategoryIds.push(category.id);
  const product = await rawClient!.product.create({
    data: {
      title: `8D02 商品 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8D-02 fixture",
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

async function createServiceFixture(providerId: string, campusId: string) {
  const service = await rawClient!.serviceListing.create({
    data: {
      title: `8D02 服务 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8D-02 fixture",
      price: 20,
      pricingUnit: "PER_SESSION",
      locationText: "东门",
      providerId,
      campusId,
      categoryId: (await rawClient!.serviceCategory.create({
        data: { name: `8D02服务类目-${randomUUID().slice(0, 8)}`, slug: `p8d02-svc-${randomUUID().slice(0, 8)}` },
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

async function createErrandFixture(publisherId: string, accepterId: string, campusId: string) {
  const category = await rawClient!.errandCategory.create({
    data: { name: `8D02跑腿类目-${randomUUID().slice(0, 8)}`, slug: `p8d02-err-${randomUUID().slice(0, 8)}` },
  });
  createdErrandCategoryIds.push(category.id);
  const errand = await rawClient!.errandTask.create({
    data: {
      title: `8D02 跑腿 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8D-02 fixture",
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
  status?: string;
}) {
  const order = await rawClient!.order.create({
    data: {
      orderNo: `${RUN_TAG}${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
      type: input.type,
      status: (input.status ?? "ACCEPTED") as never,
      buyerId: input.buyerId,
      sellerId: input.sellerId,
      productId: input.productId ?? null,
      serviceListingId: input.serviceListingId ?? null,
      errandTaskId: input.errandTaskId ?? null,
      amount: "10.00",
      meetingLocation: "下单初始偏好",
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

async function createMeetupPoint(input: { campusId: string; name?: string; isActive?: boolean }) {
  const point = await rawClient!.meetupPoint.create({
    data: {
      campusId: input.campusId,
      name: input.name ?? `8D02见面点-${randomUUID().slice(0, 6)}`,
      locationText: "图书馆北门台阶",
      isActive: input.isActive ?? true,
    },
  });
  createdPointIds.push(point.id);
  return point;
}

/** 经 canonical proposeOrderMeetupTx 创建（保持 proposal 语义真实）。 */
async function proposeMeetup(input: {
  orderId: string;
  proposerId: string;
  meetupPointId?: string | null;
  locationText?: string | null;
}) {
  const { proposeOrderMeetupTx } = await import("@/lib/meetups/order-meetup-service");
  const { withTransaction } = await import("@/lib/prisma");
  const outcome = await withTransaction((tx: Prisma.TransactionClient) =>
    proposeOrderMeetupTx(tx, {
      orderId: input.orderId,
      proposerId: input.proposerId,
      scheduledAt: new Date(Date.now() + HOUR),
      meetupPointId: input.meetupPointId ?? null,
      locationText: input.locationText ?? null,
    }),
  );
  if ("success" in outcome && outcome.success) createdMeetupIds.push(outcome.meetupId);
  return outcome;
}

async function cancelMeetup(input: { orderId: string; meetupId: string; actorId: string }) {
  const { cancelOrderMeetupTx } = await import("@/lib/meetups/order-meetup-service");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) => cancelOrderMeetupTx(tx, input));
}

beforeAll(async () => {
  if (!rawClient) return;
  for (const key of ["A", "B"] as const) {
    const campus = await rawClient.campus.create({
      data: {
        name: `8D02校区-${key}-${randomUUID().slice(0, 6)}`,
        slug: `p8d02-${key}-${randomUUID().slice(0, 8)}`,
        schoolName: "集成测试大学",
      },
    });
    campusIds[key] = campus.id;
  }
});

afterAll(async () => {
  if (!rawClient) return;
  // 子 → 父删除序（OrderMeetup 随 Order cascade；listing/category/user/campus 手动）
  await rawClient.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await rawClient.product.deleteMany({ where: { id: { in: createdProductIds } } });
  await rawClient.serviceListing.deleteMany({ where: { id: { in: createdServiceIds } } });
  await rawClient.errandTask.deleteMany({ where: { id: { in: createdErrandIds } } });
  await rawClient.meetupPoint.deleteMany({ where: { id: { in: createdPointIds } } });
  await rawClient.productCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await rawClient.serviceCategory.deleteMany({
    where: { id: { in: Array.from(new Set(createdServiceCategoryIds)) } },
  });
  await rawClient.errandCategory.deleteMany({ where: { id: { in: createdErrandCategoryIds } } });
  await rawClient.campusMembership.deleteMany({ where: { id: { in: createdMembershipIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await rawClient.campus.deleteMany({ where: { id: { in: [campusIds.A, campusIds.B].filter(Boolean) } } });
  await rawClient.$disconnect();
});

const d = rawClient ? it : it.skip;

describe("Phase 8D-02 meetup read surface（真实 PostgreSQL）", () => {
  d("READ-01/02：buyer / seller 均可读取；角色与点候选正确", async () => {
    const [buyer, seller] = await Promise.all([
      createFixtureUser("buyer", campusIds.A),
      createFixtureUser("seller", campusIds.A),
    ]);
    const product = await createProductFixture(seller.id, campusIds.A);
    const order = await createGeneralOrder({
      type: "PRODUCT",
      buyerId: buyer.id,
      sellerId: seller.id,
      productId: product.id,
    });
    const point = await createMeetupPoint({ campusId: campusIds.A });
    const proposed = await proposeMeetup({ orderId: order.id, proposerId: buyer.id, meetupPointId: point.id });
    expect(proposed).toMatchObject({ success: true });
    const meetupId = (proposed as { meetupId: string }).meetupId;

    const buyerView = await getOrderMeetupView(order.id, buyer.id);
    expect(buyerView).not.toBeNull();
    expect(buyerView!.viewerRole).toBe("buyer");
    expect(buyerView!.order.id).toBe(order.id);
    expect(buyerView!.order.type).toBe("PRODUCT");
    expect(buyerView!.order.title).toBe(product.title);
    expect(buyerView!.order.counterpartyName).toBe(seller.name);
    expect(buyerView!.meetups).toHaveLength(1);
    expect(buyerView!.meetups[0]!.id).toBe(meetupId);

    const sellerView = await getOrderMeetupView(order.id, seller.id);
    expect(sellerView).not.toBeNull();
    expect(sellerView!.viewerRole).toBe("seller");
    expect(sellerView!.order.counterpartyName).toBe(buyer.name);
    expect(sellerView!.meetups[0]!.id).toBe(meetupId);

    // SERVICE 同构可读
    const service = await createServiceFixture(seller.id, campusIds.A);
    const serviceOrder = await createGeneralOrder({
      type: "SERVICE",
      buyerId: buyer.id,
      sellerId: seller.id,
      serviceListingId: service.id,
    });
    const serviceView = await getOrderMeetupView(serviceOrder.id, buyer.id);
    expect(serviceView).not.toBeNull();
    expect(serviceView!.order.type).toBe("SERVICE");
    expect(serviceView!.order.title).toBe(service.title);
  });

  d("READ-03：第三方 DENY——null 且不泄露 meetup 存在性 / campus 候选", async () => {
    const [buyer, seller, outsider] = await Promise.all([
      createFixtureUser("buyer", campusIds.A),
      createFixtureUser("seller", campusIds.A),
      createFixtureUser("outsider", campusIds.A),
    ]);
    const product = await createProductFixture(seller.id, campusIds.A);
    const order = await createGeneralOrder({
      type: "PRODUCT",
      buyerId: buyer.id,
      sellerId: seller.id,
      productId: product.id,
    });
    await proposeMeetup({ orderId: order.id, proposerId: buyer.id, locationText: "机密地点" });

    const view = await getOrderMeetupView(order.id, outsider.id);
    expect(view).toBeNull();

    // 不存在的订单同样 null（同一安全基调，不区分原因）
    expect(await getOrderMeetupView("nonexistent-order-id", outsider.id)).toBeNull();
  });

  d("READ-04：ERRAND 参与方 DENY（type authority）", async () => {
    const [publisher, accepter] = await Promise.all([
      createFixtureUser("publisher", campusIds.A),
      createFixtureUser("accepter", campusIds.A),
    ]);
    const errand = await createErrandFixture(publisher.id, accepter.id, campusIds.A);
    const order = await createGeneralOrder({
      type: "ERRAND",
      buyerId: publisher.id,
      sellerId: accepter.id,
      errandTaskId: errand.id,
    });

    expect(await getOrderMeetupView(order.id, publisher.id)).toBeNull();
    expect(await getOrderMeetupView(order.id, accepter.id)).toBeNull();
  });

  d("campus MeetupPoint list isolation：authoritative campus + isActive only", async () => {
    const [buyer, seller] = await Promise.all([
      createFixtureUser("buyer", campusIds.A),
      createFixtureUser("seller", campusIds.A),
    ]);
    const product = await createProductFixture(seller.id, campusIds.A);
    const order = await createGeneralOrder({
      type: "PRODUCT",
      buyerId: buyer.id,
      sellerId: seller.id,
      productId: product.id,
    });

    const campusAPoint = await createMeetupPoint({ campusId: campusIds.A });
    const campusBPoint = await createMeetupPoint({ campusId: campusIds.B });
    const inactivePoint = await createMeetupPoint({ campusId: campusIds.A, isActive: false });

    const view = await getOrderMeetupView(order.id, buyer.id);
    expect(view).not.toBeNull();
    const optionIds = view!.meetupPointOptions.map((p) => p.id);
    expect(optionIds).toContain(campusAPoint.id);
    expect(optionIds).not.toContain(campusBPoint.id); // cross-campus 不泄漏
    expect(optionIds).not.toContain(inactivePoint.id); // inactive 不泄漏
  });

  d("READ-05：deleted catalog point——snapshot 保留 + MEETUP_POINT provenance 不降级", async () => {
    const [buyer, seller] = await Promise.all([
      createFixtureUser("buyer", campusIds.A),
      createFixtureUser("seller", campusIds.A),
    ]);
    const product = await createProductFixture(seller.id, campusIds.A);
    const order = await createGeneralOrder({
      type: "PRODUCT",
      buyerId: buyer.id,
      sellerId: seller.id,
      productId: product.id,
    });
    const point = await createMeetupPoint({ campusId: campusIds.A });
    const proposed = await proposeMeetup({ orderId: order.id, proposerId: buyer.id, meetupPointId: point.id });
    expect(proposed).toMatchObject({ success: true });

    // proposal 之后再改名 → 历史 snapshot 绝不被反写（8D-01 冻结语义）
    await rawClient!.meetupPoint.update({
      where: { id: point.id },
      data: { locationText: "proposal 之后被改名的新地点文本" },
    });

    // 硬删 MeetupPoint 行 → meetupPointId 走 ON DELETE SET NULL
    await rawClient!.meetupPoint.delete({ where: { id: point.id } });
    createdPointIds.splice(createdPointIds.indexOf(point.id), 1);

    const row = await rawClient!.orderMeetup.findFirstOrThrow({ where: { orderId: order.id } });
    expect(row.meetupPointId).toBeNull();
    expect(row.locationSource).toBe("MEETUP_POINT");

    const view = await getOrderMeetupView(order.id, buyer.id);
    expect(view).not.toBeNull();
    expect(view!.meetups[0]!.locationSource).toBe("MEETUP_POINT");
    // proposal 时的 snapshot 原值（不是改名后的 point 文本，也不 REDACT/blank）
    expect(view!.meetups[0]!.locationTextSnapshot).toBe("图书馆北门台阶");
  });

  d("READ-06：custom proposer erasure——合法 REDACT marker 原样展示，不恢复原文", async () => {
    const [buyer, seller] = await Promise.all([
      createFixtureUser("buyer", campusIds.A),
      createFixtureUser("seller", campusIds.A),
    ]);
    const product = await createProductFixture(seller.id, campusIds.A);
    const order = await createGeneralOrder({
      type: "PRODUCT",
      buyerId: buyer.id,
      sellerId: seller.id,
      productId: product.id,
    });
    const proposed = await proposeMeetup({
      orderId: order.id,
      proposerId: buyer.id,
      locationText: "只有买家知道的自定义地点",
    });
    expect(proposed).toMatchObject({ success: true });

    // 模拟 erasure（与 account-erasure 冻结语义一致：CUSTOM + proposedById）
    await rawClient!.orderMeetup.updateMany({
      where: { orderId: order.id, proposedById: buyer.id, locationSource: "CUSTOM" },
      data: { locationTextSnapshot: "（该内容已随账号注销删除）" },
    });

    const view = await getOrderMeetupView(order.id, buyer.id);
    expect(view).not.toBeNull();
    // 展示合法 redacted marker；read 面绝不从其他字段恢复原地点
    expect(view!.meetups[0]!.locationTextSnapshot).toBe("（该内容已随账号注销删除）");
    expect(view!.meetups[0]!.locationSource).toBe("CUSTOM");
  });

  d("current + history ordering：createdAt 倒序 + MEETUP_HISTORY_LIMIT 有序截断", async () => {
    const [buyer, seller] = await Promise.all([
      createFixtureUser("buyer", campusIds.A),
      createFixtureUser("seller", campusIds.A),
    ]);
    const product = await createProductFixture(seller.id, campusIds.A);
    const order = await createGeneralOrder({
      type: "PRODUCT",
      buyerId: buyer.id,
      sellerId: seller.id,
      productId: product.id,
    });

    // 11 个 CANCELLED 历史 + 1 个 active PROPOSED
    for (let i = 0; i < MEETUP_HISTORY_LIMIT + 1; i += 1) {
      const proposed = await proposeMeetup({ orderId: order.id, proposerId: buyer.id, locationText: `历史约定 ${i}` });
      expect(proposed).toMatchObject({ success: true });
      const cancelled = await cancelMeetup({
        orderId: order.id,
        meetupId: (proposed as { meetupId: string }).meetupId,
        actorId: seller.id,
      });
      expect(cancelled).toMatchObject({ success: true });
    }
    const active = await proposeMeetup({ orderId: order.id, proposerId: seller.id, locationText: "当前 active 约定" });
    expect(active).toMatchObject({ success: true });

    const view = await getOrderMeetupView(order.id, buyer.id);
    expect(view).not.toBeNull();
    // 有序上限：只返回最近 MEETUP_HISTORY_LIMIT 条
    expect(view!.meetups).toHaveLength(MEETUP_HISTORY_LIMIT);
    // 首条 = 最新创建的 active PROPOSED
    expect(view!.meetups[0]!.locationTextSnapshot).toBe("当前 active 约定");
    expect(view!.meetups[0]!.status).toBe("PROPOSED");
    // createdAt 严格倒序
    for (let i = 1; i < view!.meetups.length; i += 1) {
      expect(view!.meetups[i]!.createdAt.getTime()).toBeLessThanOrEqual(
        view!.meetups[i - 1]!.createdAt.getTime(),
      );
    }
    // 历史项全部为快照权威字段（locationTextSnapshot / scheduledAt / status）
    for (const meetup of view!.meetups) {
      expect(typeof meetup.locationTextSnapshot).toBe("string");
      expect(meetup.scheduledAt).toBeInstanceOf(Date);
      expect(["PROPOSED", "CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW_REPORTED"]).toContain(meetup.status);
    }
  });
});
