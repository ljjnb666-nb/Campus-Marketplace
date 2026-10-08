import { describe, expect, it } from "vitest";
import { validateDomainEventIntent } from "@/lib/domain-events/domain-event-registry";
import { resolveMetricContributions } from "@/lib/analytics/metric-registry";

describe("Phase 10K-R2b canonical listing conversation fact", () => {
  it("accepts only machine IDs and stable conversation occurrence", () => {
    expect(validateDomainEventIntent("LISTING_CONVERSATION_CREATED", 1, "CONVERSATION", "conv1", {
      conversationId: "conv1", listingId: "listing1", listingType: "PRODUCT",
    })).toEqual({
      ok: true, occurrenceKey: "LISTING_CONVERSATION_CREATED:conv1",
      payload: { conversationId: "conv1", listingId: "listing1", listingType: "PRODUCT" },
    });
    expect(validateDomainEventIntent("LISTING_CONVERSATION_CREATED", 1, "CONVERSATION", "conv1", {
      conversationId: "conv1", listingId: "listing1", listingType: "RENTAL",
    })).toMatchObject({ ok: true, occurrenceKey: "LISTING_CONVERSATION_CREATED:conv1" });
  });

  it("fails closed on unknown version, wrong aggregate, spoofed IDs or PII", () => {
    const valid = { conversationId: "c", listingId: "p", listingType: "SERVICE" };
    expect(validateDomainEventIntent("LISTING_CONVERSATION_CREATED", 2, "CONVERSATION", "c", valid))
      .toEqual({ ok: false, reason: "UNKNOWN_SCHEMA_VERSION" });
    expect(validateDomainEventIntent("LISTING_CONVERSATION_CREATED", 1, "LISTING", "c", valid))
      .toEqual({ ok: false, reason: "AGGREGATE_TYPE_MISMATCH" });
    expect(validateDomainEventIntent("LISTING_CONVERSATION_CREATED", 1, "CONVERSATION", "other", valid))
      .toEqual({ ok: false, reason: "AGGREGATE_ID_MISMATCH" });
    for (const payload of [
      { ...valid, rawMessage: "test" }, { ...valid, actorUserId: "u" },
      { ...valid, query: "secret search" }, { ...valid, listingType: "ERRAND" },
      { ...valid, listingType: "PRODUCT_ORDER" }, { ...valid, listingId: "" },
    ]) {
      expect(validateDomainEventIntent("LISTING_CONVERSATION_CREATED", 1, "CONVERSATION", "c", payload))
        .toEqual({ ok: false, reason: "PAYLOAD_INVALID" });
    }
  });

  it("does not fabricate conversion metrics in the existing projection", () => {
    expect(resolveMetricContributions({
      eventType: "LISTING_CONVERSATION_CREATED", schemaVersion: 1,
      aggregateType: "CONVERSATION", aggregateId: "c",
      payload: { conversationId: "c", listingId: "p", listingType: "PRODUCT" },
    })).toEqual([]);
  });
});
