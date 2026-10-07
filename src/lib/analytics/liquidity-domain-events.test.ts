import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  canonicalizeBookedValue,
} from "@/lib/analytics/liquidity-domain-events";
import { validateDomainEventIntent } from "@/lib/domain-events/domain-event-registry";

describe("Phase 10C liquidity DomainEvent contracts", () => {
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

  it("P10C2-EVENT-01: CTV value fact is strict, typed and independently deduped", () => {
    expect(validateDomainEventIntent(
      "LIQUIDITY_TRANSACTION_VALUE_RECORDED",
      1,
      "TRANSACTION",
      "tx-1",
      {
        transactionId: "tx-1",
        transactionType: "RENTAL",
        bookedValue: "15.00",
      },
    )).toEqual({
      ok: true,
      payload: {
        transactionId: "tx-1",
        transactionType: "RENTAL",
        bookedValue: "15.00",
      },
      occurrenceKey: "LIQUIDITY_TRANSACTION_VALUE_RECORDED:RENTAL:tx-1",
    });

    expect(validateDomainEventIntent(
      "LIQUIDITY_TRANSACTION_VALUE_RECORDED",
      1,
      "TRANSACTION",
      "tx-1",
      {
        transactionId: "tx-1",
        transactionType: "RENTAL",
        bookedValue: "15.001",
      },
    )).toEqual({ ok: false, reason: "PAYLOAD_INVALID" });
  });

  it("P10C2-EVENT-02: booked value canonicalization never rounds or accepts invalid money", () => {
    expect(canonicalizeBookedValue("0")).toBe("0.00");
    expect(canonicalizeBookedValue("15")).toBe("15.00");
    expect(canonicalizeBookedValue(new Prisma.Decimal("12.30"))).toBe("12.30");
    expect(() => canonicalizeBookedValue("-0.01")).toThrow("LIQUIDITY_BOOKED_VALUE_INVALID");
    expect(() => canonicalizeBookedValue("1.001")).toThrow("LIQUIDITY_BOOKED_VALUE_INVALID");
    expect(() => canonicalizeBookedValue("100000000.00")).toThrow(
      "LIQUIDITY_BOOKED_VALUE_INVALID",
    );
  });
});
