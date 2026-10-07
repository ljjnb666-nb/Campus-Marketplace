import { describe, expect, it } from "vitest";
import { validateDomainEventIntent } from "@/lib/domain-events/domain-event-registry";

describe("Phase 10C-1 liquidity DomainEvent contracts", () => {
  it("P10C1-EVENT-01: subtype participates in semantic occurrence identity", () => {
    expect(validateDomainEventIntent(
      "LIQUIDITY_LISTING_CREATED", 1, "LISTING", "listing-1",
      { listingId: "listing-1", listingType: "PRODUCT" },
    )).toMatchObject({
      ok: true,
      occurrenceKey: "LIQUIDITY_LISTING_CREATED:PRODUCT:listing-1",
    });
    expect(validateDomainEventIntent(
      "LIQUIDITY_DEMAND_CREATED", 1, "DEMAND", "demand-1",
      { demandId: "demand-1", demandType: "ERRAND_TASK" },
    )).toMatchObject({
      ok: true,
      occurrenceKey: "LIQUIDITY_DEMAND_CREATED:ERRAND_TASK:demand-1",
    });
    expect(validateDomainEventIntent(
      "LIQUIDITY_TRANSACTION_COMPLETED", 1, "TRANSACTION", "tx-1",
      { transactionId: "tx-1", transactionType: "RENTAL" },
    )).toMatchObject({
      ok: true,
      occurrenceKey: "LIQUIDITY_TRANSACTION_COMPLETED:RENTAL:tx-1",
    });
  });

  it("P10C1-EVENT-02: unknown fields and aggregate mismatch fail closed", () => {
    expect(validateDomainEventIntent(
      "LIQUIDITY_DEMAND_CREATED", 1, "DEMAND", "d1",
      { demandId: "d1", demandType: "PRODUCT_ORDER", extra: "forbidden" },
    )).toEqual({ ok: false, reason: "PAYLOAD_INVALID" });
    expect(validateDomainEventIntent(
      "LIQUIDITY_TRANSACTION_COMPLETED", 1, "TRANSACTION", "other",
      { transactionId: "tx-1", transactionType: "SERVICE" },
    )).toEqual({ ok: false, reason: "AGGREGATE_ID_MISMATCH" });
  });
});
