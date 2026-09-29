import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import type { ErrandTaskStatus, OrderStatus, Prisma, RentalOrderStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Phase 8A-03（P8-B03）BlockedUser communication policy closure 集成测试
// （真实 PostgreSQL）。
//
// 关闭的缺口（Phase 8 Pre-flight 审计 P8-B03）：
//   1. 新 MARKETPLACE_LISTING conversation 创建完全不检查 BlockedUser；
//   2. sendMessage 只查"counterpart blocked sender"单向（A blocks B 时 A
//      仍可给 B 发消息）；
//   3. block check 在 send 事务之外（TOCTOU）；
//   4. block/unblock 与 send / conversation create 无共同锁域。
//
// 修复后合同（冻结）：
//   - PAIR_BLOCKED(A,B) = A→B OR B→A（directional 单行，读取时派生）
//   - pair blocked → 新 listing contact DENY（零会话/零消息/零通知）
//   - pair blocked ∧ ¬active obligation → 双向 send DENY
//   - pair blocked ∧ active obligation（DB authoritative state，exact pair）
//     → 双向履约消息 ALLOW；terminal → DENY（历史订单非 bypass token）
//   - 既有会话历史永远可读；block 不改变任何交易业务状态
//   - block / unblock / conversation create / message send 同一 sorted
//     pair USER 锁域线性化（RACE-BS / RACE-BC，无 40P01）
//   - UI（detail payload）由服务器派生 communicationPolicy
//
// 订单/义务 fixture 说明：本测试主体是 block 沟通政策与 obligation
// resolver 对 canonical state 的读取；PRODUCT 订单经真实
// createProductOrderTx 全链路产生，SERVICE/ERRAND/RENTAL 义务行按
// canonical lifecycle 直接落库（其 lifecycle authority 已由 audit2 系列
// 独立覆盖）。

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const sessionSeam = vi.hoisted(() => ({
  actionUser: { current: null as null | { id: string; email: string; name: string } },
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser: async () => {
    if (!sessionSeam.actionUser.current) {
      throw new Error("NO_SESSION");
    }
    return sessionSeam.actionUser.current;
  },
  requireAdmin: async () => {
    if (!sessionSeam.actionUser.current) {
      throw new Error("NO_SESSION");
    }
    return sessionSeam.actionUser.current;
  },
}));

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p8a03-${randomUUID().slice(0, 8)}`;

const userIds: string[] = [];
const conversationIds: string[] = [];
const orderIds: string[] = [];
const rentalOrderIds: string[] = [];
const rentalListingIds: string[] = [];
const errandIds: string[] = [];
const serviceListingIds: string[] = [];
const productIds: string[] = [];

let campusId = "";
let productCategoryId = "";
let serviceCategoryId = "";
let errandCategoryId = "";
let rentalCategoryId = "";

let fixtureSeq = 0;

async function createFixtureUser(name: string, status: "ACTIVE" | "SUSPENDED" = "ACTIVE") {
  const seq = fixtureSeq++;
  const user = await rawClient!.user.create({
    data: {
      email: `${RUN_TAG}-${seq}-${name}@it.local`,
      name,
      passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
      schoolName: "集成测试大学",
      campusId,
      role: "STUDENT",
      status,
    },
  });
  userIds.push(user.id);
  await rawClient!.campusMembership.create({
    data: { userId: user.id, campusId, status: "ACTIVE" },
  });
  return user;
}

async function createProductFixture(sellerId: string) {
  const product = await rawClient!.product.create({
    data: {
      title: `8A03 商品 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8A-03 communication policy fixture",
      price: 10,
      condition: "NEW",
      locationText: "东门",
      categoryId: productCategoryId,
      campusId,
      sellerId,
      status: "ACTIVE",
    },
  });
  productIds.push(product.id);
  return product;
}

async function createServiceListingFixture(providerId: string) {
  const listing = await rawClient!.serviceListing.create({
    data: {
      title: `8A03 服务 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8A-03 fixture",
      categoryId: serviceCategoryId,
      price: 30,
      pricingUnit: "PER_SESSION",
      locationText: "东门",
      campusId,
      providerId,
    },
  });
  serviceListingIds.push(listing.id);
  return listing;
}

async function createErrandFixture(publisherId: string, accepterId: string | null, status: ErrandTaskStatus) {
  const errand = await rawClient!.errandTask.create({
    data: {
      title: `8A03 任务 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8A-03 fixture",
      categoryId: errandCategoryId,
      reward: 8,
      pickupLocation: "东门",
      deliveryLocation: "南门",
      deadline: new Date(Date.now() + 3600_000),
      campusId,
      publisherId,
      accepterId,
      status,
    },
  });
  errandIds.push(errand.id);
  return errand;
}

async function createRentalListingFixture(ownerId: string) {
  const listing = await rawClient!.rentalListing.create({
    data: {
      title: `8A03 租赁 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8A-03 fixture",
      condition: "NEW",
      price: "20.00",
      pricingUnit: "PER_DAY",
      depositAmount: "50.00",
      minimumDuration: 1,
      maximumDuration: 7,
      totalQuantity: 1,
      availableQuantity: 1,
      pickupLocation: "南门",
      returnLocation: "南门",
      status: "AVAILABLE",
      ownerId,
      campusId,
      categoryId: rentalCategoryId,
    },
  });
  rentalListingIds.push(listing.id);
  return listing;
}

async function createRentalOrderFixture(input: {
  rentalListingId: string;
  ownerId: string;
  renterId: string;
  status: RentalOrderStatus;
}) {
  const now = Date.now();
  const order = await rawClient!.rentalOrder.create({
    data: {
      orderNumber: `${RUN_TAG}-${randomUUID().slice(0, 8)}`,
      rentalListingId: input.rentalListingId,
      ownerId: input.ownerId,
      renterId: input.renterId,
      startTime: new Date(now),
      endTime: new Date(now + 24 * 60 * 60 * 1000),
      quantity: 1,
      unitPriceSnapshot: "20.00",
      pricingUnitSnapshot: "PER_DAY",
      rentalDuration: 1,
      rentalAmount: "20.00",
      depositAmount: "50.00",
      finalAmount: "70.00",
      paymentStatus: "OFFLINE_PENDING",
      depositStatus: "NOT_REQUIRED",
      status: input.status,
      pickupLocationSnapshot: "南门",
      returnLocationSnapshot: "南门",
    },
  });
  rentalOrderIds.push(order.id);
  return order;
}

async function createServiceOrderFixture(input: {
  serviceListingId: string;
  buyerId: string;
  sellerId: string;
  status: OrderStatus;
}) {
  const order = await rawClient!.order.create({
    data: {
      orderNo: `${RUN_TAG}-S-${randomUUID().slice(0, 8)}`,
      type: "SERVICE",
      status: input.status,
      buyerId: input.buyerId,
      sellerId: input.sellerId,
      serviceListingId: input.serviceListingId,
      amount: "30.00",
    },
  });
  orderIds.push(order.id);
  return order;
}

/** 既有会话 fixture（participants + 可选历史消息；用于 open/send 路径）。 */
async function createConversationFixture(input: {
  participantIds: [string, string];
  /** 传真实 conversationKey 时可被 getOrCreateConversationSafe fast path 命中。 */
  conversationKey?: string;
  refs?: Partial<Record<"productId" | "errandTaskId" | "serviceListingId" | "rentalListingId" | "orderId" | "rentalOrderId", string>>;
  initialMessage?: { senderId: string; content: string };
}) {
  const conversation = await rawClient!.conversation.create({
    data: {
      title: "8A03 fixture 会话",
      conversationKey: input.conversationKey ?? `FIXTURE:${randomUUID()}`,
      ...input.refs,
      participants: {
        create: input.participantIds.map((userId) => ({ userId })),
      },
      ...(input.initialMessage
        ? {
            messages: {
              create: {
                senderId: input.initialMessage.senderId,
                type: "DIRECT",
                content: input.initialMessage.content,
              },
            },
          }
        : {}),
    },
  });
  conversationIds.push(conversation.id);
  return conversation;
}

async function blockPair(blockerId: string, blockedUserId: string) {
  await rawClient!.blockedUser.create({
    data: { blockerId, blockedUserId, reason: "8A03 fixture" },
  });
}

/** 真实 Server Action 入口（session seam 指定 actor）。 */
async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionSeam.actionUser.current;
  sessionSeam.actionUser.current = { id: userId, email: "", name: "" };
  try {
    return await fn();
  } finally {
    sessionSeam.actionUser.current = previous;
  }
}

function productContactForm(productId: string) {
  const formData = new FormData();
  formData.set("productId", productId);
  return formData;
}

function serviceContactForm(serviceId: string) {
  const formData = new FormData();
  formData.set("serviceId", serviceId);
  return formData;
}

function rentalContactForm(rentalListingId: string) {
  const formData = new FormData();
  formData.set("rentalListingId", rentalListingId);
  return formData;
}

function orderContactForm(orderId: string, orderType: "PRODUCT" | "RENTAL") {
  const formData = new FormData();
  formData.set("orderId", orderId);
  formData.set("orderType", orderType);
  return formData;
}

function sendMessageForm(conversationId: string, content: string) {
  const formData = new FormData();
  formData.set("conversationId", conversationId);
  formData.set("content", content);
  return formData;
}

/** PRODUCT 订单真实全链路下单（createProductOrderTx：pair 锁 + 行锁 + capability + 预留投影）。 */
async function placeRealProductOrder(input: {
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
  if (!order) throw new Error("placeRealProductOrder: order creation returned null");
  orderIds.push(order.id);
  return order;
}

/** 锁等待 barrier（与 Phase 6B/Repair3 同一 pg_locks 证据约定，零 sleep 定序）。 */async function waitForAdvisoryLockWaiter(
  client: PrismaClient,
  subjectKeys: string[],
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = await client.$queryRaw<{ objid: number }[]>`
      SELECT locks.objid
      FROM pg_locks locks
      WHERE locks.locktype = 'advisory'
        AND NOT locks.granted
        AND locks.classid = ${730_501}::int
        AND EXISTS (
          SELECT 1
          FROM unnest(${subjectKeys}::text[]) AS expected(key)
          WHERE hashtext(expected.key)::bit(32)::bigint = locks.objid
        )`;

    if (rows.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(
    `advisory-lock barrier 超时：预期等待键 [${subjectKeys.join(", ")}] 均未进入锁等待`,
  );
}

function asResult(result: { success: boolean; message: string }) {
  return result;
}

/**
 * 集成环境真实 Next redirect：redirect() 抛出的 error.digest 形如
 * "NEXT_REDIRECT;replace;/messages/xxx;..."；返回目标路径。
 */
function redirectTargetOf(error: unknown): string {
  const digest = (error as { digest?: string } | null)?.digest ?? "";
  const parts = digest.split(";");
  return parts[2] ?? "";
}

beforeAll(async () => {
  if (!rawClient) return;

  const campus = await rawClient.campus.create({
    data: { name: `8A03校区-${RUN_TAG}`, slug: RUN_TAG, schoolName: "集成测试大学" },
  });
  campusId = campus.id;

  const productCategory = await rawClient.productCategory.create({
    data: { name: `8A03商品类目-${RUN_TAG}`, slug: RUN_TAG },
  });
  productCategoryId = productCategory.id;

  const serviceCategory = await rawClient.serviceCategory.create({
    data: { name: `8A03服务类目-${RUN_TAG}`, slug: RUN_TAG },
  });
  serviceCategoryId = serviceCategory.id;

  const errandCategory = await rawClient.errandCategory.create({
    data: { name: `8A03跑腿类目-${RUN_TAG}`, slug: RUN_TAG },
  });
  errandCategoryId = errandCategory.id;

  const rentalCategory = await rawClient.rentalCategory.create({
    data: { name: `8A03租赁类目-${RUN_TAG}`, slug: RUN_TAG },
  });
  rentalCategoryId = rentalCategory.id;
});

afterAll(async () => {
  if (!rawClient) return;

  // 反向 FK 顺序清理（精确 fixture ID 域；禁止 silent catch 吞 cleanup failure）
  await rawClient.notification.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await rawClient.conversationParticipant.deleteMany({
    where: { conversationId: { in: conversationIds } },
  });
  await rawClient.conversation.deleteMany({ where: { id: { in: conversationIds } } });
  await rawClient.blockedUser.deleteMany({
    where: { OR: [{ blockerId: { in: userIds } }, { blockedUserId: { in: userIds } }] },
  });
  await rawClient.rentalOrder.deleteMany({ where: { id: { in: rentalOrderIds } } });
  await rawClient.order.deleteMany({ where: { id: { in: orderIds } } });
  await rawClient.rentalListing.deleteMany({ where: { id: { in: rentalListingIds } } });
  await rawClient.errandTask.deleteMany({ where: { id: { in: errandIds } } });
  await rawClient.serviceListing.deleteMany({ where: { id: { in: serviceListingIds } } });
  await rawClient.product.deleteMany({ where: { id: { in: productIds } } });
  await rawClient.productCategory.deleteMany({ where: { id: productCategoryId } });
  await rawClient.serviceCategory.deleteMany({ where: { id: serviceCategoryId } });
  await rawClient.errandCategory.deleteMany({ where: { id: errandCategoryId } });
  await rawClient.rentalCategory.deleteMany({ where: { id: rentalCategoryId } });
  await rawClient.campusMembership.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: userIds } } });
  await rawClient.campus.deleteMany({ where: { id: campusId } });

  expect(await rawClient.campus.count({ where: { id: campusId } })).toBe(0);

  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 8A-03 blocked-user communication policy closure（real PostgreSQL）",
  () => {
    // ============================================================
    // 新 listing contact gate（§4/§20/§28/§37）
    // ============================================================

    it("BLOCK-CONV-01：A blocks B → B 经 PRODUCT listing 建新会话 DENY（零会话/零消息/零通知）", async () => {
      const seller = await createFixtureUser("CONV01卖家");
      const buyer = await createFixtureUser("CONV01买家");
      const product = await createProductFixture(seller.id);

      await blockPair(seller.id, buyer.id);

      const { createOrOpenProductConversation } = await import("@/actions/conversation");
      const result = asResult(
        await asUser(buyer.id, () =>
          createOrOpenProductConversation(null, productContactForm(product.id)),
        ),
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe("你们之间存在消息屏蔽，无法发起新的会话沟通");

      // 零 durable 态：无会话 / 无首条消息 / 无通知
      expect(
        await rawClient!.conversation.count({
          where: { productId: product.id },
        }),
      ).toBe(0);
      expect(
        await rawClient!.notification.count({ where: { userId: seller.id } }),
      ).toBe(0);
    });

    it("BLOCK-CONV-02：B blocks A → A 经 SERVICE/RENTAL listing 建新会话 DENY（反向对称）", async () => {
      const provider = await createFixtureUser("CONV02服务者");
      const customer = await createFixtureUser("CONV02消费者");
      const owner = await createFixtureUser("CONV02出租者");
      const renter = await createFixtureUser("CONV02租客");
      const service = await createServiceListingFixture(provider.id);
      const rental = await createRentalListingFixture(owner.id);

      // 反向：counterpart 拉黑发起者
      await blockPair(customer.id, provider.id);
      await blockPair(renter.id, owner.id);

      const { createOrOpenServiceConversation, createOrOpenRentalConversation } = await import(
        "@/actions/conversation"
      );

      const serviceResult = asResult(
        await asUser(customer.id, () =>
          createOrOpenServiceConversation(null, serviceContactForm(service.id)),
        ),
      );
      expect(serviceResult.success).toBe(false);
      expect(serviceResult.message).toBe("你们之间存在消息屏蔽，无法发起新的会话沟通");

      const rentalResult = asResult(
        await asUser(renter.id, () =>
          createOrOpenRentalConversation(null, rentalContactForm(rental.id)),
        ),
      );
      expect(rentalResult.success).toBe(false);

      expect(
        await rawClient!.conversation.count({ where: { serviceListingId: service.id } }),
      ).toBe(0);
      expect(
        await rawClient!.conversation.count({ where: { rentalListingId: rental.id } }),
      ).toBe(0);
      expect(await rawClient!.notification.count({ where: { userId: provider.id } })).toBe(0);
      expect(await rawClient!.notification.count({ where: { userId: owner.id } })).toBe(0);
    });

    it("BLOCK-CONV-03：pair blocked + 既有同 key 会话 → 仍可打开（历史证据保留，零新写）", async () => {
      const seller = await createFixtureUser("CONV03卖家");
      const buyer = await createFixtureUser("CONV03买家");
      const product = await createProductFixture(seller.id);
      // 真实 conversationKey（与 getOrCreateConversationSafe fast path 同键）
      const { computeConversationKey } = await import("@/lib/conversation-key");
      const existing = await createConversationFixture({
        participantIds: [buyer.id, seller.id],
        conversationKey: await computeConversationKey("PRODUCT", product.id, [buyer.id, seller.id]),
        refs: { productId: product.id },
        initialMessage: { senderId: seller.id, content: "block 之前的历史消息" },
      });

      await blockPair(buyer.id, seller.id);

      const { createOrOpenProductConversation } = await import("@/actions/conversation");
      // Next redirect（真实 next/navigation）：digest 携带目标路径
      const redirectTarget = await asUser(buyer.id, () =>
        createOrOpenProductConversation(null, productContactForm(product.id)).then(
          () => "NO_REDIRECT" as const,
          (error: unknown) => redirectTargetOf(error) || "UNEXPECTED",
        ),
      );
      expect(redirectTarget).toBe(`/messages/${existing.id}`);

      // 零新 durable 写（会话数不变、消息数不变、通知零新增）
      expect(await rawClient!.conversation.count({ where: { productId: product.id } })).toBe(1);
      expect(await rawClient!.message.count({ where: { conversationId: existing.id } })).toBe(1);
      expect(await rawClient!.notification.count({ where: { userId: seller.id } })).toBe(0);

      // §32：历史可见（detail payload 正常返回全部消息 + BLOCKED 政策）
      const { getConversationDetailPayload } = await import(
        "@/repositories/conversation-repository"
      );
      const payload = await getConversationDetailPayload(existing.id, buyer.id);
      expect(payload).not.toBeNull();
      expect(payload!.messages.map((m) => m.content)).toContain("block 之前的历史消息");
      expect(payload!.communicationPolicy).toEqual({
        pairBlocked: true,
        activeObligation: false,
        canSendMessage: false,
        mode: "BLOCKED",
      });
    });

    // ============================================================
    // sendMessage 事务内 authority（§22/§23/§25/§38）
    // ============================================================

    it("BLOCK-SEND-01：A blocks B → A sends to B → DENY（关闭 blocker 单向漏洞）", async () => {
      const alice = await createFixtureUser("SEND01A");
      const bob = await createFixtureUser("SEND01B");
      const conversation = await createConversationFixture({
        participantIds: [alice.id, bob.id],
        initialMessage: { senderId: bob.id, content: "历史消息" },
      });

      await blockPair(alice.id, bob.id);

      const { sendMessage } = await import("@/actions/conversation");
      const result = asResult(
        await asUser(alice.id, () => sendMessage({ success: false, message: "" }, sendMessageForm(conversation.id, "blocker 侧发送"))),
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe("你们之间存在消息屏蔽，无法发送消息");
      expect(await rawClient!.message.count({ where: { conversationId: conversation.id } })).toBe(1);
      // 单向行保持单行（无镜像行写入）
      expect(
        await rawClient!.blockedUser.count({
          where: { OR: [{ blockerId: alice.id }, { blockerId: bob.id }] },
        }),
      ).toBe(1);
    });

    it("BLOCK-SEND-02：A blocks B → B sends to A → DENY（blocked 侧）", async () => {
      const alice = await createFixtureUser("SEND02A");
      const bob = await createFixtureUser("SEND02B");
      const conversation = await createConversationFixture({
        participantIds: [alice.id, bob.id],
      });

      await blockPair(alice.id, bob.id);

      const { sendMessage } = await import("@/actions/conversation");
      const result = asResult(
        await asUser(bob.id, () => sendMessage({ success: false, message: "" }, sendMessageForm(conversation.id, "blocked 侧发送"))),
      );

      expect(result.success).toBe(false);
      expect(await rawClient!.message.count({ where: { conversationId: conversation.id } })).toBe(0);
    });

    it("BLOCK-SEND-03：no block → normal send PASS（exactly once）", async () => {
      const alice = await createFixtureUser("SEND03A");
      const bob = await createFixtureUser("SEND03B");
      const conversation = await createConversationFixture({
        participantIds: [alice.id, bob.id],
      });

      const { sendMessage } = await import("@/actions/conversation");
      const result = asResult(
        await asUser(alice.id, () => sendMessage({ success: false, message: "" }, sendMessageForm(conversation.id, "正常沟通消息"))),
      );

      expect(result).toEqual({ success: true, message: "发送成功" });
      expect(await rawClient!.message.count({ where: { conversationId: conversation.id } })).toBe(1);
    });

    it("BLOCK-SEND-04：sender not conversation participant → DENY（事务内 fail closed）", async () => {
      const alice = await createFixtureUser("SEND04A");
      const bob = await createFixtureUser("SEND04B");
      const outsider = await createFixtureUser("SEND04外人");
      const conversation = await createConversationFixture({
        participantIds: [alice.id, bob.id],
      });

      const { sendMessage } = await import("@/actions/conversation");
      const result = asResult(
        await asUser(outsider.id, () => sendMessage({ success: false, message: "" }, sendMessageForm(conversation.id, "外人消息"))),
      );

      expect(result).toEqual({ success: false, message: "无权在该会话中发送消息" });
      expect(await rawClient!.message.count({ where: { conversationId: conversation.id } })).toBe(0);
    });

    // ============================================================
    // EXISTING OBLIGATION OVERRIDE（§7/§9-§14/§26/§39/§40）
    // ============================================================

    it("OBL-SEND-01 Product：A blocks B + active PRODUCT order（真实下单）→ 双向 send allowed", async () => {
      const seller = await createFixtureUser("OBL01卖家");
      const buyer = await createFixtureUser("OBL01买家");
      const product = await createProductFixture(seller.id);

      const order = await placeRealProductOrder({
        buyerId: buyer.id,
        product: { id: product.id, price: "10", sellerId: seller.id, campusId },
      });
      expect(order.status).toBe("PENDING");

      const listingConversation = await createConversationFixture({
        participantIds: [buyer.id, seller.id],
        refs: { productId: product.id },
      });

      await blockPair(seller.id, buyer.id);

      const { sendMessage } = await import("@/actions/conversation");
      const fromBuyer = asResult(
        await asUser(buyer.id, () => sendMessage({ success: false, message: "" }, sendMessageForm(listingConversation.id, "买家履约交接消息"))),
      );
      const fromSeller = asResult(
        await asUser(seller.id, () => sendMessage({ success: false, message: "" }, sendMessageForm(listingConversation.id, "卖家履约交接消息"))),
      );

      expect(fromBuyer.success).toBe(true);
      expect(fromSeller.success).toBe(true);
      expect(await rawClient!.message.count({ where: { conversationId: listingConversation.id } })).toBe(2);

      // detail payload = EXISTING_OBLIGATION_OVERRIDE（UI 依据）
      const { getConversationDetailPayload } = await import(
        "@/repositories/conversation-repository"
      );
      const payload = await getConversationDetailPayload(listingConversation.id, seller.id);
      expect(payload!.communicationPolicy).toEqual({
        pairBlocked: true,
        activeObligation: true,
        canSendMessage: true,
        mode: "EXISTING_OBLIGATION_OVERRIDE",
      });
    });

    it("OBL-SEND-02 Service：A blocks B + SERVICE order IN_PROGRESS exact pair → send allowed", async () => {
      const provider = await createFixtureUser("OBL02服务者");
      const customer = await createFixtureUser("OBL02消费者");
      const service = await createServiceListingFixture(provider.id);
      await createServiceOrderFixture({
        serviceListingId: service.id,
        buyerId: customer.id,
        sellerId: provider.id,
        status: "IN_PROGRESS",
      });

      const conversation = await createConversationFixture({
        participantIds: [customer.id, provider.id],
        refs: { serviceListingId: service.id },
      });

      await blockPair(provider.id, customer.id);

      const { sendMessage } = await import("@/actions/conversation");
      const result = asResult(
        await asUser(customer.id, () => sendMessage({ success: false, message: "" }, sendMessageForm(conversation.id, "服务履约沟通"))),
      );

      expect(result.success).toBe(true);
    });

    it("OBL-SEND-02b Service：wrong counterpart（他人订单）→ DENY（exact pair）", async () => {
      const provider = await createFixtureUser("OBL02b服务者");
      const customer = await createFixtureUser("OBL02b消费者");
      const other = await createFixtureUser("OBL02b无关者");
      const service = await createServiceListingFixture(provider.id);
      // 他人（other）与 provider 的订单，不构成 customer 的义务
      await createServiceOrderFixture({
        serviceListingId: service.id,
        buyerId: other.id,
        sellerId: provider.id,
        status: "IN_PROGRESS",
      });

      const conversation = await createConversationFixture({
        participantIds: [customer.id, provider.id],
        refs: { serviceListingId: service.id },
      });

      await blockPair(provider.id, customer.id);

      const { sendMessage } = await import("@/actions/conversation");
      const result = asResult(
        await asUser(customer.id, () => sendMessage({ success: false, message: "" }, sendMessageForm(conversation.id, "无关者借道"))),
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe("你们之间存在消息屏蔽，无法发送消息");
    });

    it("OBL-SEND-03 Errand：A blocks B + ERRAND IN_PROGRESS exact publisher/accepter pair → send allowed", async () => {
      const publisher = await createFixtureUser("OBL03发布者");
      const accepter = await createFixtureUser("OBL03接单者");
      const errand = await createErrandFixture(publisher.id, accepter.id, "IN_PROGRESS");

      const conversation = await createConversationFixture({
        participantIds: [publisher.id, accepter.id],
        refs: { errandTaskId: errand.id },
      });

      await blockPair(publisher.id, accepter.id);

      const { sendMessage } = await import("@/actions/conversation");
      const fromAccepter = asResult(
        await asUser(accepter.id, () => sendMessage({ success: false, message: "" }, sendMessageForm(conversation.id, "已取到件"))),
      );
      const fromPublisher = asResult(
        await asUser(publisher.id, () => sendMessage({ success: false, message: "" }, sendMessageForm(conversation.id, "好的，等你送达"))),
      );

      expect(fromAccepter.success).toBe(true);
      expect(fromPublisher.success).toBe(true);
    });

    it("OBL-SEND-03b Errand：OPEN/COMPLETED/CANCELLED 非义务 → DENY", async () => {
      const publisher = await createFixtureUser("OBL03b发布者");
      const accepter = await createFixtureUser("OBL03b接单者");
      await blockPair(publisher.id, accepter.id);

      for (const status of ["OPEN", "COMPLETED", "CANCELLED"] as const) {
        const errand = await createErrandFixture(
          publisher.id,
          status === "OPEN" ? null : accepter.id,
          status,
        );
        const conversation = await createConversationFixture({
          participantIds: [publisher.id, accepter.id],
          refs: { errandTaskId: errand.id },
        });

        const { sendMessage } = await import("@/actions/conversation");
        const result = asResult(
          await asUser(publisher.id, () => sendMessage({ success: false, message: "" }, sendMessageForm(conversation.id, "非义务期消息"))),
        );
        expect(result.success).toBe(false);
      }
      expect(await rawClient!.blockedUser.count({ where: { blockerId: publisher.id } })).toBe(1);
    });

    it("OBL-SEND-04 Rental：A blocks B + RentalOrder IN_RENTAL → send allowed；CLOSED → DENY", async () => {
      const owner = await createFixtureUser("OBL04出租者");
      const renter = await createFixtureUser("OBL04租客");
      const listing = await createRentalListingFixture(owner.id);

      const activeOrder = await createRentalOrderFixture({
        rentalListingId: listing.id,
        ownerId: owner.id,
        renterId: renter.id,
        status: "IN_RENTAL",
      });
      const activeConversation = await createConversationFixture({
        participantIds: [owner.id, renter.id],
        refs: { rentalOrderId: activeOrder.id },
      });

      await blockPair(owner.id, renter.id);

      const { sendMessage } = await import("@/actions/conversation");
      const activeResult = asResult(
        await asUser(renter.id, () => sendMessage({ success: false, message: "" }, sendMessageForm(activeConversation.id, "今天归还方便吗"))),
      );
      expect(activeResult.success).toBe(true);

      // 同一对会话切到 terminal 状态后 → DENY（历史订单不是永久 bypass token）
      await rawClient!.rentalOrder.update({
        where: { id: activeOrder.id },
        data: { status: "CLOSED" },
      });
      const terminalResult = asResult(
        await asUser(renter.id, () => sendMessage({ success: false, message: "" }, sendMessageForm(activeConversation.id, "terminal 后再发一条"))),
      );
      expect(terminalResult.success).toBe(false);

      // detail payload 回落 BLOCKED
      const { getConversationDetailPayload } = await import(
        "@/repositories/conversation-repository"
      );
      const payload = await getConversationDetailPayload(activeConversation.id, owner.id);
      expect(payload!.communicationPolicy).toEqual({
        pairBlocked: true,
        activeObligation: false,
        canSendMessage: false,
        mode: "BLOCKED",
      });
    });

    it("TERMINAL-ORDER §40：pair blocked + PRODUCT order COMPLETED → send DENY", async () => {
      const seller = await createFixtureUser("TERM01卖家");
      const buyer = await createFixtureUser("TERM01买家");
      const product = await createProductFixture(seller.id);
      const order = await placeRealProductOrder({
        buyerId: buyer.id,
        product: { id: product.id, price: "10", sellerId: seller.id, campusId },
      });
      await rawClient!.order.update({ where: { id: order.id }, data: { status: "COMPLETED" } });

      const conversation = await createConversationFixture({
        participantIds: [buyer.id, seller.id],
        refs: { orderId: order.id },
      });

      await blockPair(buyer.id, seller.id);

      const { sendMessage } = await import("@/actions/conversation");
      const result = asResult(
        await asUser(seller.id, () => sendMessage({ success: false, message: "" }, sendMessageForm(conversation.id, "订单结束后再发"))),
      );

      expect(result.success).toBe(false);
      expect(await rawClient!.message.count({ where: { conversationId: conversation.id } })).toBe(0);
    });

    // ============================================================
    // §41 blocked order-conversation creation
    // ============================================================

    it("OBL-CONV-01 §41：pair blocked + active PRODUCT order + 会话不存在 → createOrOpenOrderConversation ALLOW", async () => {
      const seller = await createFixtureUser("OBLCONV01卖家");
      const buyer = await createFixtureUser("OBLCONV01买家");
      const product = await createProductFixture(seller.id);
      const order = await placeRealProductOrder({
        buyerId: buyer.id,
        product: { id: product.id, price: "10", sellerId: seller.id, campusId },
      });

      await blockPair(seller.id, buyer.id);

      const { createOrOpenOrderConversation } = await import("@/actions/conversation");
      const redirectTarget = await asUser(buyer.id, () =>
        createOrOpenOrderConversation(orderContactForm(order.id, "PRODUCT")).then(
          () => "NO_REDIRECT" as const,
          (error: unknown) => redirectTargetOf(error) || `UNEXPECTED:${String(error)}`,
        ),
      );

      expect(redirectTarget).toMatch(/^\/messages\//);
      // 保留履约渠道：订单会话已创建 + 首条消息（MESSAGE 通知；下单本身的
      // ORDER 通知不计入本断言）
      expect(
        await rawClient!.conversation.count({ where: { orderId: order.id } }),
      ).toBe(1);
      expect(
        await rawClient!.notification.count({ where: { userId: seller.id, type: "MESSAGE" } }),
      ).toBe(1);
    });

    it("OBL-CONV-02 §41：pair blocked + terminal order + 会话不存在 → 新订单会话 DENY", async () => {
      const seller = await createFixtureUser("OBLCONV02卖家");
      const buyer = await createFixtureUser("OBLCONV02买家");
      const product = await createProductFixture(seller.id);
      const order = await placeRealProductOrder({
        buyerId: buyer.id,
        product: { id: product.id, price: "10", sellerId: seller.id, campusId },
      });
      await rawClient!.order.update({
        where: { id: order.id },
        data: { status: "CANCELLED" },
      });

      await blockPair(seller.id, buyer.id);

      const { createOrOpenOrderConversation } = await import("@/actions/conversation");
      const redirectTarget = await asUser(buyer.id, () =>
        createOrOpenOrderConversation(orderContactForm(order.id, "PRODUCT")).then(
          () => "NO_REDIRECT" as const,
          (error: unknown) => redirectTargetOf(error) || `UNEXPECTED:${String(error)}`,
        ),
      );

      // fail closed 回订单中心
      expect(redirectTarget).toBe("/my/orders");
      expect(await rawClient!.conversation.count({ where: { orderId: order.id } })).toBe(0);
      expect(
        await rawClient!.notification.count({ where: { userId: seller.id, type: "MESSAGE" } }),
      ).toBe(0);
    });

    // ============================================================
    // §27 block 不改变交易业务状态；§45 lifecycle fail closed
    // ============================================================

    it("SIDE-EFFECT §27：block/unblock 零业务状态变更（Order/Errand/Rental canonical state 不动）", async () => {
      const publisher = await createFixtureUser("SIDE27发布者");
      const accepter = await createFixtureUser("SIDE27接单者");
      const owner = await createFixtureUser("SIDE27出租者");
      const renter = await createFixtureUser("SIDE27租客");
      const errand = await createErrandFixture(publisher.id, accepter.id, "IN_PROGRESS");
      const rental = await createRentalListingFixture(owner.id);
      const rentalOrder = await createRentalOrderFixture({
        rentalListingId: rental.id,
        ownerId: owner.id,
        renterId: renter.id,
        status: "IN_RENTAL",
      });

      const { blockUser, unblockUser } = await import("@/actions/trust");

      const blockForm = new FormData();
      blockForm.set("targetUserId", accepter.id);
      blockForm.set("reason", "SIDE27");
      const blockResult = asResult(
        await asUser(publisher.id, () => blockUser({ success: false, message: "" }, blockForm)),
      );
      expect(blockResult.success).toBe(true);

      expect(await rawClient!.errandTask.findUnique({ where: { id: errand.id } })).toMatchObject({
        status: "IN_PROGRESS",
        accepterId: accepter.id,
      });
      expect(await rawClient!.rentalOrder.findUnique({ where: { id: rentalOrder.id } })).toMatchObject({
        status: "IN_RENTAL",
      });

      const unblockForm = new FormData();
      unblockForm.set("targetUserId", accepter.id);
      const unblockResult = asResult(
        await asUser(publisher.id, () => unblockUser({ success: false, message: "" }, unblockForm)),
      );
      expect(unblockResult.success).toBe(true);
      expect(
        await rawClient!.blockedUser.count({
          where: { blockerId: publisher.id, blockedUserId: accepter.id },
        }),
      ).toBe(0);
      expect(await rawClient!.errandTask.findUnique({ where: { id: errand.id } })).toMatchObject({
        status: "IN_PROGRESS",
      });
    });

    it("LIFECYCLE §45：SUSPENDED actor → block/send/new conversation 全部 fail closed（RB-03）", async () => {
      const suspended = await createFixtureUser("LIFE45停用者", "SUSPENDED");
      const peer = await createFixtureUser("LIFE45对方");
      const conversation = await createConversationFixture({
        participantIds: [suspended.id, peer.id],
      });

      const { blockUser } = await import("@/actions/trust");
      const blockForm = new FormData();
      blockForm.set("targetUserId", peer.id);
      blockForm.set("reason", "LIFE45");
      const blockResult = asResult(
        await asUser(suspended.id, () => blockUser({ success: false, message: "" }, blockForm)),
      );
      expect(blockResult.success).toBe(false);
      expect(
        await rawClient!.blockedUser.count({ where: { blockerId: suspended.id } }),
      ).toBe(0);

      const { sendMessage } = await import("@/actions/conversation");
      const sendResult = asResult(
        await asUser(suspended.id, () => sendMessage({ success: false, message: "" }, sendMessageForm(conversation.id, "停用账号发送"))),
      );
      expect(sendResult.success).toBe(false);
      expect(await rawClient!.message.count({ where: { conversationId: conversation.id } })).toBe(0);
    });

    // ============================================================
    // RACES（真实 PG advisory lock barrier + pg_locks waiter 证据，无 40P01）
    // ============================================================

    it("RACE-BS-01 block wins：T1 block 持 pair 锁 → T2 send 等待 → block 提交 → send DENY", async () => {
      const alice = await createFixtureUser("RBS01A");
      const bob = await createFixtureUser("RBS01B");
      const conversation = await createConversationFixture({
        participantIds: [alice.id, bob.id],
      });

      const { blockUserTx } = await import("@/lib/trust/block-service");
      const { withTransaction } = await import("@/lib/prisma");

      let t1Locked!: () => void;
      const locked = new Promise<void>((resolve) => {
        t1Locked = resolve;
      });
      let releaseT1!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });

      const t1 = withTransaction((tx: Prisma.TransactionClient) =>
        blockUserTx(
          tx,
          alice.id,
          { targetUserId: bob.id, reason: "RBS01" },
          {
            afterCheck: async () => {
              t1Locked();
              await gate;
            },
          },
        ),
      );
      await locked;

      const { sendMessage } = await import("@/actions/conversation");
      const t2 = asUser(bob.id, () =>
        sendMessage({ success: false, message: "" }, sendMessageForm(conversation.id, "竞态消息")),
      ).then(
        (result) => result,
        (error) => ({ success: false, message: `THROWN:${String(error)}` }),
      );

      // T2 真实进入同一 pair 锁等待队列（pg_locks 证据）
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${alice.id}`, `USER:${bob.id}`]);
      releaseT1();

      await expect(t1).resolves.toBeUndefined();

      const sendResult = await t2;
      expect(sendResult.success).toBe(false);
      expect(sendResult.message).toBe("你们之间存在消息屏蔽，无法发送消息");

      expect(
        await rawClient!.blockedUser.count({
          where: { blockerId: alice.id, blockedUserId: bob.id },
        }),
      ).toBe(1);
      expect(await rawClient!.message.count({ where: { conversationId: conversation.id } })).toBe(0);
    });

    it("RACE-BS-02 send wins：T1 send 持 pair 锁 → T2 block 等待 → 恰好一条消息 → block 提交 → 后续 send DENY", async () => {
      const alice = await createFixtureUser("RBS02A");
      const bob = await createFixtureUser("RBS02B");
      const conversation = await createConversationFixture({
        participantIds: [alice.id, bob.id],
      });

      const { sendMessageTx } = await import("@/lib/conversation-messaging");
      const { withTransaction } = await import("@/lib/prisma");

      let t1InFlight!: () => void;
      const inFlight = new Promise<void>((resolve) => {
        t1InFlight = resolve;
      });
      let releaseT1!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });

      const t1 = withTransaction((tx: Prisma.TransactionClient) =>
        sendMessageTx({
          conversationId: conversation.id,
          senderId: alice.id,
          content: "线性化幸存消息",
          seams: {
            beforeWrite: async () => {
              t1InFlight();
              await gate;
            },
          },
        }),
      );
      await inFlight;

      const { blockUser } = await import("@/actions/trust");
      const blockForm = new FormData();
      blockForm.set("targetUserId", bob.id);
      blockForm.set("reason", "RBS02");
      const t2 = asUser(alice.id, () =>
        blockUser({ success: false, message: "" }, blockForm),
      );

      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${alice.id}`, `USER:${bob.id}`]);
      releaseT1();

      await expect(t1).resolves.toMatchObject({ messageId: expect.any(String) });
      await expect(t2).resolves.toMatchObject({ success: true });

      // exactly-once：赢家 send 恰好一条
      expect(await rawClient!.message.count({ where: { conversationId: conversation.id } })).toBe(1);
      expect(
        await rawClient!.blockedUser.count({
          where: { blockerId: alice.id, blockedUserId: bob.id },
        }),
      ).toBe(1);

      // 线性化后序：第三次 send DENY
      const { sendMessage } = await import("@/actions/conversation");
      const third = asResult(
        await asUser(alice.id, () => sendMessage({ success: false, message: "" }, sendMessageForm(conversation.id, "block 后再发"))),
      );
      expect(third.success).toBe(false);
      expect(await rawClient!.message.count({ where: { conversationId: conversation.id } })).toBe(1);
    });

    it("RACE-BC-01 block wins：T1 block 持 pair 锁 → T2 新 PRODUCT 会话等待 → block 提交 → 新 contact DENY（零三态）", async () => {
      const seller = await createFixtureUser("RBC01卖家");
      const buyer = await createFixtureUser("RBC01买家");
      const product = await createProductFixture(seller.id);

      const { blockUserTx } = await import("@/lib/trust/block-service");
      const { withTransaction } = await import("@/lib/prisma");

      let t1Locked!: () => void;
      const locked = new Promise<void>((resolve) => {
        t1Locked = resolve;
      });
      let releaseT1!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });

      const t1 = withTransaction((tx: Prisma.TransactionClient) =>
        blockUserTx(
          tx,
          buyer.id,
          { targetUserId: seller.id, reason: "RBC01" },
          {
            afterCheck: async () => {
              t1Locked();
              await gate;
            },
          },
        ),
      );
      await locked;

      const { createOrOpenProductConversation } = await import("@/actions/conversation");
      const t2 = asUser(buyer.id, () =>
        createOrOpenProductConversation(null, productContactForm(product.id)),
      );

      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${seller.id}`, `USER:${buyer.id}`]);
      releaseT1();

      await expect(t1).resolves.toBeUndefined();

      const createResult = await t2;
      expect(createResult.success).toBe(false);
      expect(createResult.message).toBe("你们之间存在消息屏蔽，无法发起新的会话沟通");

      expect(await rawClient!.conversation.count({ where: { productId: product.id } })).toBe(0);
      expect(await rawClient!.notification.count({ where: { userId: seller.id } })).toBe(0);
      expect(
        await rawClient!.blockedUser.count({
          where: { blockerId: buyer.id, blockedUserId: seller.id },
        }),
      ).toBe(1);
    });

    it("RACE-BC-02 create wins：T1 会话创建持 pair 锁 → T2 block 等待 → 恰好一会话一首条 → block 提交 → send DENY 且历史可读", async () => {
      const seller = await createFixtureUser("RBC02卖家");
      const buyer = await createFixtureUser("RBC02买家");
      const product = await createProductFixture(seller.id);

      const { getOrCreateConversationSafe } = await import("@/lib/conversation-creation");
      const { rereadListingForConversation } = await import(
        "@/lib/moderation/listing-moderation-query"
      );

      let t1InFlight!: () => void;
      const inFlight = new Promise<void>((resolve) => {
        t1InFlight = resolve;
      });
      let releaseT1!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });

      const t1 = getOrCreateConversationSafe({
        bizType: "PRODUCT",
        bizKeyField: "productId",
        bizId: product.id,
        participantIds: [buyer.id, seller.id],
        initialData: {
          title: "商品咨询：RBC02",
          initialMessageContent: "你好，我想咨询一下。",
          notificationTitle: "收到新的商品咨询",
          notificationContent: "有同学就商品向你发起了会话。",
          counterpartId: seller.id,
          currentUserId: buyer.id,
        },
        gate: {
          kind: "MARKETPLACE_LISTING",
          racePoint: async () => {
            t1InFlight();
            await gate;
          },
          rereadResource: async (tx) => {
            const fresh = await rereadListingForConversation(tx, "PRODUCT", product.id);
            if (!fresh) return null;
            return { campusId: fresh.campusId, participantIds: [buyer.id, fresh.ownerId] };
          },
        },
      });
      await inFlight;

      const { blockUserTx } = await import("@/lib/trust/block-service");
      const { withTransaction } = await import("@/lib/prisma");
      const t2 = withTransaction((tx: Prisma.TransactionClient) =>
        blockUserTx(tx, seller.id, { targetUserId: buyer.id, reason: "RBC02" }),
      );

      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${seller.id}`, `USER:${buyer.id}`]);
      releaseT1();

      const created = await t1;
      expect(created).toMatchObject({ id: expect.any(String) });
      await expect(t2).resolves.toBeUndefined();

      conversationIds.push(created!.id);

      // exactly-once：一个会话 + 一条首条消息 + 一条通知
      expect(await rawClient!.conversation.count({ where: { productId: product.id } })).toBe(1);
      expect(await rawClient!.message.count({ where: { conversationId: created!.id } })).toBe(1);
      expect(await rawClient!.notification.count({ where: { userId: seller.id } })).toBe(1);

      // create 提交后 block 随后提交：历史仍可读，普通 send DENY（无义务）
      const { getConversationDetailPayload } = await import(
        "@/repositories/conversation-repository"
      );
      const payload = await getConversationDetailPayload(created!.id, seller.id);
      expect(payload!.messages.map((m) => m.content)).toContain("你好，我想咨询一下。");
      expect(payload!.communicationPolicy.mode).toBe("BLOCKED");

      const { sendMessage } = await import("@/actions/conversation");
      const sendResult = asResult(
        await asUser(buyer.id, () => sendMessage({ success: false, message: "" }, sendMessageForm(created!.id, "block 后发送"))),
      );
      expect(sendResult.success).toBe(false);
      expect(await rawClient!.message.count({ where: { conversationId: created!.id } })).toBe(1);
    });
  },
);
