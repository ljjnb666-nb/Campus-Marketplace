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
    expect(query).not.toContain("'SERVICE'");
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

  it("P10C2-ARCH-02: live rental CTV uses rentalAmount-only central authority", () => {
    const machine = source("src/lib/rental-order-machine.ts");
    const helper = source("src/lib/analytics/liquidity-domain-events.ts");
    expect(machine).toContain("computeRentalCompletedBookedValue(order)");
    expect(machine).toContain("computeRentalCompletedBookedValue(claim.order)");
    expect(machine).not.toContain("bookedValue: order.finalAmount");
    expect(machine).not.toContain("bookedValue: claim.order.finalAmount");

    const helperBlock = helper.slice(
      helper.indexOf("export function computeRentalCompletedBookedValue"),
      helper.indexOf("export function recordLiquidityListingCreatedTx"),
    );
    expect(helperBlock).toContain("input.rentalAmount");
    expect(helperBlock).not.toContain("serviceFee");
    expect(helperBlock).not.toContain("overdueFee");
    expect(helperBlock).not.toContain("depositDeduction");
    expect(helperBlock).not.toContain("finalAmount");
  });

  it("P10C2-ARCH-02B: rental creation and extension accounting consume authoritative quantity", () => {
    const text = source("src/lib/rental-order-machine.ts");
    expect(text).toContain("endTime,\n      quantity,");
    expect(text).toContain("input.newEndTime,\n    order.quantity,");
    expect(text).toContain("ext.newEndTime,\n    order.quantity,");
  });

  it("P10C2-ARCH-03: PRODUCT/ERRAND use Order.amount while SERVICE is count-only", () => {
    const orderStatus = source("src/lib/order-status-service.ts");
    expect(orderStatus).toContain("bookedValue: order.amount");

    const serviceBlock = orderStatus.slice(
      orderStatus.indexOf('order.type === "SERVICE"'),
      orderStatus.indexOf("const actorRole"),
    );
    expect(serviceBlock).toContain("recordLiquidityTransactionCompletedTx");
    expect(serviceBlock).not.toContain("recordLiquidityTransactionCompletionFactsTx");
    expect(serviceBlock).not.toContain("bookedValue");

    expect(source("src/lib/errand-completion.ts"))
      .toContain("bookedValue: orderScope.amount");

    const registry = source("src/lib/domain-events/domain-event-registry.ts");
    const valueTypes = registry.slice(
      registry.indexOf("LIQUIDITY_TRANSACTION_VALUE_TYPES"),
      registry.indexOf("const boundedId"),
    );
    expect(valueTypes).toContain('"PRODUCT"');
    expect(valueTypes).toContain('"ERRAND"');
    expect(valueTypes).toContain('"RENTAL"');
    expect(valueTypes).not.toContain('"SERVICE"');
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
    expect(migration).toContain("BEGIN;");
    expect(migration).toContain("COMMIT;");
    expect(migration).toContain("PHASE10C2_RENTAL_QUANTITY_REPAIR_ALREADY_APPLIED");
  });

  it("P10C2-ARCH-06: unsupported/corrupt history is explicitly partial, never silently complete", () => {
    const backfill = source("src/lib/analytics/transaction-value-backfill.ts");
    expect(backfill).toContain('"CTV_BACKFILL_PARTIAL"');
    expect(backfill).toContain("unsupportedServiceRows");
    expect(backfill).toContain("corruptRows");
    expect(backfill).toContain("o.amount >= 0");
    expect(backfill).toContain('ro."rentalAmount" >= 0');
    expect(backfill).toContain("unsupported_service_bounded");
    expect(backfill).toContain("corrupt_bounded");

    const worker = source("scripts/ops/async-worker.ts");
    expect(worker).toContain("transactionValueBackfillStatus");
    expect(worker).toContain("transactionValueUnsupportedServiceRows");
    expect(worker).toContain("transactionValueCorruptRows");
  });
});
