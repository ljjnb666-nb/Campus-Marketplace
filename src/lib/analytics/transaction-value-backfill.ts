import type { Prisma } from "@prisma/client";

import {
  recordLiquidityTransactionValueRecordedTx,
  type LiquidityTransactionType,
} from "@/lib/analytics/liquidity-domain-events";
import { withTransaction } from "@/lib/prisma";

const DEFAULT_BATCH_LIMIT = 10;

type TransactionValueCandidate = {
  transactionId: string;
  transactionType: LiquidityTransactionType;
  campusId: string;
  occurredAt: Date;
  bookedValue: unknown;
  occurrenceKey: string;
};

export type TransactionValueBackfillSummary = {
  scanned: number;
  backfilled: number;
  racedWithExisting: number;
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
 * Authority:
 * - PRODUCT / SERVICE / ERRAND => completed Order.amount
 * - RENTAL => completed RentalOrder.rentalAmount only
 *
 * Explicit exclusions: finalAmount, refundable deposit principal,
 * damage/deposit deduction, service/overdue/cancellation fees and
 * payment/settlement state.
 * Historical occurredAt is completedAt only; updatedAt is forbidden.
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
        AND d.id IS NULL

      UNION ALL
      SELECT
        o.id, 'SERVICE', s."campusId", o."completedAt", o.amount,
        'LIQUIDITY_TRANSACTION_VALUE_RECORDED:SERVICE:' || o.id
      FROM "Order" o
      JOIN "ServiceListing" s ON s.id = o."serviceListingId"
      LEFT JOIN "DomainEvent" d
        ON d."occurrenceKey" = 'LIQUIDITY_TRANSACTION_VALUE_RECORDED:SERVICE:' || o.id
      WHERE o.type = 'SERVICE'
        AND o.status = 'COMPLETED'
        AND o."completedAt" IS NOT NULL
        AND o."sellerId" = s."providerId"
        AND o."buyerId" <> s."providerId"
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

  return { scanned: rows.length, backfilled, racedWithExisting };
}

export function backfillCanonicalTransactionValues(
  input: { batchLimit?: number; campusId?: string } = {},
): Promise<TransactionValueBackfillSummary> {
  return withTransaction((tx) => backfillCanonicalTransactionValuesTx(tx, input));
}
