import type { Prisma } from "@prisma/client";

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
