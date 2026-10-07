import type { Prisma } from "@prisma/client";

import { enqueueAsyncJobTx } from "@/lib/async/job-repository";
import {
  ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_KIND,
  ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_SCHEMA_VERSION,
} from "@/lib/async/job-types";
import {
  ANALYTICS_METRIC_PROJECTION_KEY,
  ANALYTICS_METRIC_PROJECTION_VERSION,
  buildLiveDomainEventProjectionDedupeKey,
} from "@/lib/analytics/projection-contract";
import { withTransaction } from "@/lib/prisma";

const DEFAULT_BATCH_LIMIT = 10;

type ProjectionCandidate = {
  eventId: string;
};

type ProjectionGapRow = {
  jobStatus: string;
};

export type ProjectionScheduleSummary = {
  scanned: number;
  enqueued: number;
  inFlight: number;
  deadLettered: number;
  structuralGaps: number;
};

function resolveBatchLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_BATCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("ANALYTICS_PROJECTION_BATCH_LIMIT_INVALID");
  }
  return limit;
}

/**
 * Bounded convergence producer：
 * - current-version receipt 缺失 + live projection job 不存在 → enqueue；
 * - PENDING/RETRY/RUNNING → 已在途，不重复；
 * - DEAD_LETTER → 显式暴露，不自动无限 requeue；
 * - COMPLETED(+tombstoned) 但 receipt 缺失 → structural gap。
 * projectionVersion 提升后旧 receipts 不匹配，历史 DomainEvent 会按 current
 * version bounded replay；没有 watermark / id > cursor correctness。
 */
export async function scheduleUnprojectedDomainEventJobsTx(
  tx: Prisma.TransactionClient,
  input: { batchLimit?: number; campusId?: string } = {},
): Promise<ProjectionScheduleSummary> {
  const batchLimit = resolveBatchLimit(input.batchLimit);
  const campusId = input.campusId ?? null;
  if (campusId !== null && campusId.length === 0) {
    throw new Error("ANALYTICS_PROJECTION_CAMPUS_SCOPE_INVALID");
  }
  const dedupePrefix = [
    ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_KIND,
    `schema${ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_SCHEMA_VERSION}`,
    `projection${ANALYTICS_METRIC_PROJECTION_VERSION}`,
    "",
  ].join(":");

  // Scheduling candidates deliberately exclude every existing current-version
    // job. A bad/terminal earlier row can therefore never consume LIMIT and starve
    // later events that are actually repairable.
    const candidates = await tx.$queryRaw<ProjectionCandidate[]>`
      SELECT d.id AS "eventId"
      FROM "DomainEvent" d
      LEFT JOIN "ProjectionReceipt" r
        ON r."eventId" = d.id
       AND r."projectionKey" = ${ANALYTICS_METRIC_PROJECTION_KEY}
       AND r."projectionVersion" = ${ANALYTICS_METRIC_PROJECTION_VERSION}
      LEFT JOIN "AsyncJob" j
        ON j."dedupeKey" = ${dedupePrefix} || d.id
      WHERE r.id IS NULL
        AND j.id IS NULL
        AND (${campusId}::text IS NULL OR d."campusId" = ${campusId})
      ORDER BY d."recordedAt" ASC, d.id ASC
      LIMIT ${batchLimit}
      FOR UPDATE OF d SKIP LOCKED
    `;

    let enqueued = 0;
    for (const candidate of candidates) {
      const result = await enqueueAsyncJobTx(tx, {
        kind: ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_KIND,
        schemaVersion: ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_SCHEMA_VERSION,
        dedupeKey: buildLiveDomainEventProjectionDedupeKey(candidate.eventId),
        payload: { eventId: candidate.eventId },
        runAt: new Date(),
      });
      enqueued += result.recorded ? 1 : 0;
    }

    // Observation is intentionally separate from scheduling. LIMIT here only
    // bounds diagnostics; it cannot block replay of later events.
    const gaps = await tx.$queryRaw<ProjectionGapRow[]>`
      SELECT j.status::text AS "jobStatus"
      FROM "DomainEvent" d
      JOIN "AsyncJob" j
        ON j."dedupeKey" = ${dedupePrefix} || d.id
      LEFT JOIN "ProjectionReceipt" r
        ON r."eventId" = d.id
       AND r."projectionKey" = ${ANALYTICS_METRIC_PROJECTION_KEY}
       AND r."projectionVersion" = ${ANALYTICS_METRIC_PROJECTION_VERSION}
      WHERE r.id IS NULL
        AND (${campusId}::text IS NULL OR d."campusId" = ${campusId})
      ORDER BY d."recordedAt" ASC, d.id ASC
      LIMIT ${batchLimit}
    `;

  return {
    scanned: candidates.length,
    enqueued,
    inFlight: gaps.filter(
        (row) =>
          row.jobStatus === "PENDING" ||
          row.jobStatus === "RETRY" ||
          row.jobStatus === "RUNNING",
      ).length,
    deadLettered: gaps.filter((row) => row.jobStatus === "DEAD_LETTER").length,
    structuralGaps: gaps.filter(
      (row) =>
        row.jobStatus !== "PENDING" &&
        row.jobStatus !== "RETRY" &&
        row.jobStatus !== "RUNNING" &&
        row.jobStatus !== "DEAD_LETTER",
    ).length,
  };
}

export async function scheduleUnprojectedDomainEventJobs(
  input: { batchLimit?: number; campusId?: string } = {},
): Promise<ProjectionScheduleSummary> {
  return withTransaction((tx) => scheduleUnprojectedDomainEventJobsTx(tx, input));
}
