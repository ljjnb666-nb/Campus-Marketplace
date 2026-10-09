import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordDomainEventTx } from "@/lib/domain-events/domain-event";
import {
  evaluateUnreleasedFunnelCohort,
  type FunnelFact,
} from "@/lib/analytics/funnel-cohort-semantics";
import { buildLiveDomainEventProjectionDedupeKey } from "@/lib/analytics/projection-contract";

const url = process.env.INTEGRATION_DATABASE_URL;
const DAY = 86_400_000;
const start = new Date("2026-06-01T00:00:00.000Z");
const end = new Date(start.getTime() + 7 * DAY);
const observed = new Date(end.getTime() + 8 * DAY);

describe.skipIf(!url)("10K-R2d-01 PG ledger-backed provisional cohort diagnostic", () => {
  let db: PrismaClient;
  const campusId = "campus-r2d-" + randomUUID();
  const otherCampusId = "campus-r2d-" + randomUUID();
  const listingId = "listing-r2d-" + randomUUID();
  const conversationId = "conv-r2d-" + randomUUID();
  const orderId = "order-r2d-" + randomUUID();

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
    await db.$connect();
  });

  afterAll(async () => {
    if (!db) return;
    const events = await db.domainEvent.findMany({
      where: { campusId: { in: [campusId, otherCampusId] } },
      select: { id: true },
    });
    const ids = events.map(event => event.id);
    await db.metricContribution.deleteMany({ where: { eventId: { in: ids } } });
    await db.projectionReceipt.deleteMany({ where: { eventId: { in: ids } } });
    await db.asyncJob.deleteMany({ where: {
      dedupeKey: { in: ids.map(buildLiveDomainEventProjectionDedupeKey) },
    } });
    await db.domainEvent.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  it("reads immutable, same-campus real PG events without exposing a rate", async () => {
    const at = (days: number) => new Date(start.getTime() + days * DAY);
    const canonical = [
      {
        eventType: "LIQUIDITY_LISTING_CREATED", aggregateType: "LISTING",
        aggregateId: listingId, campusId, occurredAt: at(1),
        payload: { listingId, listingType: "PRODUCT" },
      },
      {
        eventType: "LISTING_CONVERSATION_CREATED", aggregateType: "CONVERSATION",
        aggregateId: conversationId, campusId, occurredAt: at(2),
        payload: { conversationId, listingId, listingType: "PRODUCT" },
      },
      {
        eventType: "LISTING_CONVERSATION_FIRST_REPLY", aggregateType: "CONVERSATION",
        aggregateId: conversationId, campusId,
        occurredAt: new Date(at(2).getTime() + 300_000),
        payload: {
          conversationId, listingId, listingType: "PRODUCT",
          replyMessageId: "reply-r2d-" + randomUUID(), elapsedMilliseconds: 300_000,
        },
      },
      {
        eventType: "LISTING_CONVERSATION_ORDER_ATTRIBUTED",
        aggregateType: "ORDER_ATTRIBUTION", aggregateId: orderId,
        campusId, occurredAt: at(3),
        payload: { conversationId, orderId, listingId, listingType: "PRODUCT" },
      },
    ] as const;
    await db.$transaction(async tx => {
      for (const f of canonical) {
        await recordDomainEventTx(tx, { ...f, schemaVersion: 1 });
      }
      const otherListingId = "listing-r2d-other-" + randomUUID();
      await recordDomainEventTx(tx, {
        eventType: "LIQUIDITY_LISTING_CREATED", schemaVersion: 1,
        aggregateType: "LISTING", aggregateId: otherListingId,
        campusId: otherCampusId, occurredAt: at(1),
        payload: { listingId: otherListingId, listingType: "PRODUCT" },
      });
    });
    const records = await db.domainEvent.findMany({
      where: {
        campusId,
        eventType: { in: canonical.map(f => f.eventType) },
        occurredAt: { gte: start, lte: new Date(end.getTime() + 7 * DAY) },
      },
      select: {
        eventType: true, schemaVersion: true, aggregateType: true,
        aggregateId: true, occurrenceKey: true, campusId: true,
        sourceType: true, occurredAt: true, payload: true,
      },
    });
    const output = evaluateUnreleasedFunnelCohort({
      campusId, listingType: "PRODUCT", cohortStart: start,
      cohortEnd: end, observedThrough: observed,
      facts: records as FunnelFact[],
    });
    expect(output).toEqual({
      status: "UNAVAILABLE_PENDING_CAPTURE_COVERAGE",
      candidate: {
        newListings: 1, listingsWithConversations: 1,
        eligibleConversations: 1, conversationsWithOrders: 1,
        conversationsWithFirstReply: 1, censoredConversations: 0,
        medianFirstReplyMilliseconds: 300_000,
        excludedNonRealtimeFacts: 0, invalidOrDuplicateFacts: 0,
      },
    });
    expect(JSON.stringify(records)).not.toContain("private message");
    expect(records.every(f => f.campusId === campusId)).toBe(true);
  });
});
