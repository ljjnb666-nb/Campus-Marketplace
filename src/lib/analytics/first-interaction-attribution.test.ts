import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateDomainEventIntent } from "@/lib/domain-events/domain-event-registry";
import { resolveMetricContributions } from "@/lib/analytics/metric-registry";

const { record } = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@/lib/domain-events/domain-event", () => ({
  recordDomainEventTx: record,
}));
import { firstReplyEventEmissionEnabled, recordFirstListingReplyIfEligibleTx } from
  "@/lib/analytics/first-interaction-attribution";

const createdAt = new Date("2026-10-08T10:00:00.000Z");
const replyAt = new Date("2026-10-08T10:00:02.123Z");
const refs = {
  productId: "product1", serviceListingId: null, rentalListingId: null,
  errandTaskId: null, orderId: null, rentalOrderId: null,
};
const origin = {
  eventType: "LISTING_CONVERSATION_CREATED",
  schemaVersion: 1,
  aggregateType: "CONVERSATION",
  aggregateId: "conv1",
  campusId: "campus1",
  occurredAt: createdAt,
  payload: { conversationId: "conv1", listingId: "product1", listingType: "PRODUCT" },
};
const input = {
  conversationId: "conv1", senderId: "counterpart1", replyMessageId: "reply1",
  replyAt, conversationCreatedAt: createdAt, campusId: "campus1", refs,
};
function mockTx(fact: unknown = origin, previousReply: unknown = null, starterId = "creator1") {
  const originRead = vi.fn().mockResolvedValue(fact);
  const first = vi.fn().mockImplementation(async (args: { where: { senderId?: string } }) =>
    args.where.senderId
      ? previousReply
      : { id: "initial", senderId: starterId, createdAt },
  );
  return {
    tx: { domainEvent: { findUnique: originRead }, message: { findFirst: first } } as never,
    originRead, first,
  };
}

beforeEach(() => {
  vi.stubEnv("ANALYTICS_CONVERSATION_EVENT_EMISSION", "enabled");
  vi.stubEnv("ANALYTICS_FIRST_REPLY_EVENT_EMISSION", "enabled");
  record.mockReset().mockResolvedValue({ recorded: true });
});
afterEach(() => vi.unstubAllEnvs());

describe("10K-R2c-01 first reply source fact", () => {
  it("strict registry refuses content, user identities, wrong tenant identity and unknown versions", () => {
    const payload = {
      conversationId: "conv1", listingId: "product1", listingType: "PRODUCT",
      replyMessageId: "reply1", elapsedMilliseconds: 2123,
    };
    expect(validateDomainEventIntent(
      "LISTING_CONVERSATION_FIRST_REPLY", 1, "CONVERSATION", "conv1", payload,
    )).toEqual({
      ok: true, payload, occurrenceKey: "LISTING_CONVERSATION_FIRST_REPLY:conv1",
    });
    for (const invalid of [
      { ...payload, messageText: "secret" }, { ...payload, userId: "u1" },
      { ...payload, elapsedMilliseconds: -1 }, { ...payload, elapsedMilliseconds: 0.1 },
      { ...payload, listingType: "ERRAND" },
    ]) {
      expect(validateDomainEventIntent(
        "LISTING_CONVERSATION_FIRST_REPLY", 1, "CONVERSATION", "conv1", invalid,
      )).toMatchObject({ ok: false, reason: "PAYLOAD_INVALID" });
    }
    expect(validateDomainEventIntent(
      "LISTING_CONVERSATION_FIRST_REPLY", 1, "CONVERSATION", "other", payload,
    )).toMatchObject({ ok: false, reason: "AGGREGATE_ID_MISMATCH" });
    expect(validateDomainEventIntent(
      "LISTING_CONVERSATION_FIRST_REPLY", 2, "CONVERSATION", "conv1", payload,
    )).toMatchObject({ ok: false, reason: "UNKNOWN_SCHEMA_VERSION" });
    expect(resolveMetricContributions({
      eventType: "LISTING_CONVERSATION_FIRST_REPLY", schemaVersion: 1,
      aggregateType: "CONVERSATION", aggregateId: "conv1", payload,
    })).toEqual([]);
  });

  it("needs both rollout flags and never reads the DB when disabled", async () => {
    const ctx = mockTx();
    vi.stubEnv("ANALYTICS_CONVERSATION_EVENT_EMISSION", "");
    expect(firstReplyEventEmissionEnabled()).toBe(false);
    expect(await recordFirstListingReplyIfEligibleTx(ctx.tx, input)).toBe("DISABLED");
    vi.stubEnv("ANALYTICS_CONVERSATION_EVENT_EMISSION", "enabled");
    vi.stubEnv("ANALYTICS_FIRST_REPLY_EVENT_EMISSION", "");
    expect(await recordFirstListingReplyIfEligibleTx(ctx.tx, input)).toBe("DISABLED");
    expect(ctx.originRead).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("emits one scoped event for the first direct counterparty reply", async () => {
    const ctx = mockTx();
    expect(await recordFirstListingReplyIfEligibleTx(ctx.tx, input)).toBe("RECORDED");
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(ctx.tx, {
      eventType: "LISTING_CONVERSATION_FIRST_REPLY",
      schemaVersion: 1, aggregateType: "CONVERSATION",
      aggregateId: "conv1", campusId: "campus1", occurredAt: replyAt,
      payload: {
        conversationId: "conv1", listingId: "product1", listingType: "PRODUCT",
        replyMessageId: "reply1", elapsedMilliseconds: 2123,
      },
    });
  });

  it("excludes order-first, demand, mixed refs, spoofed R2b campus and older cohorts", async () => {
    for (const changedRefs of [
      { ...refs, orderId: "order1" },
      { ...refs, errandTaskId: "errand1" },
      { ...refs, serviceListingId: "service1" },
      { ...refs, productId: null, rentalListingId: null },
    ]) {
      const ctx = mockTx();
      expect(await recordFirstListingReplyIfEligibleTx(ctx.tx, { ...input, refs: changedRefs }))
        .toBe("INELIGIBLE");
      expect(ctx.originRead).not.toHaveBeenCalled();
    }
    for (const badFact of [
      null,
      { ...origin, campusId: "otherCampus" },
      { ...origin, occurredAt: new Date("2026-10-08T09:00:00Z") },
      { ...origin, payload: { ...origin.payload, listingId: "wrong" } },
    ]) {
      expect(await recordFirstListingReplyIfEligibleTx(mockTx(badFact).tx, input))
        .toBe("INELIGIBLE");
    }
    expect(record).not.toHaveBeenCalled();
  });

  it("never counts initiator echo, second reply, or negative time as first interaction", async () => {
    expect(await recordFirstListingReplyIfEligibleTx(mockTx(origin, null, "counterpart1").tx, input))
      .toBe("INELIGIBLE");
    expect(await recordFirstListingReplyIfEligibleTx(mockTx(origin, { id: "previous" }).tx, input))
      .toBe("INELIGIBLE");
    expect(await recordFirstListingReplyIfEligibleTx(mockTx().tx, {
      ...input, replyAt: new Date("2026-10-08T09:00:00Z"),
    })).toBe("INELIGIBLE");
    expect(record).not.toHaveBeenCalled();
  });
});
