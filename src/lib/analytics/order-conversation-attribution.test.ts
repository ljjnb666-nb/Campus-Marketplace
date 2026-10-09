import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateDomainEventIntent } from "@/lib/domain-events/domain-event-registry";
import { resolveMetricContributions } from "@/lib/analytics/metric-registry";
import {
  mintOrderOriginToken, orderAttributionEnabled,
  recordAttributedOrderIfEligibleTx, verifyOrderOriginToken,
} from "@/lib/analytics/order-conversation-attribution";

const t = new Date("2026-10-09T03:00:00.000Z");
const input = {
  actorId: "buyer1", conversationId: "conv1",
  listingId: "item1", listingType: "PRODUCT" as const, now: t,
};
beforeEach(() => {
  vi.stubEnv("ANALYTICS_CONVERSATION_EVENT_EMISSION", "enabled");
  vi.stubEnv("ANALYTICS_ORDER_ATTRIBUTION_EMISSION", "enabled");
  vi.stubEnv("ANALYTICS_ORDER_ATTRIBUTION_SECRET", "this-is-a-test-only-32-byte-signing-key!");
});
afterEach(() => vi.unstubAllEnvs());

describe("10K-R2c-02A signed order provenance contract", () => {
  it("mints actor-bound, 20-minute, privacy-minimal tokens", () => {
    const token = mintOrderOriginToken(input);
    expect(token).toBeTruthy();
    const tokenText = Buffer.from(token!.split(".")[0]!, "base64url").toString("utf8");
    expect(tokenText).not.toMatch(/buyer1|password|message|note|email/);
    expect(verifyOrderOriginToken({
      token, actorId: "buyer1", asOf: new Date(t.getTime() + 20 * 60_000),
    })).toEqual({
      version: 1, conversationId: "conv1",
      listingId: "item1", listingType: "PRODUCT", issuedAtMs: t.getTime(),
    });
    expect(verifyOrderOriginToken({ token, actorId: "seller1", asOf: t })).toBeNull();
    expect(verifyOrderOriginToken({
      token, actorId: "buyer1", asOf: new Date(t.getTime() + 20 * 60_000 + 1),
    })).toBeNull();
    expect(verifyOrderOriginToken({
      token, actorId: "buyer1", asOf: new Date(t.getTime() - 1),
    })).toBeNull();
    expect(verifyOrderOriginToken({
      token: (token![0] === "A" ? "B" : "A") + token!.slice(1), actorId: "buyer1", asOf: t,
    })).toBeNull();
  });

  it("default off and a weak/missing signing key NEVER issue or accept attribution", async () => {
    const token = mintOrderOriginToken(input);
    vi.stubEnv("ANALYTICS_ORDER_ATTRIBUTION_EMISSION", "");
    expect(orderAttributionEnabled()).toBe(false);
    expect(mintOrderOriginToken(input)).toBeNull();
    expect(verifyOrderOriginToken({ token, actorId: "buyer1", asOf: t })).toBeNull();
    const tx = { order: { findUnique: vi.fn() } } as never;
    expect(await recordAttributedOrderIfEligibleTx(tx, {
      orderId: "order1", orderType: "PRODUCT", actorUserId: "buyer1",
      sourceToken: token,
    })).toBe("DISABLED");
    vi.stubEnv("ANALYTICS_ORDER_ATTRIBUTION_EMISSION", "enabled");
    vi.stubEnv("ANALYTICS_ORDER_ATTRIBUTION_SECRET", "short");
    expect(orderAttributionEnabled()).toBe(false);
  });

  it("invalid token does not fabricate events or leak order details", async () => {
    const tx = { order: { findUnique: vi.fn().mockResolvedValue(null) } } as never;
    expect(await recordAttributedOrderIfEligibleTx(tx, {
      orderId: "order1", orderType: "PRODUCT", actorUserId: "buyer1",
      sourceToken: "malformed",
    })).toBe("INELIGIBLE");
  });

  it("strict source event identity, no actor/price/PII and no metric contribution", () => {
    const event = {
      conversationId: "conv1", orderId: "order1",
      listingId: "item1", listingType: "PRODUCT",
    };
    expect(validateDomainEventIntent(
      "LISTING_CONVERSATION_ORDER_ATTRIBUTED", 1, "ORDER_ATTRIBUTION", "order1", event,
    )).toEqual({
      ok: true, payload: event,
      occurrenceKey: "LISTING_CONVERSATION_ORDER_ATTRIBUTED:PRODUCT:order1",
    });
    for(const bad of [
      { ...event, actorUserId: "buyer1" },
      { ...event, messageText: "secret" },
      { ...event, price: 10 },
      { ...event, listingType: "ERRAND" },
    ]) {
      expect(validateDomainEventIntent(
        "LISTING_CONVERSATION_ORDER_ATTRIBUTED", 1, "ORDER_ATTRIBUTION", "order1", bad,
      )).toMatchObject({ ok: false, reason: "PAYLOAD_INVALID" });
    }
    expect(validateDomainEventIntent(
      "LISTING_CONVERSATION_ORDER_ATTRIBUTED", 1, "ORDER_ATTRIBUTION", "other", event,
    )).toMatchObject({ ok: false, reason: "AGGREGATE_ID_MISMATCH" });
    expect(resolveMetricContributions({
      eventType: "LISTING_CONVERSATION_ORDER_ATTRIBUTED", schemaVersion: 1,
      aggregateType: "ORDER_ATTRIBUTION", aggregateId: "order1", payload: event,
    })).toEqual([]);
  });
});
