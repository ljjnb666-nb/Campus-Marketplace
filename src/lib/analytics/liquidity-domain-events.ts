import { Prisma } from "@prisma/client";

import { recordDomainEventTx } from "@/lib/domain-events/domain-event";
import {
  LIQUIDITY_DEMAND_CREATED_AGGREGATE_TYPE,
  LIQUIDITY_DEMAND_CREATED_EVENT_SCHEMA_VERSION,
  LIQUIDITY_DEMAND_CREATED_EVENT_TYPE,
  LIQUIDITY_LISTING_CREATED_AGGREGATE_TYPE,
  LIQUIDITY_LISTING_CREATED_EVENT_SCHEMA_VERSION,
  LIQUIDITY_LISTING_CREATED_EVENT_TYPE,
  LIQUIDITY_TRANSACTION_COMPLETED_AGGREGATE_TYPE,
  LIQUIDITY_TRANSACTION_COMPLETED_EVENT_SCHEMA_VERSION,
  LIQUIDITY_TRANSACTION_COMPLETED_EVENT_TYPE,
  LIQUIDITY_TRANSACTION_VALUE_RECORDED_AGGREGATE_TYPE,
  LIQUIDITY_TRANSACTION_VALUE_RECORDED_EVENT_SCHEMA_VERSION,
  LIQUIDITY_TRANSACTION_VALUE_RECORDED_EVENT_TYPE,
  type LIQUIDITY_DEMAND_TYPES,
  type LIQUIDITY_LISTING_TYPES,
  type LIQUIDITY_TRANSACTION_TYPES,
} from "@/lib/domain-events/domain-event-registry";

type Source = {
  sourceType?: string;
  sourceId?: string | null;
};

export type LiquidityListingType = (typeof LIQUIDITY_LISTING_TYPES)[number];
export type LiquidityDemandType = (typeof LIQUIDITY_DEMAND_TYPES)[number];
export type LiquidityTransactionType = (typeof LIQUIDITY_TRANSACTION_TYPES)[number];

export function recordLiquidityListingCreatedTx(
  tx: Prisma.TransactionClient,
  input: {
    listingId: string;
    listingType: LiquidityListingType;
    campusId: string;
    occurredAt: Date;
  } & Source,
) {
  return recordDomainEventTx(tx, {
    eventType: LIQUIDITY_LISTING_CREATED_EVENT_TYPE,
    schemaVersion: LIQUIDITY_LISTING_CREATED_EVENT_SCHEMA_VERSION,
    aggregateType: LIQUIDITY_LISTING_CREATED_AGGREGATE_TYPE,
    aggregateId: input.listingId,
    campusId: input.campusId,
    occurredAt: input.occurredAt,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    payload: {
      listingId: input.listingId,
      listingType: input.listingType,
    },
  });
}

export function recordLiquidityDemandCreatedTx(
  tx: Prisma.TransactionClient,
  input: {
    demandId: string;
    demandType: LiquidityDemandType;
    campusId: string;
    occurredAt: Date;
  } & Source,
) {
  return recordDomainEventTx(tx, {
    eventType: LIQUIDITY_DEMAND_CREATED_EVENT_TYPE,
    schemaVersion: LIQUIDITY_DEMAND_CREATED_EVENT_SCHEMA_VERSION,
    aggregateType: LIQUIDITY_DEMAND_CREATED_AGGREGATE_TYPE,
    aggregateId: input.demandId,
    campusId: input.campusId,
    occurredAt: input.occurredAt,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    payload: {
      demandId: input.demandId,
      demandType: input.demandType,
    },
  });
}

export function recordLiquidityTransactionCompletedTx(
  tx: Prisma.TransactionClient,
  input: {
    transactionId: string;
    transactionType: LiquidityTransactionType;
    campusId: string;
    occurredAt: Date;
  } & Source,
) {
  return recordDomainEventTx(tx, {
    eventType: LIQUIDITY_TRANSACTION_COMPLETED_EVENT_TYPE,
    schemaVersion: LIQUIDITY_TRANSACTION_COMPLETED_EVENT_SCHEMA_VERSION,
    aggregateType: LIQUIDITY_TRANSACTION_COMPLETED_AGGREGATE_TYPE,
    aggregateId: input.transactionId,
    campusId: input.campusId,
    occurredAt: input.occurredAt,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    payload: {
      transactionId: input.transactionId,
      transactionType: input.transactionType,
    },
  });
}

export function canonicalizeBookedValue(
  value: Prisma.Decimal | string | number,
): string {
  const decimal = new Prisma.Decimal(value);
  if (
    !decimal.isFinite() ||
    decimal.isNegative() ||
    decimal.decimalPlaces() > 2 ||
    decimal.greaterThan("99999999.99")
  ) {
    throw new Error("LIQUIDITY_BOOKED_VALUE_INVALID");
  }
  return decimal.toFixed(2);
}

/**
 * Phase 10C-2 CTV fact.
 *
 * bookedValue is the platform-recorded core value of a COMPLETED transaction:
 * - PRODUCT / SERVICE / ERRAND: Order.amount
 * - RENTAL: RentalOrder.rentalAmount
 *
 * It is NOT settlement, cash collected, platform revenue, GMV, refundable
 * deposit, deposit deduction, service fee, overdue fee or cancellation fee.
 */
export function recordLiquidityTransactionValueRecordedTx(
  tx: Prisma.TransactionClient,
  input: {
    transactionId: string;
    transactionType: LiquidityTransactionType;
    campusId: string;
    occurredAt: Date;
    bookedValue: Prisma.Decimal | string | number;
  } & Source,
) {
  return recordDomainEventTx(tx, {
    eventType: LIQUIDITY_TRANSACTION_VALUE_RECORDED_EVENT_TYPE,
    schemaVersion: LIQUIDITY_TRANSACTION_VALUE_RECORDED_EVENT_SCHEMA_VERSION,
    aggregateType: LIQUIDITY_TRANSACTION_VALUE_RECORDED_AGGREGATE_TYPE,
    aggregateId: input.transactionId,
    campusId: input.campusId,
    occurredAt: input.occurredAt,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    payload: {
      transactionId: input.transactionId,
      transactionType: input.transactionType,
      bookedValue: canonicalizeBookedValue(input.bookedValue),
    },
  });
}

export async function recordLiquidityTransactionCompletionFactsTx(
  tx: Prisma.TransactionClient,
  input: {
    transactionId: string;
    transactionType: LiquidityTransactionType;
    campusId: string;
    occurredAt: Date;
    bookedValue: Prisma.Decimal | string | number;
  } & Source,
) {
  const completion = await recordLiquidityTransactionCompletedTx(tx, input);
  const value = await recordLiquidityTransactionValueRecordedTx(tx, input);
  return { completion, value };
}
