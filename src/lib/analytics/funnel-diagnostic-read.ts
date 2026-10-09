import { Prisma } from "@prisma/client";
import {
  ANALYTICS_METRIC_PROJECTION_KEY,
  ANALYTICS_METRIC_PROJECTION_VERSION,
} from "@/lib/analytics/projection-contract";
import {
  evaluateUnreleasedFunnelCohort,
  FUNNEL_CONVERSION_WINDOW_MS,
  type FunnelFact,
  type FunnelCandidateResult,
} from "@/lib/analytics/funnel-cohort-semantics";
import { canReadAnalyticsCampus, deriveAnalyticsReadAccess } from "@/lib/analytics/analytics-read-access";
import {
  LIQUIDITY_LISTING_CREATED_EVENT_TYPE,
  LISTING_CONVERSATION_CREATED_EVENT_TYPE,
  LISTING_CONVERSATION_FIRST_REPLY_EVENT_TYPE,
  LISTING_CONVERSATION_ORDER_ATTRIBUTED_EVENT_TYPE,
  type LIQUIDITY_LISTING_TYPES,
} from "@/lib/domain-events/domain-event-registry";
import { prisma } from "@/lib/prisma";
import { loadAuthorizationContext } from "@/lib/rbac/service";

type ListingType = (typeof LIQUIDITY_LISTING_TYPES)[number];

const DAY = 86_400_000;
const MAX_FACTS = 5_000;
const MAX_DIAGNOSTIC_READ_MS = 15_000;
const EVENT_TYPES = [
  LIQUIDITY_LISTING_CREATED_EVENT_TYPE,
  LISTING_CONVERSATION_CREATED_EVENT_TYPE,
  LISTING_CONVERSATION_FIRST_REPLY_EVENT_TYPE,
  LISTING_CONVERSATION_ORDER_ATTRIBUTED_EVENT_TYPE,
] as const;

export type AuthorizedFunnelDiagnostic = Readonly<{
  // Internal QA only; NEVER exposed as a rate, percentile or user-facing KPI.
  status:
    | "DISABLED"
    | "INVALID_WINDOW"
    | "IMMATURE_COHORT"
    | "UNAVAILABLE_QUERY_FAILURE"
    | "UNAVAILABLE_TOO_MANY_FACTS"
    | "UNAVAILABLE_CAPTURE_DISABLED"
    | "UNAVAILABLE_INCOMPLETE_PROJECTION"
    | "UNAVAILABLE_CAPTURE_CONTINUITY_UNPROVEN";
  candidate: FunnelCandidateResult["candidate"];
  eventRows: number | null;
  unprojectedRows: number | null;
  // This snapshot is NOT evidence that every earlier deployment emitted events.
  captureSnapshotReady: boolean;
  captureContinuityProven: false;
}>;

/**
 * R2d-02 internal read authority; NOT a Server Action, route or UI data source.
 * An active analytics.read grant on exactly this campus is mandatory. No campus
 * list, request-supplied coverage flag, rate, or source-specific identity leaves
 * this function.
 *
 * An exact-campus PostgreSQL predicate precedes row transfer. Under ONE
 * RepeatableRead snapshot, cap at MAX_FACTS+1 and count any missing current
 * projection receipts. Refuse partial/truncated input; absent events never
 * imply a true zero. No caller can declare historic capture coverage complete.
 */
export async function loadAuthorizedFunnelDiagnostic(input: {
  actorId: string;
  campusId: string;
  listingType: ListingType;
  periodDays: 7 | 30;
  cohortEnd: Date;
  /** Deterministic clock seam for unit/integration tests, not capture evidence. */
  now?: Date;
}): Promise<AuthorizedFunnelDiagnostic> {
  if (typeof input.actorId !== "string" || !input.actorId ||
      typeof input.campusId !== "string" || !input.campusId) {
    throw new Error("ANALYTICS_SCOPE_INVALID");
  }
  // Fresh auth BEFORE tenant metadata, event counts or any diagnostic DB read.
  const access = deriveAnalyticsReadAccess(await loadAuthorizationContext(input.actorId));
  if (!canReadAnalyticsCampus(access, input.campusId)) {
    throw new Error("ANALYTICS_SCOPE_DENIED");
  }

  const empty = (
    status: AuthorizedFunnelDiagnostic["status"],
    facts: { eventRows?: number; unprojectedRows?: number } = {},
  ): AuthorizedFunnelDiagnostic => ({
    status, candidate: null,
    eventRows: facts.eventRows ?? null,
    unprojectedRows: facts.unprojectedRows ?? null,
    captureSnapshotReady: false,
    captureContinuityProven: false,
  });
  // Separate internal diagnostic opt-in, default OFF even for authorized admins.
  // Missing this switch prevents ALL diagnostic ledger reads.
  if (process.env.ANALYTICS_FUNNEL_DIAGNOSTICS !== "enabled") {
    return empty("DISABLED");
  }
  const now = input.now ?? new Date();
  if (![7, 30].includes(input.periodDays) ||
      !["PRODUCT", "SERVICE", "RENTAL"].includes(input.listingType) ||
      !(input.cohortEnd instanceof Date) || !Number.isFinite(input.cohortEnd.getTime()) ||
      !(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      input.cohortEnd.getTime() > now.getTime()) {
    return empty("INVALID_WINDOW");
  }
  const cohortStart = new Date(input.cohortEnd.getTime() - input.periodDays * DAY);
  const through = new Date(input.cohortEnd.getTime() + FUNNEL_CONVERSION_WINDOW_MS);
  if (through.getTime() > now.getTime()) return empty("IMMATURE_COHORT");

  // A flag snapshot is only a NEGATIVE gate. Even when all enabled, we do
  // not have a persisted per-deployment / worker rollout continuity authority.
  const captureSnapshotReady =
    process.env.ANALYTICS_CONVERSATION_EVENT_EMISSION === "enabled" &&
    process.env.ANALYTICS_FIRST_REPLY_EVENT_EMISSION === "enabled" &&
    process.env.ANALYTICS_ORDER_ATTRIBUTION_EMISSION === "enabled" &&
    typeof process.env.ANALYTICS_ORDER_ATTRIBUTION_SECRET === "string" &&
    Buffer.byteLength(process.env.ANALYTICS_ORDER_ATTRIBUTION_SECRET, "utf8") >= 32;

  // Query never touches cross-campus records or raw messages/users. The source
  // ledger is append-only; receipt count and events use one MVCC snapshot.
  const scope: Prisma.DomainEventWhereInput = {
    campusId: input.campusId,
    eventType: { in: [...EVENT_TYPES] },
    occurredAt: { gte: cohortStart, lte: through },
  };

  let rows: FunnelFact[], unprojectedRows: number;
  try {
    const snapshot = await prisma.$transaction(async tx => {
      const [facts, missingReceipts] = await Promise.all([
        tx.domainEvent.findMany({
          where: scope,
          select: {
            eventType: true, schemaVersion: true, aggregateType: true,
            aggregateId: true, occurrenceKey: true, campusId: true,
            sourceType: true, occurredAt: true, payload: true,
          },
          orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
          take: MAX_FACTS + 1,
        }),
        tx.domainEvent.count({
          where: {
            ...scope,
            sourceType: "DOMAIN_TX",
            projectionReceipts: {
              none: {
                projectionKey: ANALYTICS_METRIC_PROJECTION_KEY,
                projectionVersion: ANALYTICS_METRIC_PROJECTION_VERSION,
              },
            },
          },
        }),
      ]);
      return { rows: facts, unprojectedRows: missingReceipts };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 3_000,
      timeout: MAX_DIAGNOSTIC_READ_MS,
    });
    rows = snapshot.rows;
    unprojectedRows = snapshot.unprojectedRows;
  } catch {
    // Driver errors might contain SQL parameters. Do not log the error.
    return empty("UNAVAILABLE_QUERY_FAILURE");
  }

  if (rows.length > MAX_FACTS) {
    return empty("UNAVAILABLE_TOO_MANY_FACTS", { eventRows: rows.length });
  }

  const provisional = evaluateUnreleasedFunnelCohort({
    campusId: input.campusId,
    listingType: input.listingType,
    cohortStart,
    cohortEnd: input.cohortEnd,
    observedThrough: now,
    facts: rows,
  });
  // Caller-controlled clock/invalid data can never bypass R2d-01 refusal.
  if (!provisional.candidate) return empty("INVALID_WINDOW");

  const status: AuthorizedFunnelDiagnostic["status"] = !captureSnapshotReady
    ? "UNAVAILABLE_CAPTURE_DISABLED"
    : unprojectedRows > 0
      ? "UNAVAILABLE_INCOMPLETE_PROJECTION"
      : "UNAVAILABLE_CAPTURE_CONTINUITY_UNPROVEN";

  return {
    status,
    candidate: provisional.candidate,
    eventRows: rows.length,
    unprojectedRows,
    captureSnapshotReady,
    captureContinuityProven: false,
  };
}
