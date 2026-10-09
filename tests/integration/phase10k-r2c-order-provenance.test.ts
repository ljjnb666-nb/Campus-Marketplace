import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { recordListingConversationCreatedTx } from "@/lib/analytics/conversation-attribution";
import { computeProductReservationExpiresAt } from "@/lib/product-reservation";
import {
  mintOrderOriginToken, recordAttributedOrderIfEligibleTx,
} from "@/lib/analytics/order-conversation-attribution";

const url = process.env.INTEGRATION_DATABASE_URL;
describe.skipIf(!url)("10K-R2c-02A order origin (real PostgreSQL)", () => {
  let db: PrismaClient;
  let campusId = "", buyerId = "", sellerId = "", listingId = "", categoryId = "";
  const convIds: string[] = [];
  const orderIds: string[] = [];
  const projectionKey = (id: string) =>
    "ANALYTICS_PROJECT_DOMAIN_EVENT:schema1:projection3:" + id;
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
    await db.$connect();
    const tag = randomUUID().slice(0, 8);
    const campus = await db.campus.create({ data: {
      name: "r2c-order-" + tag, slug: "r2c-order-" + tag, schoolName: "Fixture Campus",
    } });
    campusId = campus.id;
    const cat = await db.productCategory.create({ data: {
      name: "r2c-cat-" + tag, slug: "r2c-cat-" + tag,
    } });
    categoryId = cat.id;
    const buyer = await db.user.create({ data: {
      name: "Buyer", email: "r2c-order-b-" + tag + "@test.invalid",
      passwordHash: "fixture", campusId, schoolName: "Fixture Campus",
    } });
    buyerId = buyer.id;
    const seller = await db.user.create({ data: {
      name: "Seller", email: "r2c-order-s-" + tag + "@test.invalid",
      passwordHash: "fixture", campusId, schoolName: "Fixture Campus",
    } });
    sellerId = seller.id;
    const listing = await db.product.create({ data: {
      title: "Fixture", description: "Fixture",
      condition: "LIKE_NEW", price: "12.00", locationText: "Library",
      campusId, sellerId, categoryId,
    } });
    listingId = listing.id;
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    if (!db) return;
    const events = await db.domainEvent.findMany({
      where: { eventType: { in: [
        "LISTING_CONVERSATION_CREATED", "LISTING_CONVERSATION_ORDER_ATTRIBUTED",
      ] }, OR: [
        { aggregateId: { in: convIds } },
        { aggregateId: { in: orderIds } },
      ] },
      select: { id: true },
    });
    const ids = events.map(e => e.id);
    await db.metricContribution.deleteMany({ where: { eventId: { in: ids } } });
    await db.projectionReceipt.deleteMany({ where: { eventId: { in: ids } } });
    await db.asyncJob.deleteMany({ where: { dedupeKey: { in: ids.map(projectionKey) } } });
    await db.domainEvent.deleteMany({ where: { id: { in: ids } } });
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
    await db.conversation.deleteMany({ where: { id: { in: convIds } } });
    await db.product.deleteMany({ where: { id: listingId } });
    await db.user.deleteMany({ where: { id: { in: [buyerId, sellerId] } } });
    await db.productCategory.deleteMany({ where: { id: categoryId } });
    await db.campus.deleteMany({ where: { id: campusId } });
    await db.$disconnect();
  });

  async function origin() {
    const c = await db.$transaction(async tx => {
      const conv = await tx.conversation.create({ data: {
        conversationKey: "r2co:" + randomUUID(), productId: listingId,
        participants: { create: [{ userId: buyerId }, { userId: sellerId }] },
        messages: { create: {
          senderId: buyerId, type: "DIRECT", content: "PRIVATE MESSAGE",
        } },
      }, select: { id: true, createdAt: true } });
      await recordListingConversationCreatedTx(tx, {
        conversationId: conv.id, listingId, listingType: "PRODUCT",
        campusId, occurredAt: conv.createdAt,
      });
      return conv;
    });
    convIds.push(c.id);
    return c;
  }

  function rollout() {
    vi.stubEnv("ANALYTICS_CONVERSATION_EVENT_EMISSION", "enabled");
    vi.stubEnv("ANALYTICS_ORDER_ATTRIBUTION_EMISSION", "enabled");
    vi.stubEnv("ANALYTICS_ORDER_ATTRIBUTION_SECRET", "fixture-r2c-order-secret-over-32-bytes");
  }

  it("a signed conversation-origin order emits one scoped event and projection job in order tx", async () => {
    rollout();
    const c = await origin();
    const token = mintOrderOriginToken({
      actorId: buyerId, conversationId: c.id, listingId,
      listingType: "PRODUCT", now: c.createdAt,
    })!;
    expect(token).toBeTruthy();
    const result = await db.$transaction(async tx => {
      const order = await tx.order.create({ data: {
        orderNo: "r2co-" + randomUUID(), type: "PRODUCT", amount: "12.00",
        buyerId, sellerId, productId: listingId,
        paymentStatus: "OFFLINE_PENDING",
        productReservationExpiresAt: computeProductReservationExpiresAt(new Date()),
      } });
      const state = await recordAttributedOrderIfEligibleTx(tx, {
        sourceToken: token, orderId: order.id, orderType: "PRODUCT", actorUserId: buyerId,
      });
      return { order, state };
    });
    orderIds.push(result.order.id);
    expect(result.state).toBe("RECORDED");
    const event = await db.domainEvent.findUniqueOrThrow({
      where: { occurrenceKey:
        "LISTING_CONVERSATION_ORDER_ATTRIBUTED:PRODUCT:" + result.order.id },
    });
    expect(event).toMatchObject({
      aggregateType: "ORDER_ATTRIBUTION", aggregateId: result.order.id, campusId,
      actorUserId: null, subjectUserId: null,
      payload: {
        conversationId: c.id, orderId: result.order.id,
        listingId, listingType: "PRODUCT",
      },
    });
    expect(event.occurredAt.getTime()).toBe(result.order.createdAt.getTime());
    expect(JSON.stringify(event.payload)).not.toMatch(/PRIVATE|userId|Buyer|Seller|price/);
    expect(await db.asyncJob.count({
      where: { dedupeKey: projectionKey(event.id) },
    })).toBe(1);
  });

  it("same product and parties without explicit signed intent MUST remain unattributed", async () => {
    rollout();
    await origin();
    const order = await db.$transaction(async tx => {
      const newOrder = await tx.order.create({ data: {
        orderNo: "r2co-" + randomUUID(), type: "PRODUCT", amount: "12.00",
        buyerId, sellerId, productId: listingId,
        paymentStatus: "OFFLINE_PENDING",
        productReservationExpiresAt: computeProductReservationExpiresAt(new Date()),
      } });
      const result = await recordAttributedOrderIfEligibleTx(tx, {
        orderId: newOrder.id, orderType: "PRODUCT", actorUserId: buyerId,
      });
      expect(result).toBe("INELIGIBLE");
      return newOrder;
    });
    orderIds.push(order.id);
    expect(await db.domainEvent.count({ where: {
      occurrenceKey: "LISTING_CONVERSATION_ORDER_ATTRIBUTED:PRODUCT:" + order.id,
    } })).toBe(0);
  });

  it("transaction rollback removes the order, origin attribution and durable job", async () => {
    rollout();
    const c = await origin();
    const token = mintOrderOriginToken({
      actorId: buyerId, conversationId: c.id, listingId,
      listingType: "PRODUCT", now: c.createdAt,
    })!;
    const orderNo = "r2co-rollback-" + randomUUID();
    await expect(db.$transaction(async tx => {
      const order = await tx.order.create({ data: {
        orderNo, type: "PRODUCT", amount: "12.00", buyerId, sellerId, productId: listingId,
        paymentStatus: "OFFLINE_PENDING",
        productReservationExpiresAt: computeProductReservationExpiresAt(new Date()),
      } });
      expect(await recordAttributedOrderIfEligibleTx(tx, {
        sourceToken: token, orderId: order.id,
        orderType: "PRODUCT", actorUserId: buyerId,
      })).toBe("RECORDED");
      throw new Error("ROLLBACK_ORDER_WITH_ORIGIN");
    })).rejects.toThrow("ROLLBACK_ORDER_WITH_ORIGIN");
    expect(await db.order.count({ where: { orderNo } })).toBe(0);
    expect(await db.domainEvent.count({ where: {
      eventType: "LISTING_CONVERSATION_ORDER_ATTRIBUTED",
      campusId,
      payload: { path: ["conversationId"], equals: c.id },
    } })).toBe(0);
  });
});
