import type { Prisma } from "@prisma/client";

import { recordDomainEventTx } from "@/lib/domain-events/domain-event";
import {
  ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_AGGREGATE_TYPE,
  ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_SCHEMA_VERSION,
  ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_TYPE,
} from "@/lib/domain-events/domain-event-registry";
import { withTransaction } from "@/lib/prisma";

const DEFAULT_BATCH_LIMIT = 10;

type CanonicalErrandCompletionRow = {
  orderId: string;
  errandTaskId: string;
  campusId: string;
  completedAt: Date;
};

function resolveBatchLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_BATCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("ANALYTICS_BACKFILL_BATCH_LIMIT_INVALID");
  }
  return limit;
}

/**
 * Explicit canonical backfill: only rows with truthful completedAt, bound
 * Order↔ErrandTask participants, and authoritative task campus are eligible.
 * Never invent occurredAt from updatedAt or migration time.
 */
export async function backfillCanonicalErrandCompletionEventsTx(
  tx: Prisma.TransactionClient,
  input: { batchLimit?: number; campusId?: string } = {},
): Promise<{ scanned: number; backfilled: number; racedWithExisting: number }> {
  const batchLimit = resolveBatchLimit(input.batchLimit);
  const campusId = input.campusId ?? null;
  if (campusId !== null && campusId.length === 0) {
    throw new Error("ANALYTICS_BACKFILL_CAMPUS_SCOPE_INVALID");
  }
    const rows = await tx.$queryRaw<CanonicalErrandCompletionRow[]>`
      SELECT
        o.id AS "orderId",
        t.id AS "errandTaskId",
        t."campusId" AS "campusId",
        o."completedAt" AS "completedAt"
      FROM "Order" o
      JOIN "ErrandTask" t
        ON t.id = o."errandTaskId"
      LEFT JOIN "DomainEvent" d
        ON d."occurrenceKey" = 'ERRAND_ORDER_COMPLETED:' || o.id
      WHERE o.type = 'ERRAND'
        AND o.status = 'COMPLETED'
        AND o."completedAt" IS NOT NULL
        AND o."errandTaskId" IS NOT NULL
        AND t."publisherId" = o."buyerId"
        AND t."accepterId" = o."sellerId"
        AND d.id IS NULL
        AND (${campusId}::text IS NULL OR t."campusId" = ${campusId})
      ORDER BY o."completedAt" ASC, o.id ASC
      LIMIT ${batchLimit}
      FOR UPDATE OF o SKIP LOCKED
    `;

    let backfilled = 0;
    let racedWithExisting = 0;

    for (const row of rows) {
      const occurrenceKey = `ERRAND_ORDER_COMPLETED:${row.orderId}`;
      const existing = await tx.domainEvent.findUnique({
        where: { occurrenceKey },
        select: { id: true },
      });
      if (existing) {
        racedWithExisting += 1;
        continue;
      }

      const result = await recordDomainEventTx(tx, {
        eventType: ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_TYPE,
        schemaVersion: ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_SCHEMA_VERSION,
        aggregateType: ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_AGGREGATE_TYPE,
        aggregateId: row.orderId,
        campusId: row.campusId,
        occurredAt: row.completedAt,
        sourceType: "BACKFILL_CANONICAL",
        sourceId: row.orderId,
        payload: {
          orderId: row.orderId,
          errandTaskId: row.errandTaskId,
        },
      });
      backfilled += result.recorded ? 1 : 0;
    }

  return { scanned: rows.length, backfilled, racedWithExisting };
}

export async function backfillCanonicalErrandCompletionEvents(
  input: { batchLimit?: number; campusId?: string } = {},
): Promise<{ scanned: number; backfilled: number; racedWithExisting: number }> {
  return withTransaction((tx) => backfillCanonicalErrandCompletionEventsTx(tx, input));
}
