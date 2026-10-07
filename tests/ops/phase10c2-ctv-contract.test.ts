import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function source(file: string) {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

describe("Phase 10C-2 CTV authority guards", () => {
  it("P10C2-ARCH-01: backfill uses canonical completed booked-value fields only", () => {
    const text = source("src/lib/analytics/transaction-value-backfill.ts");
    const query = text.slice(
      text.indexOf("const rows ="),
      text.indexOf("let backfilled"),
    );

    expect(query).toContain('o.amount AS "bookedValue"');
    expect(query).toContain('ro."rentalAmount"');
    expect(query).toContain('o."completedAt"');
    expect(query).toContain('ro."completedAt"');

    for (const forbidden of [
      '"finalAmount"',
      '"depositAmount"',
      '"depositDeduction"',
      '"serviceFee"',
      '"overdueFee"',
      '"cancellationFee"',
      '"updatedAt"',
    ]) {
      expect(query).not.toContain(forbidden);
    }
  });

  it("P10C2-ARCH-02: live rental CTV uses one central non-refundable formula", () => {
    const text = source("src/lib/rental-order-machine.ts");
    expect(text).toContain("computeRentalCompletedBookedValue(order)");
    expect(text).toContain("computeRentalCompletedBookedValue({");
    expect(text).not.toContain("depositDeduction: input.agreed");
    expect(text).not.toContain("bookedValue: order.finalAmount");
    expect(text).not.toContain("bookedValue: claim.order.finalAmount");
  });

  it("P10C2-ARCH-02B: rental creation and extension accounting consume authoritative quantity", () => {
    const text = source("src/lib/rental-order-machine.ts");
    expect(text).toContain("endTime,\n      quantity,");
    expect(text).toContain("input.newEndTime,\n    order.quantity,");
    expect(text).toContain("ext.newEndTime,\n    order.quantity,");
  });

  it("P10C2-ARCH-03: ordinary/errand completion uses canonical Order.amount", () => {
    expect(source("src/lib/order-status-service.ts"))
      .toContain("bookedValue: order.amount");
    expect(source("src/lib/errand-completion.ts"))
      .toContain("bookedValue: orderScope.amount");
  });

  it("P10C2-ARCH-04: CTV is explicit and GMV remains absent as a metric key", () => {
    const registry = source("src/lib/analytics/metric-registry.ts");
    expect(registry).toContain(
      'COMPLETED_TRANSACTION_VALUE_METRIC_KEY = "COMPLETED_TRANSACTION_VALUE"',
    );
    expect(registry).not.toContain('metricKey: "GMV"');
  });

  it("P10C2-ARCH-05: quantity repair migration corrects legacy value and installs DB safety belt", () => {
    const migration = source(
      "prisma/migrations/20261007140000_phase10c2_rental_quantity_accounting/migration.sql",
    );
    expect(migration).toContain('"rentalAmount" = "rentalAmount" * quantity');
    expect(migration).toContain(
      '"finalAmount" = "finalAmount" + ("rentalAmount" * (quantity - 1))',
    );
    expect(migration).toContain('CHECK (quantity >= 1)');
    expect(migration).toContain("PHASE10C2_RENTAL_VALUE_REPAIR_OVERFLOW");
  });
});
