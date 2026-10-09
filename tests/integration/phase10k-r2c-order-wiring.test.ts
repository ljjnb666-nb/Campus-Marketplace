import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { recordListingConversationCreatedTx } from "@/lib/analytics/conversation-attribution";
import { mintOrderOriginToken, recordAttributedOrderIfEligibleTx } from "@/lib/analytics/order-conversation-attribution";
import { buildLiveDomainEventProjectionDedupeKey } from "@/lib/analytics/projection-contract";

const url = process.env.INTEGRATION_DATABASE_URL;
describe.skipIf(!url)("10K-R2c-02B SERVICE/RENTAL real PostgreSQL", () => {
  let db: PrismaClient;
  let campusId = "", buyerId = "", sellerId = "";
  let serviceCategoryId = "", rentalCategoryId = "";
  let serviceId = "", rentalId = "";
  const conversationIds: string[] = [];
  const orderIds: string[] = [];
  const rentalOrderIds: string[] = [];

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
    await db.$connect();
    const marker = randomUUID().slice(0, 8);
    campusId = (await db.campus.create({ data: {
      slug: "r2c02b-" + marker, name: "02B Campus", schoolName: "Campus",
    } })).id;
    serviceCategoryId = (await db.serviceCategory.create({ data: {
      name: "02B Service", slug: "r2c02b-service-" + marker,
    } })).id;
    rentalCategoryId = (await db.rentalCategory.create({ data: {
      name: "02B Rental", slug: "r2c02b-rental-" + marker,
    } })).id;
    buyerId = (await db.user.create({ data: {
      email: "r2c02b-b-" + marker + "@test.invalid", name: "Buyer",
      passwordHash: "fixture", campusId, schoolName: "Campus",
    } })).id;
    sellerId = (await db.user.create({ data: {
      email: "r2c02b-s-" + marker + "@test.invalid", name: "Seller",
      passwordHash: "fixture", campusId, schoolName: "Campus",
    } })).id;
    serviceId = (await db.serviceListing.create({ data: {
      title: "Teaching", description: "Fixture", categoryId: serviceCategoryId,
      providerId: sellerId, campusId, price: "12.00",
      pricingUnit: "PER_SESSION", locationText: "Library",
    } })).id;
    rentalId = (await db.rentalListing.create({ data: {
      title: "Camera", description: "Fixture", categoryId: rentalCategoryId,
      ownerId: sellerId, campusId, condition: "LIKE_NEW",
      price: "12.00", pricingUnit: "PER_DAY", depositAmount: "0.00",
      minimumDuration: 1, maximumDuration: 7,
      pickupLocation: "Library", returnLocation: "Library",
    } })).id;
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    if (!db) return;
    const domainEvents = await db.domainEvent.findMany({ where: {
      OR: [{ aggregateId: { in: conversationIds } },
        { aggregateId: { in: [...orderIds, ...rentalOrderIds] } }],
      eventType: { in: ["LISTING_CONVERSATION_CREATED",
        "LISTING_CONVERSATION_ORDER_ATTRIBUTED"] },
    }, select: { id: true } });
    const eventIds = domainEvents.map(e => e.id);
    await db.metricContribution.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.projectionReceipt.deleteMany({ where: { eventId: { in: eventIds } } });
    await db.asyncJob.deleteMany({ where: {
      dedupeKey: { in: eventIds.map(buildLiveDomainEventProjectionDedupeKey) },
    } });
    await db.domainEvent.deleteMany({ where: { id: { in: eventIds } } });
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
    await db.rentalOrder.deleteMany({ where: { id: { in: rentalOrderIds } } });
    await db.conversation.deleteMany({ where: { id: { in: conversationIds } } });
    await db.serviceListing.deleteMany({ where: { id: serviceId } });
    await db.rentalListing.deleteMany({ where: { id: rentalId } });
    await db.serviceCategory.deleteMany({ where: { id: serviceCategoryId } });
    await db.rentalCategory.deleteMany({ where: { id: rentalCategoryId } });
    await db.user.deleteMany({ where: { id: { in: [buyerId, sellerId] } } });
    await db.campus.deleteMany({ where: { id: campusId } });
    await db.$disconnect();
  });

  function enable() {
    vi.stubEnv("ANALYTICS_CONVERSATION_EVENT_EMISSION", "enabled");
    vi.stubEnv("ANALYTICS_ORDER_ATTRIBUTION_EMISSION", "enabled");
    vi.stubEnv("ANALYTICS_ORDER_ATTRIBUTION_SECRET", "r2c02b-fixture-signing-secret-over-32-bytes");
  }
  async function createSource(type: "SERVICE" | "RENTAL", withMessage = true) {
    const listingId = type === "SERVICE" ? serviceId : rentalId;
    const c = await db.$transaction(async tx => {
      const conv = await tx.conversation.create({ data: {
        conversationKey: "r2c02b:" + randomUUID(),
        ...(type === "SERVICE" ? { serviceListingId: listingId } : { rentalListingId: listingId }),
        participants: { create: [{ userId: buyerId }, { userId: sellerId }] },
        ...(withMessage ? { messages: { create: {
          senderId: buyerId, type: "DIRECT", content: "DO_NOT_PROJECT_THIS",
        } } } : {}),
      }, select: { id: true, createdAt: true } });
      await recordListingConversationCreatedTx(tx, {
        conversationId: conv.id, campusId, listingId, listingType: type,
        occurredAt: conv.createdAt,
      });
      return conv;
    });
    conversationIds.push(c.id);
    const token = mintOrderOriginToken({
      actorId: buyerId, conversationId: c.id, listingId,
      listingType: type, now: c.createdAt,
    })!;
    expect(token).toBeTruthy();
    return { id: c.id, token, listingId };
  }

  it("SERVICE authoritative order + chat provenance create one scoped fact + outbox job", async () => {
    enable();
    const source = await createSource("SERVICE");
    const result = await db.$transaction(async tx => {
      const order = await tx.order.create({ data: {
        orderNo: "r2c02b-" + randomUUID(), type: "SERVICE",
        paymentStatus: "OFFLINE_PENDING", amount: "12.00",
        buyerId, sellerId, serviceListingId: serviceId,
      } });
      const result = await recordAttributedOrderIfEligibleTx(tx, {
        sourceToken: source.token, orderId: order.id,
        orderType: "SERVICE", actorUserId: buyerId,
      });
      return { order, result };
    });
    orderIds.push(result.order.id);
    expect(result.result).toBe("RECORDED");
    const event = await db.domainEvent.findUniqueOrThrow({ where: {
      occurrenceKey: "LISTING_CONVERSATION_ORDER_ATTRIBUTED:SERVICE:" + result.order.id,
    } });
    expect(event).toMatchObject({ campusId, aggregateId: result.order.id,
      payload: { conversationId: source.id, listingId: serviceId,
        orderId: result.order.id, listingType: "SERVICE" } });
    expect(JSON.stringify(event.payload)).not.toContain("DO_NOT_PROJECT_THIS");
    expect(await db.asyncJob.count({ where: {
      dedupeKey: buildLiveDomainEventProjectionDedupeKey(event.id),
    } })).toBe(1);
  });

  it("RENTAL authoritative order + chat provenance produces rental-scoped fact", async () => {
    enable();
    const source = await createSource("RENTAL");
    const result = await db.$transaction(async tx => {
      const order = await tx.rentalOrder.create({ data: {
        orderNumber: "r2c02b-" + randomUUID(), rentalListingId: rentalId,
        ownerId: sellerId, renterId: buyerId,
        startTime: new Date(Date.now() + 86_400_000),
        endTime: new Date(Date.now() + 172_800_000),
        unitPriceSnapshot: "12.00", pricingUnitSnapshot: "PER_DAY",
        rentalDuration: 1, rentalAmount: "12.00", depositAmount: "0.00",
        finalAmount: "12.00", paymentStatus: "OFFLINE_PENDING",
        pickupLocationSnapshot: "Library", returnLocationSnapshot: "Library",
      } });
      const result = await recordAttributedOrderIfEligibleTx(tx, {
        sourceToken: source.token, orderId: order.id,
        orderType: "RENTAL", actorUserId: buyerId,
      });
      return { order, result };
    });
    rentalOrderIds.push(result.order.id);
    expect(result.result).toBe("RECORDED");
    const event = await db.domainEvent.findUniqueOrThrow({ where: {
      occurrenceKey: "LISTING_CONVERSATION_ORDER_ATTRIBUTED:RENTAL:" + result.order.id,
    } });
    expect(event).toMatchObject({ campusId, aggregateId: result.order.id,
      payload: { conversationId: source.id, listingId: rentalId,
        orderId: result.order.id, listingType: "RENTAL" } });
  });

  it("order-first/no pre-order DIRECT message remains INELIGIBLE", async () => {
    enable();
    const source = await createSource("SERVICE", false);
    const created = await db.$transaction(async tx => {
      const order = await tx.order.create({ data: {
        orderNo: "r2c02b-" + randomUUID(), type: "SERVICE",
        paymentStatus: "OFFLINE_PENDING", amount: "12.00",
        buyerId, sellerId, serviceListingId: serviceId,
      } });
      const result = await recordAttributedOrderIfEligibleTx(tx, {
        sourceToken: source.token, orderId: order.id,
        orderType: "SERVICE", actorUserId: buyerId,
      });
      expect(result).toBe("INELIGIBLE");
      return order;
    });
    orderIds.push(created.id);
    expect(await db.domainEvent.count({ where: {
      occurrenceKey: "LISTING_CONVERSATION_ORDER_ATTRIBUTED:SERVICE:" + created.id,
    } })).toBe(0);
  });
});
