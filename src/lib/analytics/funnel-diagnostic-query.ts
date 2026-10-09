import {
  LIQUIDITY_LISTING_CREATED_EVENT_TYPE,
  LISTING_CONVERSATION_CREATED_EVENT_TYPE,
  LISTING_CONVERSATION_FIRST_REPLY_EVENT_TYPE,
  LISTING_CONVERSATION_ORDER_ATTRIBUTED_EVENT_TYPE,
  LIQUIDITY_LISTING_TYPES,
} from "@/lib/domain-events/domain-event-registry";
import {
  evaluateUnreleasedFunnelCohort, FUNNEL_CONVERSION_WINDOW_MS,
  type FunnelCandidateResult,
} from "@/lib/analytics/funnel-cohort-semantics";
import {
  ANALYTICS_METRIC_PROJECTION_KEY, ANALYTICS_METRIC_PROJECTION_VERSION,
  buildLiveDomainEventProjectionDedupeKey,
} from "@/lib/analytics/projection-contract";
import { canReadAnalyticsCampus, deriveAnalyticsReadAccess } from "@/lib/analytics/analytics-read-access";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { prisma } from "@/lib/prisma";

type ListingType = (typeof LIQUIDITY_LISTING_TYPES)[number];
type Candidate = Extract<FunnelCandidateResult, { status: "UNAVAILABLE_PENDING_CAPTURE_COVERAGE" }>["candidate"];

const DAY_MS = 86_400_000;
/** Hard upper bound: an extra row means the window is too large; never truncate and count. */
export const FUNNEL_DIAGNOSTIC_EVENT_LIMIT = 5_000;
const EVENT_TYPES = [
  LIQUIDITY_LISTING_CREATED_EVENT_TYPE,
  LISTING_CONVERSATION_CREATED_EVENT_TYPE,
  LISTING_CONVERSATION_FIRST_REPLY_EVENT_TYPE,
  LISTING_CONVERSATION_ORDER_ATTRIBUTED_EVENT_TYPE,
] as const;

type DiagnosticEvidence = Readonly<{
  inspectedEvents: number;
  missingProjectionReceipts: number;
  missingProjectionIntents: number;
  inFlightProjectionJobs: number;
  deadLetterProjectionJobs: number;
  // Independent capture continuity, privacy approval, late event reconciliation,
  // and complete domain/event inventory are NOT inferable from stored rows.
  captureContinuityProven: false;
  privacyApprovalProven: false;
  sourceInventoryComplete: false;
}>;

export type AuthorizedFunnelDiagnostic =
  | Readonly<{
      status: "DISABLED" | "UNAVAILABLE_QUERY_BUDGET_EXCEEDED" | "IMMATURE_COHORT";
      candidate: null;
      evidence: null;
    }>
  | Readonly<{
      status: "UNAVAILABLE_PENDING_CAPTURE_COVERAGE";
      candidate: Candidate;
      evidence: DiagnosticEvidence;
    }>;

/**
 * INTERNAL/DIAGNOSTIC ONLY, not a route or a user-facing metric endpoint.
 *
 * Every call revalidates analytics.read for one specific campus; SQL reads are
 * restricted to that campus, four allowlisted fact kinds and the mature time
 * window. A 5001st event blocks the entire result rather than accepting a
 * truncated denominator. 0 returned rows is NEVER a verified 0% rate.
 *
 * Projection checks are negative diagnostics, NOT proof that fleet emitters,
 * privacy consent, all domain producers or the entire capture window were live.
 */
export async function loadAuthorizedUnreleasedFunnelDiagnostic(input: {
  actorId: string;
  campusId: string;
  listingType: ListingType;
  periodDays: 7 | 30;
  now?: Date;
}): Promise<AuthorizedFunnelDiagnostic> {
  if (!input.actorId || !input.campusId || input.campusId.length > 191 ||
      !LIQUIDITY_LISTING_TYPES.includes(input.listingType) ||
      (input.periodDays !== 7 && input.periodDays !== 30)) {
    throw new Error("FUNNEL_DIAGNOSTIC_SCOPE_INVALID");
  }

  // Authorization takes place BEFORE any campus, ledger, receipt or job read.
  const access = deriveAnalyticsReadAccess(await loadAuthorizationContext(input.actorId));
  if (!canReadAnalyticsCampus(access, input.campusId)) {
    throw new Error("FUNNEL_DIAGNOSTIC_SCOPE_DENIED");
  }

  if (process.env.ANALYTICS_FUNNEL_DIAGNOSTICS !== "enabled") {
    return { status: "DISABLED", candidate: null, evidence: null };
  }

  const now = input.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      now.getTime() <= 2 * FUNNEL_CONVERSION_WINDOW_MS) {
    throw new Error("FUNNEL_DIAGNOSTIC_CLOCK_INVALID");
  }
  const cohortEnd = new Date(now.getTime() - FUNNEL_CONVERSION_WINDOW_MS);
  const cohortStart = new Date(cohortEnd.getTime() - input.periodDays * DAY_MS);

  const campus = await prisma.campus.findUnique({
    where: { id: input.campusId }, select: { id: true },
  });
  if (!campus) throw new Error("FUNNEL_DIAGNOSTIC_CAMPUS_NOT_FOUND");

  const facts = await prisma.domainEvent.findMany({
    where: {
      campusId: campus.id,
      eventType: { in: [...EVENT_TYPES] },
      occurredAt: { gte: cohortStart, lte: now },
    },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    take: FUNNEL_DIAGNOSTIC_EVENT_LIMIT + 1,
    select: {
      id: true, eventType: true, schemaVersion: true,
      aggregateType: true, aggregateId: true, occurrenceKey: true,
      campusId: true, occurredAt: true, sourceType: true, payload: true,
    },
  });

  if (facts.length > FUNNEL_DIAGNOSTIC_EVENT_LIMIT) {
    return {
      status: "UNAVAILABLE_QUERY_BUDGET_EXCEEDED", candidate: null, evidence: null,
    };
  }

  const result = evaluateUnreleasedFunnelCohort({
    campusId: campus.id,
    listingType: input.listingType,
    cohortStart, cohortEnd, observedThrough: now,
    facts,
  });
  if (result.status !== "UNAVAILABLE_PENDING_CAPTURE_COVERAGE") {
    return { status: "IMMATURE_COHORT", candidate: null, evidence: null };
  }

  const eventIds = facts.map(fact => fact.id);
  const keys = eventIds.map(buildLiveDomainEventProjectionDedupeKey);
  const [receipts, jobs] = eventIds.length
    ? await Promise.all([
        prisma.projectionReceipt.findMany({
          where: {
            eventId: { in: eventIds },
            projectionKey: ANALYTICS_METRIC_PROJECTION_KEY,
            projectionVersion: ANALYTICS_METRIC_PROJECTION_VERSION,
          },
          select: { eventId: true },
        }),
        prisma.asyncJob.findMany({
          where: { dedupeKey: { in: keys } },
          select: { dedupeKey: true, status: true },
        }),
      ])
    : [[], []];

  const receiptIds = new Set(receipts.map(r => r.eventId));
  const jobsByKey = new Map(jobs.map(job => [job.dedupeKey, job.status]));
  let missingProjectionIntents = 0;
  let inFlightProjectionJobs = 0;
  let deadLetterProjectionJobs = 0;
  for (const key of keys) {
    const status = jobsByKey.get(key);
    if (!status) missingProjectionIntents++;
    else if (status === "PENDING" || status === "RETRY" || status === "RUNNING") {
      inFlightProjectionJobs++;
    } else if (status === "DEAD_LETTER") {
      deadLetterProjectionJobs++;
    }
  }

  return {
    status: "UNAVAILABLE_PENDING_CAPTURE_COVERAGE",
    candidate: result.candidate,
    evidence: {
      inspectedEvents: facts.length,
      missingProjectionReceipts: eventIds.filter(id => !receiptIds.has(id)).length,
      missingProjectionIntents,
      inFlightProjectionJobs,
      deadLetterProjectionJobs,
      captureContinuityProven: false,
      privacyApprovalProven: false,
      sourceInventoryComplete: false,
    },
  };
}
