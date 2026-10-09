/**
 * Phase 10K-R2d-03A: negative-only fleet capture continuity diagnostics.
 *
 * A deploy log, release SHA, current feature flag or worker heartbeat cannot
 * prove that EVERY relevant app instance was continuously emitting facts.
 * This pure function inspects UNTRUSTED candidate interval claims only. It has
 * no capability to grant coverage, mark a denominator complete, or publish KPIs.
 * Persistent, independently authenticated fleet membership and interval
 * evidence must be designed and verified in the later R2d-03 stages.
 */

export const FUNNEL_CAPTURE_STREAMS = [
  "LISTING_CREATED",
  "CONVERSATION_CREATED",
  "FIRST_REPLY",
  "ORDER_ATTRIBUTION",
  "PROJECTION_WORKER",
] as const;

export type FunnelCaptureStream = (typeof FUNNEL_CAPTURE_STREAMS)[number];

export type ClaimedCaptureInterval = Readonly<{
  campusId: string;
  stream: FunnelCaptureStream;
  instanceId: string;
  releaseSha: string;
  /** Claimed start of production eligibility (inclusive). */
  from: Date;
  /** Claimed end of production eligibility (exclusive). */
  until: Date;
  /** This is a CLAIM, not an audited persisted switch history. */
  captureEnabled: boolean;
  /** Source provenance is descriptive; never accepted as trust authority. */
  source: "DEPLOY_LOG" | "RUNTIME_HEARTBEAT" | "UNVERIFIED";
}>;

export type CaptureGapReason =
  | "NO_CLAIMS"
  | "INVALID_CLAIM"
  | "DISABLED_CLAIM"
  | "CLAIMED_INTERVAL_GAP";

export type CaptureStreamDiagnostic = Readonly<{
  stream: FunnelCaptureStream;
  /** Coverage of the union of valid claims only, not fleet-wide proof. */
  claimCoversWindow: boolean;
  reasons: readonly CaptureGapReason[];
}>;

export type CaptureContinuityDiagnostic =
  | Readonly<{
      status: "INVALID_WINDOW" | "IMMATURE_COHORT";
      canPublish: false;
      captureContinuityProven: false;
      streamDiagnostics: readonly [];
    }>
  | Readonly<{
      status: "UNAVAILABLE_FLEET_AUTHORITY_NOT_ESTABLISHED";
      canPublish: false;
      captureContinuityProven: false;
      /** Even a fully-covered claim is never evidence of all running writers. */
      deploymentMembershipComplete: false;
      streamDiagnostics: readonly CaptureStreamDiagnostic[];
    }>;

const DAY_MS = 86_400_000;
const ATTRIBUTION_MS = 7 * DAY_MS;
const SHA = /^[0-9a-f]{40}$/;
const INSTANCE = /^[A-Za-z0-9_.:-]{1,128}$/;
const STREAMS: ReadonlySet<string> = new Set(FUNNEL_CAPTURE_STREAMS);
const isDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());

function claimValid(
  claim: ClaimedCaptureInterval,
  campusId: string,
  stream: FunnelCaptureStream,
  observedMs: number,
): boolean {
  return claim.campusId === campusId && claim.stream === stream &&
    INSTANCE.test(claim.instanceId) && SHA.test(claim.releaseSha) &&
    isDate(claim.from) && isDate(claim.until) &&
    claim.from.getTime() < claim.until.getTime() &&
    claim.until.getTime() <= observedMs &&
    (claim.source === "DEPLOY_LOG" ||
      claim.source === "RUNTIME_HEARTBEAT" ||
      claim.source === "UNVERIFIED");
}

function unionCoversWindow(
  intervals: readonly ClaimedCaptureInterval[],
  startMs: number,
  endMs: number,
): boolean {
  let cursor = startMs;
  const sorted = [...intervals].sort((a, b) =>
    a.from.getTime() - b.from.getTime() ||
    b.until.getTime() - a.until.getTime());
  for (const row of sorted) {
    const from = row.from.getTime();
    const until = row.until.getTime();
    // Overlap is allowed for rolling deploys, but ANY uncovered millisecond
    // is a gap. Adjacent half-open intervals are continuous.
    if (from > cursor) return false;
    if (until > cursor) cursor = until;
    if (cursor >= endMs) return true;
  }
  return cursor >= endMs;
}

/**
 * Do not pass external request/tenant inputs as release attestations.
 * This reads no records and emits no proofs. Only scoped diagnostic booleans
 * and reason codes leave this function, never instance IDs or release SHAs.
 */
export function diagnoseUnverifiedCaptureContinuity(input: Readonly<{
  campusId: string;
  cohortStart: Date;
  cohortEnd: Date;
  observedThrough: Date;
  claimedIntervals: readonly ClaimedCaptureInterval[];
}>): CaptureContinuityDiagnostic {
  if (typeof input.campusId !== "string" || input.campusId.length < 1 ||
      input.campusId.length > 191 ||
      !isDate(input.cohortStart) || !isDate(input.cohortEnd) ||
      !isDate(input.observedThrough) || !Array.isArray(input.claimedIntervals) ||
      input.claimedIntervals.length > 10_000) {
    return { status: "INVALID_WINDOW", canPublish: false,
      captureContinuityProven: false, streamDiagnostics: [] };
  }

  const from = input.cohortStart.getTime();
  const cohortEnd = input.cohortEnd.getTime();
  const observed = input.observedThrough.getTime();
  if (cohortEnd <= from || ![7, 30].includes((cohortEnd - from) / DAY_MS) ||
      from < 0 || !Number.isSafeInteger(cohortEnd + ATTRIBUTION_MS)) {
    return { status: "INVALID_WINDOW", canPublish: false,
      captureContinuityProven: false, streamDiagnostics: [] };
  }
  const until = cohortEnd + ATTRIBUTION_MS;
  if (until > observed) {
    return { status: "IMMATURE_COHORT", canPublish: false,
      captureContinuityProven: false, streamDiagnostics: [] };
  }

  const streamDiagnostics = FUNNEL_CAPTURE_STREAMS.map(stream => {
    // Ignore unrelated campuses/streams BEFORE considering any evidence.
    const scoped = input.claimedIntervals.filter(row =>
      row !== null && typeof row === "object" &&
      row.campusId === input.campusId && row.stream === stream);
    const reasons: CaptureGapReason[] = [];
    if (!scoped.length) reasons.push("NO_CLAIMS");

    const valid = scoped.filter(row =>
      claimValid(row, input.campusId, stream, observed));
    if (valid.length !== scoped.length) reasons.push("INVALID_CLAIM");
    if (valid.some(row => !row.captureEnabled)) reasons.push("DISABLED_CLAIM");

    const enabled = valid.filter(row =>
      row.captureEnabled &&
      row.until.getTime() > from && row.from.getTime() < until);
    const claimCoversWindow = unionCoversWindow(enabled, from, until);
    if (scoped.length > 0 && !claimCoversWindow) {
      reasons.push("CLAIMED_INTERVAL_GAP");
    }
    return { stream, claimCoversWindow, reasons };
  });

  return {
    status: "UNAVAILABLE_FLEET_AUTHORITY_NOT_ESTABLISHED",
    canPublish: false,
    captureContinuityProven: false,
    deploymentMembershipComplete: false,
    streamDiagnostics,
  };
}
