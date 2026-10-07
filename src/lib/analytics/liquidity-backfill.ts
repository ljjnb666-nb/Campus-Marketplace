import type { Prisma } from "@prisma/client";

import {
  recordLiquidityDemandCreatedTx,
  recordLiquidityListingCreatedTx,
  recordLiquidityTransactionCompletedTx,
  type LiquidityDemandType,
  type LiquidityListingType,
  type LiquidityTransactionType,
} from "@/lib/analytics/liquidity-domain-events";
import { withTransaction } from "@/lib/prisma";

const DEFAULT_BATCH_LIMIT = 10;

type LiquidityFactKind = "LISTING" | "DEMAND" | "COMPLETION";

type LiquidityBackfillCandidate = {
  factKind: LiquidityFactKind;
  entityId: string;
  subtype: string;
  campusId: string;
  occurredAt: Date;
  occurrenceKey: string;
};

export type LiquidityBackfillSummary = {
  scanned: number;
  backfilled: number;
  racedWithExisting: number;
};

function resolveBatchLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_BATCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("LIQUIDITY_BACKFILL_BATCH_LIMIT_INVALID");
  }
  return limit;
}

/**
 * Phase 10C-1 canonical liquidity fact backfill.
 *
 * Historical occurrence time is accepted ONLY from canonical createdAt/completedAt.
 * Soft-delete/current exposure is intentionally irrelevant for historical facts:
 * a listing that was later deleted was still created; a completed transaction stays
 * completed history. updatedAt is never used to manufacture event time.
 */
export async function backfillCanonicalLiquidityFactsTx(
  tx: Prisma.TransactionClient,
  input: { batchLimit?: number; campusId?: string } = {},
): Promise<LiquidityBackfillSummary> {
  const batchLimit = resolveBatchLimit(input.batchLimit);
  const campusId = input.campusId ?? null;
  if (campusId !== null && campusId.length === 0) {
    throw new Error("LIQUIDITY_BACKFILL_CAMPUS_SCOPE_INVALID");
  }

  const rows = await tx.$queryRaw<LiquidityBackfillCandidate[]>`
    WITH candidates AS (
      SELECT
        'LISTING'::text AS "factKind",
        p.id AS "entityId",
        'PRODUCT'::text AS subtype,
        p."campusId" AS "campusId",
        p."createdAt" AS "occurredAt",
        'LIQUIDITY_LISTING_CREATED:PRODUCT:' || p.id AS "occurrenceKey"
      FROM "Product" p
      LEFT JOIN "DomainEvent" d
        ON d."occurrenceKey" = 'LIQUIDITY_LISTING_CREATED:PRODUCT:' || p.id
      WHERE d.id IS NULL

      UNION ALL
      SELECT 'LISTING', s.id, 'SERVICE', s."campusId", s."createdAt",
        'LIQUIDITY_LISTING_CREATED:SERVICE:' || s.id
      FROM "ServiceListing" s
      LEFT JOIN "DomainEvent" d
        ON d."occurrenceKey" = 'LIQUIDITY_LISTING_CREATED:SERVICE:' || s.id
      WHERE d.id IS NULL

      UNION ALL
      SELECT 'LISTING', r.id, 'RENTAL', r."campusId", r."createdAt",
        'LIQUIDITY_LISTING_CREATED:RENTAL:' || r.id
      FROM "RentalListing" r
      LEFT JOIN "DomainEvent" d
        ON d."occurrenceKey" = 'LIQUIDITY_LISTING_CREATED:RENTAL:' || r.id
      WHERE d.id IS NULL

      UNION ALL
      SELECT 'DEMAND', e.id, 'ERRAND_TASK', e."campusId", e."createdAt",
        'LIQUIDITY_DEMAND_CREATED:ERRAND_TASK:' || e.id
      FROM "ErrandTask" e
      LEFT JOIN "DomainEvent" d
        ON d."occurrenceKey" = 'LIQUIDITY_DEMAND_CREATED:ERRAND_TASK:' || e.id
      WHERE d.id IS NULL

      UNION ALL
      SELECT 'DEMAND', o.id, 'PRODUCT_ORDER', p."campusId", o."createdAt",
        'LIQUIDITY_DEMAND_CREATED:PRODUCT_ORDER:' || o.id
      FROM "Order" o
      JOIN "Product" p ON p.id = o."productId"
      LEFT JOIN "DomainEvent" d
        ON d."occurrenceKey" = 'LIQUIDITY_DEMAND_CREATED:PRODUCT_ORDER:' || o.id
      WHERE o.type = 'PRODUCT' AND d.id IS NULL

      UNION ALL
      SELECT 'DEMAND', o.id, 'SERVICE_ORDER', s."campusId", o."createdAt",
        'LIQUIDITY_DEMAND_CREATED:SERVICE_ORDER:' || o.id
      FROM "Order" o
      JOIN "ServiceListing" s ON s.id = o."serviceListingId"
      LEFT JOIN "DomainEvent" d
        ON d."occurrenceKey" = 'LIQUIDITY_DEMAND_CREATED:SERVICE_ORDER:' || o.id
      WHERE o.type = 'SERVICE' AND d.id IS NULL

      UNION ALL
      SELECT 'DEMAND', ro.id, 'RENTAL_ORDER', rl."campusId", ro."createdAt",
        'LIQUIDITY_DEMAND_CREATED:RENTAL_ORDER:' || ro.id
      FROM "RentalOrder" ro
      JOIN "RentalListing" rl ON rl.id = ro."rentalListingId"
      LEFT JOIN "DomainEvent" d
        ON d."occurrenceKey" = 'LIQUIDITY_DEMAND_CREATED:RENTAL_ORDER:' || ro.id
      WHERE d.id IS NULL

      UNION ALL
      SELECT 'COMPLETION', o.id, 'PRODUCT', p."campusId", o."completedAt",
        'LIQUIDITY_TRANSACTION_COMPLETED:PRODUCT:' || o.id
      FROM "Order" o
      JOIN "Product" p ON p.id = o."productId"
      LEFT JOIN "DomainEvent" d
        ON d."occurrenceKey" = 'LIQUIDITY_TRANSACTION_COMPLETED:PRODUCT:' || o.id
      WHERE o.type = 'PRODUCT'
        AND o.status = 'COMPLETED'
        AND o."completedAt" IS NOT NULL
        AND d.id IS NULL

      UNION ALL
      SELECT 'COMPLETION', o.id, 'SERVICE', s."campusId", o."completedAt",
        'LIQUIDITY_TRANSACTION_COMPLETED:SERVICE:' || o.id
      FROM "Order" o
      JOIN "ServiceListing" s ON s.id = o."serviceListingId"
      LEFT JOIN "DomainEvent" d
        ON d."occurrenceKey" = 'LIQUIDITY_TRANSACTION_COMPLETED:SERVICE:' || o.id
      WHERE o.type = 'SERVICE'
        AND o.status = 'COMPLETED'
        AND o."completedAt" IS NOT NULL
        AND d.id IS NULL

      UNION ALL
      SELECT 'COMPLETION', o.id, 'ERRAND', e."campusId", o."completedAt",
        'LIQUIDITY_TRANSACTION_COMPLETED:ERRAND:' || o.id
      FROM "Order" o
      JOIN "ErrandTask" e ON e.id = o."errandTaskId"
      LEFT JOIN "DomainEvent" d
        ON d."occurrenceKey" = 'LIQUIDITY_TRANSACTION_COMPLETED:ERRAND:' || o.id
      WHERE o.type = 'ERRAND'
        AND o.status = 'COMPLETED'
        AND o."completedAt" IS NOT NULL
        AND e.status = 'COMPLETED'
        AND e."publisherId" = o."buyerId"
        AND e."accepterId" = o."sellerId"
        AND d.id IS NULL

      UNION ALL
      SELECT 'COMPLETION', ro.id, 'RENTAL', rl."campusId", ro."completedAt",
        'LIQUIDITY_TRANSACTION_COMPLETED:RENTAL:' || ro.id
      FROM "RentalOrder" ro
      JOIN "RentalListing" rl ON rl.id = ro."rentalListingId"
      LEFT JOIN "DomainEvent" d
        ON d."occurrenceKey" = 'LIQUIDITY_TRANSACTION_COMPLETED:RENTAL:' || ro.id
      WHERE ro.status = 'COMPLETED'
        AND ro."completedAt" IS NOT NULL
        AND d.id IS NULL
    )
    SELECT "factKind", "entityId", subtype, "campusId", "occurredAt", "occurrenceKey"
    FROM candidates
    WHERE (${campusId}::text IS NULL OR "campusId" = ${campusId})
    ORDER BY "occurredAt" ASC, "factKind" ASC, subtype ASC, "entityId" ASC
    LIMIT ${batchLimit}
  `;

  let backfilled = 0;
  let racedWithExisting = 0;

  for (const row of rows) {
    // Fresh statement snapshot closes rolling-deploy/concurrent-backfill race.
    // If a live writer committed the fact after the candidate query, skip it and
    // let the projection scheduler handle any missing current-version intent.
    const existing = await tx.domainEvent.findUnique({
      where: { occurrenceKey: row.occurrenceKey },
      select: { id: true },
    });
    if (existing) {
      racedWithExisting += 1;
      continue;
    }

    const source = {
      sourceType: "BACKFILL_CANONICAL",
      sourceId: row.entityId,
    } as const;

    let result: { recorded: boolean };
    if (row.factKind === "LISTING") {
      result = await recordLiquidityListingCreatedTx(tx, {
        listingId: row.entityId,
        listingType: row.subtype as LiquidityListingType,
        campusId: row.campusId,
        occurredAt: row.occurredAt,
        ...source,
      });
    } else if (row.factKind === "DEMAND") {
      result = await recordLiquidityDemandCreatedTx(tx, {
        demandId: row.entityId,
        demandType: row.subtype as LiquidityDemandType,
        campusId: row.campusId,
        occurredAt: row.occurredAt,
        ...source,
      });
    } else {
      result = await recordLiquidityTransactionCompletedTx(tx, {
        transactionId: row.entityId,
        transactionType: row.subtype as LiquidityTransactionType,
        campusId: row.campusId,
        occurredAt: row.occurredAt,
        ...source,
      });
    }
    backfilled += result.recorded ? 1 : 0;
  }

  return { scanned: rows.length, backfilled, racedWithExisting };
}

export function backfillCanonicalLiquidityFacts(
  input: { batchLimit?: number; campusId?: string } = {},
): Promise<LiquidityBackfillSummary> {
  return withTransaction((tx) => backfillCanonicalLiquidityFactsTx(tx, input));
}
