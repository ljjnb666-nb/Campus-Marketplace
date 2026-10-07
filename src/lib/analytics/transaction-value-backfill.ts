import type { Prisma } from "@prisma/client";

import {
  recordLiquidityTransactionValueRecordedTx,
  type LiquidityTransactionValueType,
} from "@/lib/analytics/liquidity-domain-events";
import { withTransaction } from "@/lib/prisma";

const DEFAULT_BATCH_LIMIT = 10;

type TransactionValueCandidate = {
  transactionId: string;
  transactionType: LiquidityTransactionValueType;
  campusId: string;
  occurredAt: Date;
  bookedValue: unknown;
  occurrenceKey: string;
};

type TransactionValueBackfillDiagnostics = {
  unsupportedServiceRows: number;
  corruptRows: number;
};

export type TransactionValueBackfillStatus =
  | "COMPLETE"
  | "CTV_BACKFILL_PARTIAL";

export type TransactionValueBackfillSummary = {
  scanned: number;
  backfilled: number;
  racedWithExisting: number;
  status: TransactionValueBackfillStatus;
  unsupportedServiceRows: number;
  corruptRows: number;
};

function resolveBatchLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_BATCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("CTV_BACKFILL_BATCH_LIMIT_INVALID");
  }
  return limit;
}

/**
 * Phase 10C-2 canonical CTV backfill.
 *
 * Safe historical authority:
 * - PRODUCT => completed Order.amount
 * - ERRAND  => completed Order.amount
 * - RENTAL  => completed RentalOrder.rentalAmount only
 *
 * SERVICE is deliberately partial/unsupported: ServiceListing.price may be
 * PER_HOUR / PER_SESSION / PER_ORDER / NEGOTIABLE, while historical Order rows
 * do not snapshot pricingUnit or an agreed final total. We report this as
 * CTV_BACKFILL_PARTIAL instead of inventing history.
 *
 * Explicit exclusions: finalAmount, refundable deposit principal,
 * damage/deposit deduction, service/overdue/cancellation fees and
 * payment/settlement state. Historical occurredAt is completedAt only;
 * updatedAt is forbidden.
 *
 * Corrupt rows are excluded from the bounded candidate window and counted
 * separately, so one bad historical record cannot poison every later safe row.
 */
export async function backfillCanonicalTransactionValuesTx(
  tx: Prisma.TransactionClient,
  input: { batchLimit?: number; campusId?: string } = {},
): Promise<TransactionValueBackfillSummary> {
  const batchLimit = resolveBatchLimit(input.batchLimit);
  const campusId = input.campusId ?? null;
  if (campusId !== null && campusId.length === 0) {
    throw new Error("CTV_BACKFILL_CAMPUS_SCOPE_INVALID");
  }

  const rows = await tx.$queryRaw<TransactionValueCandidate[]>`
    WITH candidates AS (
      SELECT
        o.id AS "transactionId",
        'PRODUCT'::text AS "transactionType",
        p."campusId" AS "campusId",
        o."completedAt" AS "occurredAt",
        o.amount AS "bookedValue",
        'LIQUIDITY_TRANSACTION_VALUE_RECORDED:PRODUCT:' || o.id AS "occurrenceKey"
      FROM "Order" o
      JOIN "Product" p ON p.id = o."productId"
      LEFT JOIN "DomainEvent" d
        ON d."occurrenceKey" = 'LIQUIDITY_TRANSACTION_VALUE_RECORDED:PRODUCT:' || o.id
      WHERE o.type = 'PRODUCT'
        AND o.status = 'COMPLETED'
        AND o."completedAt" IS NOT NULL
        AND o."sellerId" = p."sellerId"
        AND o."buyerId" <> p."sellerId"
        AND o.amount >= 0
        AND d.id IS NULL

      UNION ALL
      SELECT
        o.id, 'ERRAND', e."campusId", o."completedAt", o.amount,
        'LIQUIDITY_TRANSACTION_VALUE_RECORDED:ERRAND:' || o.id
      FROM "Order" o
      JOIN "ErrandTask" e ON e.id = o."errandTaskId"
      LEFT JOIN "DomainEvent" d
        ON d."occurrenceKey" = 'LIQUIDITY_TRANSACTION_VALUE_RECORDED:ERRAND:' || o.id
      WHERE o.type = 'ERRAND'
        AND o.status = 'COMPLETED'
        AND o."completedAt" IS NOT NULL
        AND e.status = 'COMPLETED'
        AND e."publisherId" = o."buyerId"
        AND e."accepterId" = o."sellerId"
        AND o."buyerId" <> o."sellerId"
        AND o.amount >= 0
        AND d.id IS NULL

      UNION ALL
      SELECT
        ro.id, 'RENTAL', rl."campusId", ro."completedAt",
        ro."rentalAmount",
        'LIQUIDITY_TRANSACTION_VALUE_RECORDED:RENTAL:' || ro.id
      FROM "RentalOrder" ro
      JOIN "RentalListing" rl ON rl.id = ro."rentalListingId"
      LEFT JOIN "DomainEvent" d
        ON d."occurrenceKey" = 'LIQUIDITY_TRANSACTION_VALUE_RECORDED:RENTAL:' || ro.id
      WHERE ro.status = 'COMPLETED'
        AND ro."completedAt" IS NOT NULL
        AND ro."ownerId" = rl."ownerId"
        AND ro."renterId" <> rl."ownerId"
        AND ro."rentalAmount" >= 0
        AND d.id IS NULL
    )
    SELECT
      "transactionId",
      "transactionType",
      "campusId",
      "occurredAt",
      "bookedValue",
      "occurrenceKey"
    FROM candidates
    WHERE (${campusId}::text IS NULL OR "campusId" = ${campusId})
    ORDER BY "occurredAt" ASC, "transactionType" ASC, "transactionId" ASC
    LIMIT ${batchLimit}
  `;

  // Diagnostics are intentionally outside the candidate LIMIT. Unsupported or
  // corrupt earlier rows therefore remain visible without consuming progress
  // capacity that belongs to safe, repairable history.
  const diagnosticsRows = await tx.$queryRaw<TransactionValueBackfillDiagnostics[]>`
    WITH unsupported_service AS (
      SELECT s."campusId" AS "campusId"
      FROM "Order" o
      LEFT JOIN "ServiceListing" s ON s.id = o."serviceListingId"
      LEFT JOIN "DomainEvent" d
        ON d."occurrenceKey" = 'LIQUIDITY_TRANSACTION_VALUE_RECORDED:SERVICE:' || o.id
      WHERE o.type = 'SERVICE'
        AND o.status = 'COMPLETED'
        AND o."completedAt" IS NOT NULL
        AND d.id IS NULL
    ),
    corrupt AS (
      SELECT p."campusId" AS "campusId"
      FROM "Order" o
      LEFT JOIN "Product" p ON p.id = o."productId"
      LEFT JOIN "DomainEvent" d
        ON d."occurrenceKey" = 'LIQUIDITY_TRANSACTION_VALUE_RECORDED:PRODUCT:' || o.id
      WHERE o.type = 'PRODUCT'
        AND o.status = 'COMPLETED'
        AND o."completedAt" IS NOT NULL
        AND d.id IS NULL
        AND (
          p.id IS NULL
          OR o."sellerId" <> p."sellerId"
          OR o."buyerId" = p."sellerId"
          OR o.amount < 0
        )

      UNION ALL
      SELECT e."campusId"
      FROM "Order" o
      LEFT JOIN "ErrandTask" e ON e.id = o."errandTaskId"
      LEFT JOIN "DomainEvent" d
        ON d."occurrenceKey" = 'LIQUIDITY_TRANSACTION_VALUE_RECORDED:ERRAND:' || o.id
      WHERE o.type = 'ERRAND'
        AND o.status = 'COMPLETED'
        AND o."completedAt" IS NOT NULL
        AND d.id IS NULL
        AND (
          e.id IS NULL
          OR e.status <> 'COMPLETED'
          OR e."publisherId" <> o."buyerId"
          OR e."accepterId" IS DISTINCT FROM o."sellerId"
          OR o."buyerId" = o."sellerId"
          OR o.amount < 0
        )

      UNION ALL
      SELECT rl."campusId"
      FROM "RentalOrder" ro
      LEFT JOIN "RentalListing" rl ON rl.id = ro."rentalListingId"
      LEFT JOIN "DomainEvent" d
        ON d."occurrenceKey" = 'LIQUIDITY_TRANSACTION_VALUE_RECORDED:RENTAL:' || ro.id
      WHERE ro.status = 'COMPLETED'
        AND ro."completedAt" IS NOT NULL
        AND d.id IS NULL
        AND (
          rl.id IS NULL
          OR ro."ownerId" <> rl."ownerId"
          OR ro."renterId" = rl."ownerId"
          OR ro."rentalAmount" < 0
        )
    )
    , unsupported_service_bounded AS (
      SELECT "campusId"
      FROM unsupported_service
      WHERE (${campusId}::text IS NULL OR "campusId" = ${campusId})
      LIMIT ${batchLimit}
    ),
    corrupt_bounded AS (
      SELECT "campusId"
      FROM corrupt
      WHERE (
        ${campusId}::text IS NULL
        OR "campusId" = ${campusId}
      )
      LIMIT ${batchLimit}
    )
    SELECT
      (SELECT COUNT(*)::int FROM unsupported_service_bounded)
        AS "unsupportedServiceRows",
      (SELECT COUNT(*)::int FROM corrupt_bounded)
        AS "corruptRows"
  `;
  const diagnostics = diagnosticsRows[0] ?? {
    unsupportedServiceRows: 0,
    corruptRows: 0,
  };

  let backfilled = 0;
  let racedWithExisting = 0;

  for (const row of rows) {
    const existing = await tx.domainEvent.findUnique({
      where: { occurrenceKey: row.occurrenceKey },
      select: { id: true },
    });
    if (existing) {
      racedWithExisting += 1;
      continue;
    }

    const result = await recordLiquidityTransactionValueRecordedTx(tx, {
      transactionId: row.transactionId,
      transactionType: row.transactionType,
      campusId: row.campusId,
      occurredAt: row.occurredAt,
      bookedValue: String(row.bookedValue),
      sourceType: "BACKFILL_CANONICAL",
      sourceId: row.transactionId,
    });
    backfilled += result.recorded ? 1 : 0;
  }

  // These are bounded observed rows (<= batchLimit), intentionally not global
  // cardinalities. The correctness signal is status=CTV_BACKFILL_PARTIAL; keeping
  // diagnostics bounded prevents a permanent unsupported SERVICE population from
  // turning every worker cycle into an unbounded historical COUNT scan.
  const unsupportedServiceRows = Number(diagnostics.unsupportedServiceRows);
  const corruptRows = Number(diagnostics.corruptRows);
  const status: TransactionValueBackfillStatus =
    unsupportedServiceRows > 0 || corruptRows > 0
      ? "CTV_BACKFILL_PARTIAL"
      : "COMPLETE";

  return {
    scanned: rows.length,
    backfilled,
    racedWithExisting,
    status,
    unsupportedServiceRows,
    corruptRows,
  };
}

export function backfillCanonicalTransactionValues(
  input: { batchLimit?: number; campusId?: string } = {},
): Promise<TransactionValueBackfillSummary> {
  return withTransaction((tx) => backfillCanonicalTransactionValuesTx(tx, input));
}
