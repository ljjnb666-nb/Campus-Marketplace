import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { recordListingConversationCreatedTx } from "@/lib/analytics/conversation-attribution";
import { recordFirstListingReplyIfEligibleTx } from "@/lib/analytics/first-interaction-attribution";

const url = process.env.INTEGRATION_DATABASE_URL;
describe.skipIf(!url)("10K-R2c-01 first reply PostgreSQL atomicity", () => {
  let db: PrismaClient;
  let campusId = "";
  let listingId = "";
  let categoryId = "";
  let buyerId = "";
  let sellerId = "";
  const createdConversationIds: string[] = [];
  const keyFor = (id: string) =>
    ["ANALYTICS_PROJECT_DOMAIN_EVENT", "schema1", "projection3", id].join(":");

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
    await db.$connect();
    const tag = randomUUID().slice(0, 8);
    const campus = await db.campus.create({
      data: { name: "r2c-" + tag, slug: "r2c-" + tag, schoolName: "Fixture" },
    });
    campusId = campus.id;
    const cat = await db.productCategory.create({
      data: { name: "r2c-" + tag, slug: "r2c-" + tag },
    });
    categoryId = cat.id;
    const buyer = await db.user.create({ data: {
      name: "buyer", email: "r2c-buyer-" + tag + "@test.invalid",
      passwordHash: "fixture", campusId, schoolName: "Fixture",
    } });
    buyerId = buyer.id;
    const seller = await db.user.create({ data: {
      name: "seller", email: "r2c-seller-" + tag + "@test.invalid",
      passwordHash: "fixture", campusId, schoolName: "Fixture",
    } });
    sellerId = seller.id;
    const product = await db.product.create({ data: {
      title: "Fixture", description: "fixture", price: "5.00",
      locationText: "campus", condition: "LIKE_NEW",
      campusId, sellerId, categoryId,
    } });
    listingId = product.id;
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    if (!db) return;
    const events = await db.domainEvent.findMany({
      where: { aggregateId: { in: createdConversationIds }, eventType: {
        in: ["LISTING_CONVERSATION_CREATED", "LISTING_CONVERSATION_FIRST_REPLY"],
      } },
      select: { id: true },
    });
    const eventIds = events.map(e => e.id);
    await db.metricContribution.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.projectionReceipt.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.asyncJob.deleteMany({ where: { dedupeKey: { in: eventIds.map(keyFor) } } });
    await db.domainEvent.deleteMany({ where: { id: { in: eventIds } } });
    await db.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
    await db.product.deleteMany({ where: { id: listingId } });
    await db.user.deleteMany({ where: { id: { in: [buyerId, sellerId] } } });
    await db.productCategory.deleteMany({ where: { id: categoryId } });
    await db.campus.deleteMany({ where: { id: campusId } });
    await db.$disconnect();
  });

  async function createOrigin() {
    const c = await db.$transaction(async tx => {
      const conv = await tx.conversation.create({
        data: {
          conversationKey: "r2c:" + randomUUID(), productId: listingId,
          participants: { create: [{ userId: buyerId }, { userId: sellerId }] },
          messages: { create: {
            type: "DIRECT", senderId: buyerId, content: "PRIVATE FIXTURE",
          } },
        },
        select: { id: true, createdAt: true },
      });
      await recordListingConversationCreatedTx(tx, {
        conversationId: conv.id, listingId, listingType: "PRODUCT",
        campusId, occurredAt: conv.createdAt,
      });
      return conv;
    });
    createdConversationIds.push(c.id);
    return c;
  }

  async function sendDirect(c: { id: string; createdAt: Date }, senderId = sellerId) {
    return db.$transaction(async tx => {
      const m = await tx.message.create({
        data: { conversationId: c.id, senderId, type: "DIRECT", content: "PRIVATE REPLY" },
        select: { id: true, createdAt: true },
      });
      const result = await recordFirstListingReplyIfEligibleTx(tx, {
        conversationId: c.id, senderId, replyMessageId: m.id,
        replyAt: m.createdAt, conversationCreatedAt: c.createdAt,
        campusId,
        refs: {
          productId: listingId, serviceListingId: null, rentalListingId: null,
          orderId: null, rentalOrderId: null, errandTaskId: null,
        },
      });
      return { message: m, result };
    });
  }

  it("one first reply event, one durable projection job, no sensitive payload and no second count", async () => {
    vi.stubEnv("ANALYTICS_CONVERSATION_EVENT_EMISSION", "enabled");
    vi.stubEnv("ANALYTICS_FIRST_REPLY_EVENT_EMISSION", "enabled");
    const c = await createOrigin();
    const one = await sendDirect(c);
    expect(one.result).toBe("RECORDED");
    const event = await db.domainEvent.findUniqueOrThrow({
      where: { occurrenceKey: "LISTING_CONVERSATION_FIRST_REPLY:" + c.id },
    });
    expect(event).toMatchObject({
      eventType: "LISTING_CONVERSATION_FIRST_REPLY", aggregateType: "CONVERSATION",
      aggregateId: c.id, campusId, actorUserId: null, subjectUserId: null,
      payload: {
        conversationId: c.id, listingId, listingType: "PRODUCT",
        replyMessageId: one.message.id,
      },
    });
    expect(event.occurredAt.getTime()).toBe(one.message.createdAt.getTime());
    expect(event.payload).toMatchObject({
      elapsedMilliseconds: one.message.createdAt.getTime() - c.createdAt.getTime(),
    });
    expect(JSON.stringify(event.payload)).not.toMatch(/PRIVATE|content|senderId|userId/);
    expect(await db.asyncJob.count({
      where: { dedupeKey: keyFor(event.id) },
    })).toBe(1);
    const two = await sendDirect(c);
    expect(two.result).toBe("INELIGIBLE");
    expect(await db.domainEvent.count({
      where: { occurrenceKey: "LISTING_CONVERSATION_FIRST_REPLY:" + c.id },
    })).toBe(1);
  });

  it("disabled flag prevents new event but preserves actual message; no historical catchup", async () => {
    const c = await createOrigin();
    vi.stubEnv("ANALYTICS_CONVERSATION_EVENT_EMISSION", "enabled");
    vi.stubEnv("ANALYTICS_FIRST_REPLY_EVENT_EMISSION", "");
    const first = await sendDirect(c);
    expect(first.result).toBe("DISABLED");
    vi.stubEnv("ANALYTICS_FIRST_REPLY_EVENT_EMISSION", "enabled");
    const second = await sendDirect(c);
    expect(second.result).toBe("INELIGIBLE");
    expect(await db.message.count({ where: { conversationId: c.id } })).toBe(3);
    expect(await db.domainEvent.count({
      where: { occurrenceKey: "LISTING_CONVERSATION_FIRST_REPLY:" + c.id },
    })).toBe(0);
  });

  it("rolled-back reply cannot leave a first reply event or projection intent", async () => {
    vi.stubEnv("ANALYTICS_CONVERSATION_EVENT_EMISSION", "enabled");
    vi.stubEnv("ANALYTICS_FIRST_REPLY_EVENT_EMISSION", "enabled");
    const c = await createOrigin();
    await expect(db.$transaction(async tx => {
      const msg = await tx.message.create({
        data: { conversationId: c.id, senderId: sellerId, type: "DIRECT", content: "ROLLBACK" },
        select: { id: true, createdAt: true },
      });
      const result = await recordFirstListingReplyIfEligibleTx(tx, {
        conversationId: c.id, senderId: sellerId, replyMessageId: msg.id,
        replyAt: msg.createdAt, conversationCreatedAt: c.createdAt, campusId,
        refs: {
          productId: listingId, serviceListingId: null, rentalListingId: null,
          orderId: null, rentalOrderId: null, errandTaskId: null,
        },
      });
      expect(result).toBe("RECORDED");
      throw new Error("R2C_ROLLBACK");
    })).rejects.toThrow("R2C_ROLLBACK");
    expect(await db.message.count({ where: { conversationId: c.id } })).toBe(1);
    expect(await db.domainEvent.count({
      where: { occurrenceKey: "LISTING_CONVERSATION_FIRST_REPLY:" + c.id },
    })).toBe(0);
  });
});
