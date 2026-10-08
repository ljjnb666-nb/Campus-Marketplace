import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.INTEGRATION_DATABASE_URL;

describe.skipIf(!url)("10K-R2b listing conversation fact atomicity (real PostgreSQL)", () => {
  let db: PrismaClient;
  let campusId = "";
  let sellerId = "";
  let buyerId = "";
  let categoryId = "";
  let listingId = "";
  let recordFact: typeof import("@/lib/analytics/conversation-attribution")["recordListingConversationCreatedTx"];
  let project: typeof import("@/lib/analytics/domain-event-projection")["projectDomainEventTx"];
  const versionedJobKey = (eventId: string) =>
    ["ANALYTICS_PROJECT_DOMAIN_EVENT", "schema1", "projection3", eventId].join(":");

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
    await db.$connect();
    ({ recordListingConversationCreatedTx: recordFact } = await import("@/lib/analytics/conversation-attribution"));
    ({ projectDomainEventTx: project } = await import("@/lib/analytics/domain-event-projection"));
    const tag = randomUUID().slice(0, 8);
    const c = await db.campus.create({
      data: { name: "r2b-c-" + tag, slug: "r2b-" + tag, schoolName: "Fixture University" },
    });
    campusId = c.id;
    const category = await db.productCategory.create({
      data: { name: "r2b-p-" + tag, slug: "r2b-p-" + tag },
    });
    categoryId = category.id;
    const [seller, buyer] = await Promise.all([
      db.user.create({ data: {
        name: "seller", email: "r2b-seller-" + tag + "@test.invalid",
        passwordHash: "test-only", campusId, schoolName: "Fixture University",
      } }),
      db.user.create({ data: {
        name: "buyer", email: "r2b-buyer-" + tag + "@test.invalid",
        passwordHash: "test-only", campusId, schoolName: "Fixture University",
      } }),
    ]);
    sellerId = seller.id;
    buyerId = buyer.id;
    const listing = await db.product.create({ data: {
      title: "Fixture", description: "fixture", price: "5.00", locationText: "campus",
      condition: "LIKE_NEW", campusId, sellerId, categoryId,
    } });
    listingId = listing.id;
  });

  afterAll(async () => {
    if (!db) return;
    const events = await db.domainEvent.findMany({
      where: { campusId, eventType: "LISTING_CONVERSATION_CREATED" },
      select: { id: true },
    });
    const eventIds = events.map(e => e.id);
    await db.metricContribution.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.projectionReceipt.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.asyncJob.deleteMany({ where: { dedupeKey: { in: eventIds.map(versionedJobKey) } } });
    await db.domainEvent.deleteMany({ where: { id: { in: eventIds } } });
    await db.conversation.deleteMany({ where: { productId: listingId } });
    await db.product.deleteMany({ where: { id: listingId } });
    await db.user.deleteMany({ where: { id: { in: [sellerId, buyerId] } } });
    await db.productCategory.deleteMany({ where: { id: categoryId } });
    await db.campus.deleteMany({ where: { id: campusId } });
    await db.$disconnect();
  });

  async function createConversationWithFact(key: string) {
    return db.$transaction(async tx => {
      const c = await tx.conversation.create({
        data: {
          conversationKey: key, productId: listingId,
          participants: { create: [{ userId: sellerId }, { userId: buyerId }] },
          messages: { create: {
            senderId: buyerId, type: "DIRECT", content: "fixture",
          } },
        },
        select: { id: true, createdAt: true },
      });
      const inserted = await recordFact(tx, {
        conversationId: c.id, listingId, listingType: "PRODUCT",
        campusId, occurredAt: c.createdAt,
      });
      return { conversation: c, inserted };
    });
  }

  it("appends one scoped, message-free event and durable projection intent", async () => {
    const first = await createConversationWithFact("R2B:product:" + randomUUID());
    expect(first.inserted).toMatchObject({
      recorded: true, occurrenceKey: "LISTING_CONVERSATION_CREATED:" + first.conversation.id,
    });
    const event = await db.domainEvent.findUniqueOrThrow({
      where: { occurrenceKey: first.inserted.occurrenceKey },
    });
    expect(event).toMatchObject({
      aggregateType: "CONVERSATION", aggregateId: first.conversation.id, campusId,
      sourceType: "DOMAIN_TX", actorUserId: null, subjectUserId: null, sourceId: null,
      payload: { conversationId: first.conversation.id, listingId, listingType: "PRODUCT" },
    });
    expect(event.occurredAt.getTime()).toBe(first.conversation.createdAt.getTime());
    expect(JSON.stringify(event.payload)).not.toMatch(/fixture|sender|message|query|userId/);
    expect(await db.asyncJob.count({
      where: { dedupeKey: versionedJobKey(event.id) },
    })).toBe(1);

    // Projection v3 is unchanged: new factual event is zero-contribution.
    await db.$transaction(tx => project(tx, event.id));
    expect(await db.projectionReceipt.count({
      where: { eventId: event.id, projectionVersion: 3 },
    })).toBe(1);
    expect(await db.metricContribution.count({ where: { eventId: event.id } })).toBe(0);
    expect(await db.$transaction(tx => project(tx, event.id)))
      .toEqual({ projected: false, contributionCount: 0 });

    const again = await db.$transaction(tx => recordFact(tx, {
      conversationId: first.conversation.id,
      listingId, listingType: "PRODUCT", campusId,
      occurredAt: first.conversation.createdAt,
    }));
    expect(again.recorded).toBe(false);
    expect(await db.domainEvent.count({
      where: { occurrenceKey: first.inserted.occurrenceKey },
    })).toBe(1);
  });

  it("rollback after event insertion leaves no conversation, event or job", async () => {
    const key = "R2B:rollback:" + randomUUID();
    const eventsBefore = await db.domainEvent.count({
      where: { campusId, eventType: "LISTING_CONVERSATION_CREATED" },
    });
    let rolledBackEventId: string | null = null;
    await expect(db.$transaction(async tx => {
      const c = await tx.conversation.create({
        data: { conversationKey: key, productId: listingId },
        select: { id: true, createdAt: true },
      });
      await recordFact(tx, {
        conversationId: c.id, listingId, listingType: "PRODUCT",
        campusId, occurredAt: c.createdAt,
      });
      const staged = await tx.domainEvent.findUniqueOrThrow({
        where: { occurrenceKey: "LISTING_CONVERSATION_CREATED:" + c.id },
        select: { id: true },
      });
      rolledBackEventId = staged.id;
      throw new Error("TEST_ROLLBACK");
    })).rejects.toThrow("TEST_ROLLBACK");
    expect(await db.conversation.count({ where: { conversationKey: key } })).toBe(0);
    expect(await db.domainEvent.count({
      where: { campusId, eventType: "LISTING_CONVERSATION_CREATED" },
    })).toBe(eventsBefore);
    expect(rolledBackEventId).not.toBeNull();
    expect(await db.domainEvent.count({ where: { id: rolledBackEventId! } })).toBe(0);
    expect(await db.asyncJob.count({
      where: { dedupeKey: versionedJobKey(rolledBackEventId!) },
    })).toBe(0);
  });

  it("same conversation cannot be reassigned to a different tenant or listing", async () => {
    const first = await createConversationWithFact("R2B:conflict:" + randomUUID());
    await expect(db.$transaction(tx => recordFact(tx, {
      conversationId: first.conversation.id, listingId: "forged-listing",
      listingType: "PRODUCT", campusId, occurredAt: first.conversation.createdAt,
    }))).rejects.toMatchObject({ code: "DOMAIN_EVENT_OCCURRENCE_CONFLICT" });
    await expect(db.$transaction(tx => recordFact(tx, {
      conversationId: first.conversation.id, listingId,
      listingType: "PRODUCT", campusId: "cross-campus", occurredAt: first.conversation.createdAt,
    }))).rejects.toMatchObject({ code: "DOMAIN_EVENT_OCCURRENCE_CONFLICT" });
  });
});
