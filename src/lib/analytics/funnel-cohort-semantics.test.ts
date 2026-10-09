import { describe, expect, it } from "vitest";
import {
  evaluateUnreleasedFunnelCohort,
  FUNNEL_CONVERSION_WINDOW_MS,
  type FunnelFact,
} from "@/lib/analytics/funnel-cohort-semantics";
import {
  LIQUIDITY_LISTING_CREATED_EVENT_TYPE as LISTING,
  LISTING_CONVERSATION_CREATED_EVENT_TYPE as CONVERSATION,
  LISTING_CONVERSATION_FIRST_REPLY_EVENT_TYPE as REPLY,
  LISTING_CONVERSATION_ORDER_ATTRIBUTED_EVENT_TYPE as ORDER,
  validateDomainEventIntent,
} from "@/lib/domain-events/domain-event-registry";

const start = new Date("2026-06-01T00:00:00.000Z");
const end = new Date("2026-06-08T00:00:00.000Z");
const observed = new Date("2026-06-16T00:00:00.000Z");
const day = 86_400_000;
const date = (dayOffset: number) => new Date(start.getTime() + dayOffset * day);
const base = () => ({ campusId: "campus-a", listingType: "PRODUCT" as const,
  cohortStart: start, cohortEnd: end, observedThrough: observed });

function fact(kind: "listing" | "conversation" | "reply" | "order", opts: {
  listingId?: string; conversationId?: string; orderId?: string;
  when?: number; campusId?: string; listingType?: "PRODUCT" | "SERVICE" | "RENTAL";
  elapsed?: number; sourceType?: string;
} = {}): FunnelFact {
  const listingId = opts.listingId ?? "listing-1";
  const conversationId = opts.conversationId ?? "conv-1";
  const orderId = opts.orderId ?? "order-1";
  const listingType = opts.listingType ?? "PRODUCT";
  const eventType = kind === "listing" ? LISTING :
    kind === "conversation" ? CONVERSATION : kind === "reply" ? REPLY : ORDER;
  const payload: Record<string, unknown> = kind === "listing"
    ? { listingId, listingType }
    : kind === "conversation"
      ? { conversationId, listingId, listingType }
      : kind === "reply"
        ? { conversationId, listingId, listingType,
            replyMessageId: "reply-" + conversationId,
            elapsedMilliseconds: opts.elapsed ?? 300_000 }
        : { conversationId, orderId, listingId, listingType };
  const aggregateType = kind === "listing" ? "LISTING" :
    kind === "order" ? "ORDER_ATTRIBUTION" : "CONVERSATION";
  const aggregateId = kind === "listing" ? listingId :
    kind === "order" ? orderId : conversationId;
  const canonical = validateDomainEventIntent(eventType, 1, aggregateType, aggregateId, payload);
  if (!canonical.ok) throw Error("invalid test fixture");
  return {
    eventType, schemaVersion: 1, aggregateType, aggregateId,
    occurrenceKey: canonical.occurrenceKey, payload,
    campusId: opts.campusId ?? "campus-a",
    sourceType: opts.sourceType ?? "DOMAIN_TX",
    occurredAt: date(opts.when ?? 1),
  };
}

describe("Phase 10K-R2d-01 provisional funnel cohorts (NEVER public rates)", () => {
  it("counts unique listing and conversation cohorts, order and first reply", () => {
    const facts = [
      fact("listing", { when: 0 }),
      fact("listing", { listingId: "listing-2", when: 0 }),
      fact("conversation", { when: 1 }),
      fact("conversation", { conversationId: "conv-2", listingId: "listing-2", when: 2 }),
      fact("reply", { when: 1 + 300_000 / day, elapsed: 300_000 }),
      fact("order", { when: 2 }),
      fact("order", { orderId: "order-2", when: 3 }),
    ];
    expect(evaluateUnreleasedFunnelCohort({ ...base(), facts })).toEqual({
      status: "UNAVAILABLE_PENDING_CAPTURE_COVERAGE",
      candidate: {
        newListings: 2,
        listingsWithConversations: 2,
        eligibleConversations: 2,
        conversationsWithOrders: 1,
        conversationsWithFirstReply: 1,
        censoredConversations: 1,
        medianFirstReplyMilliseconds: 300_000,
        excludedNonRealtimeFacts: 0,
        invalidOrDuplicateFacts: 0,
      },
    });
  });

  it("never presents zero as a verified 0% when facts are absent", () => {
    expect(evaluateUnreleasedFunnelCohort({ ...base(), facts: [] })).toMatchObject({
      status: "UNAVAILABLE_PENDING_CAPTURE_COVERAGE",
      candidate: { newListings: 0, eligibleConversations: 0 },
    });
  });

  it("rejects immature cohorts and invalid intervals without candidate counts", () => {
    for (const input of [
      { ...base(), observedThrough: new Date(end.getTime() + FUNNEL_CONVERSION_WINDOW_MS - 1) },
      { ...base(), cohortEnd: start },
      { ...base(), cohortStart: new Date("invalid") },
      { ...base(), cohortEnd: new Date(start.getTime() + 6 * day) },
      { ...base(), campusId: "" },
      { ...base(), listingType: "UNKNOWN" as "PRODUCT" },
    ]) {
      expect(evaluateUnreleasedFunnelCohort({ ...input, facts: [] }).candidate).toBeNull();
    }
  });

  it("includes response and conversion at exact seven-day boundary", () => {
    const facts = [
      fact("listing", { when: 0 }),
      fact("conversation", { when: 0 }),
      fact("reply", { when: 7, elapsed: FUNNEL_CONVERSION_WINDOW_MS }),
      fact("order", { when: 7 }),
    ];
    expect(evaluateUnreleasedFunnelCohort({ ...base(), facts }).candidate)
      .toMatchObject({
        listingsWithConversations: 1, conversationsWithOrders: 1,
        conversationsWithFirstReply: 1, censoredConversations: 0,
      });
  });

  it("does not include events exactly at the exclusive cohort-end as denominator", () => {
    const facts = [
      fact("listing", { when: 7 }),
      fact("conversation", { when: 7 }),
      fact("order", { when: 8 }),
    ];
    expect(evaluateUnreleasedFunnelCohort({ ...base(), facts }).candidate)
      .toMatchObject({
        newListings: 0, eligibleConversations: 0, conversationsWithOrders: 0,
      });
  });

  it("counts a post-cohort conversation for an eligible listing numerator only", () => {
    const facts = [
      fact("listing", { when: 6 }),
      fact("conversation", { when: 8 }),
      fact("order", { when: 9 }),
    ];
    expect(evaluateUnreleasedFunnelCohort({ ...base(), facts }).candidate)
      .toMatchObject({
        newListings: 1, listingsWithConversations: 1,
        eligibleConversations: 0, conversationsWithOrders: 0,
      });
  });

  it("rejects order-first and wrong-listing joins", () => {
    const facts = [
      fact("listing", { when: 1 }),
      fact("conversation", { when: 2 }),
      fact("order", { when: 1 }),
      fact("order", { orderId: "order-2", listingId: "other", when: 3 }),
    ];
    expect(evaluateUnreleasedFunnelCohort({ ...base(), facts }).candidate)
      .toMatchObject({ eligibleConversations: 1, conversationsWithOrders: 0 });
  });

  it("rejects conversions after 7 days, even if they are inside the fetched range", () => {
    const facts = [
      fact("listing", { when: 0 }),
      fact("conversation", { when: 0 }),
      fact("order", { when: 7 + 1 / day }),
      fact("reply", { when: 7 + 1 / day, elapsed: FUNNEL_CONVERSION_WINDOW_MS + 1000 }),
    ];
    expect(evaluateUnreleasedFunnelCohort({ ...base(), facts }).candidate)
      .toMatchObject({
        conversationsWithOrders: 0,
        conversationsWithFirstReply: 0, censoredConversations: 1,
      });
  });

  it("excludes first reply when its elapsedMilliseconds disagree with event time", () => {
    const facts = [
      fact("conversation", { when: 1 }),
      fact("reply", { when: 2, elapsed: 300_000 }),
    ];
    expect(evaluateUnreleasedFunnelCohort({ ...base(), facts }).candidate)
      .toMatchObject({ conversationsWithFirstReply: 0, medianFirstReplyMilliseconds: null });
  });

  it("uses median of verified durations and censors nonresponders", () => {
    const facts = [
      fact("conversation", { when: 0 }),
      fact("conversation", { conversationId: "conv-2", when: 1 }),
      fact("conversation", { conversationId: "conv-3", when: 2 }),
      fact("reply", { when: 300_000 / day, elapsed: 300_000 }),
      fact("reply", { conversationId: "conv-2", when: 1 + 900_000 / day, elapsed: 900_000 }),
    ];
    expect(evaluateUnreleasedFunnelCohort({ ...base(), facts }).candidate)
      .toMatchObject({
        eligibleConversations: 3,
        conversationsWithFirstReply: 2,
        censoredConversations: 1,
        medianFirstReplyMilliseconds: 600_000,
      });
  });

  it("ignores other campus or listing type without leaking those totals", () => {
    const facts = [
      fact("listing", { campusId: "campus-b" }),
      fact("conversation", { campusId: "campus-b" }),
      fact("listing", { listingType: "SERVICE" }),
      fact("conversation", { listingType: "SERVICE" }),
    ];
    expect(evaluateUnreleasedFunnelCohort({ ...base(), facts }).candidate)
      .toMatchObject({ newListings: 0, eligibleConversations: 0 });
  });

  it("excludes non-live backfills from v1 cohort eligibility", () => {
    const facts = [
      fact("listing", { sourceType: "BACKFILL" }),
      fact("conversation", { sourceType: "BACKFILL" }),
    ];
    expect(evaluateUnreleasedFunnelCohort({ ...base(), facts }).candidate)
      .toMatchObject({
        newListings: 0, eligibleConversations: 0,
        excludedNonRealtimeFacts: 2,
      });
  });

  it("deduplicates exact occurrence keys instead of inflating the denominator", () => {
    const f = fact("conversation");
    const facts = [f, f, { ...f, occurredAt: date(2) }];
    expect(evaluateUnreleasedFunnelCohort({ ...base(), facts }).candidate)
      .toMatchObject({
        eligibleConversations: 1,
        invalidOrDuplicateFacts: 2,
      });
  });

  it("rejects schema/occurrence/aggregate invalidity rather than guessing", () => {
    const f = fact("conversation");
    const facts = [
      { ...f, schemaVersion: 999 },
      { ...f, occurrenceKey: "FORGED" },
      { ...f, aggregateId: "unrelated" },
      { ...f, payload: { ...f.payload as Record<string, unknown>, messageText: "PII" } },
    ];
    expect(evaluateUnreleasedFunnelCohort({ ...base(), facts }).candidate)
      .toMatchObject({ eligibleConversations: 0, invalidOrDuplicateFacts: 4 });
  });

  it("matches future conversations within 7d of a listing but not after 7d", () => {
    const facts = [
      fact("listing", { when: 0 }),
      fact("conversation", { when: 7, conversationId: "conv-ok" }),
      fact("conversation", { when: 7 + 1 / day, conversationId: "conv-late" }),
    ];
    expect(evaluateUnreleasedFunnelCohort({ ...base(), facts }).candidate)
      .toMatchObject({ listingsWithConversations: 1 });
  });
});
