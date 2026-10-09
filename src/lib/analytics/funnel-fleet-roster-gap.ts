import {
  FUNNEL_CAPTURE_STREAMS,
  type ClaimedCaptureInterval,
  type FunnelCaptureStream,
} from "@/lib/analytics/funnel-capture-continuity";

/**
 * Phase 10K-R2d-03B-02A. A candidate roster can DISPROVE claimed coverage
 * for listed instances. It cannot establish that the list contains every
 * app/worker instance. Only an independently authenticated host/orchestrator
 * inventory with lossless lifecycle and switch history can do that later.
 *
 * No DB/API/producer, no public KPI authorization, no trust escalation.
 */
export type CandidateFleetInstance = Readonly<{
  instanceId: string;
  releaseSha: string;
  role: "APP" | "ASYNC_WORKER";
}>;

export type CandidateFleetEpoch = Readonly<{
  /** Half-open epoch; rolling deployments list BOTH old and new instances. */
  from: Date;
  until: Date;
  /** Candidate membership ONLY. This array has no certified completeness. */
  instances: readonly CandidateFleetInstance[];
}>;

export type FleetGapReason =
  | "NO_CANDIDATE_ROSTER"
  | "INVALID_CANDIDATE_ROSTER"
  | "CANDIDATE_ROSTER_GAP"
  | "CANDIDATE_ROSTER_OVERLAP"
  | "APP_INSTANCE_ABSENT"
  | "WORKER_INSTANCE_ABSENT"
  | "INVALID_UNVERIFIED_CLAIM"
  | "INSTANCE_STREAM_CLAIM_GAP"
  | "DISABLED_CAPTURE_CLAIM";

export type FleetRosterGapDiagnostic = Readonly<{
  status: "INVALID_WINDOW" | "IMMATURE_COHORT" |
    "UNAVAILABLE_INDEPENDENT_FLEET_AUTHORITY_MISSING";
  canPublish: false;
  captureContinuityProven: false;
  deploymentMembershipComplete: false;
  /** Only coverage of submitted candidate frames, NEVER actual fleet membership. */
  candidateRosterCoversWindow: boolean;
  /** Only claimed coverage for submitted instances, NEVER verified capture. */
  allListedInstancesHaveClaims: boolean;
  reasons: readonly FleetGapReason[];
}>;

const DAY_MS = 86_400_000;
const TAIL_MS = 7 * DAY_MS;
const SHA = /^[0-9a-f]{40}$/;
const INSTANCE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_FRAMES = 512;
const MAX_INSTANCES_PER_FRAME = 128;
const MAX_INSTANCE_EPOCHS = 2_048;
const MAX_CLAIMS = 10_000;
const APP_STREAMS: readonly FunnelCaptureStream[] =
  FUNNEL_CAPTURE_STREAMS.filter(s => s !== "PROJECTION_WORKER");
const ORDER: readonly FleetGapReason[] = [
  "NO_CANDIDATE_ROSTER", "INVALID_CANDIDATE_ROSTER",
  "CANDIDATE_ROSTER_GAP", "CANDIDATE_ROSTER_OVERLAP",
  "APP_INSTANCE_ABSENT", "WORKER_INSTANCE_ABSENT",
  "INVALID_UNVERIFIED_CLAIM", "INSTANCE_STREAM_CLAIM_GAP",
  "DISABLED_CAPTURE_CLAIM",
];

const validDate = (date: unknown): date is Date =>
  date instanceof Date && Number.isFinite(date.getTime());

function validClaim(c: ClaimedCaptureInterval, observed: number): boolean {
  return c !== null && typeof c === "object" &&
    typeof c.campusId === "string" && c.campusId.length > 0 &&
    c.campusId.length <= 191 &&
    FUNNEL_CAPTURE_STREAMS.includes(c.stream) &&
    INSTANCE.test(c.instanceId) && SHA.test(c.releaseSha) &&
    typeof c.captureEnabled === "boolean" && c.source === "UNVERIFIED" &&
    validDate(c.from) && validDate(c.until) &&
    c.from.getTime() >= 0 && c.from.getTime() < c.until.getTime() &&
    c.until.getTime() <= observed;
}

function claimKey(
  stream: FunnelCaptureStream,
  instanceId: string,
  releaseSha: string,
): string {
  return JSON.stringify([stream, instanceId, releaseSha]);
}

function unionCovers(
  claims: readonly ClaimedCaptureInterval[],
  from: number,
  until: number,
): boolean {
  let cursor = from;
  const sorted = [...claims].sort((a, b) =>
    a.from.getTime() - b.from.getTime() ||
    b.until.getTime() - a.until.getTime());
  for (const c of sorted) {
    if (c.until.getTime() <= cursor) continue;
    if (c.from.getTime() > cursor) return false;
    cursor = Math.max(cursor, c.until.getTime());
    if (cursor >= until) return true;
  }
  return cursor >= until;
}

function invalidResult(status: "INVALID_WINDOW" | "IMMATURE_COHORT"): FleetRosterGapDiagnostic {
  return {
    status, canPublish: false, captureContinuityProven: false,
    deploymentMembershipComplete: false, candidateRosterCoversWindow: false,
    allListedInstancesHaveClaims: false, reasons: [],
  };
}

/**
 * Find negative counterexamples to an UNVERIFIED candidate fleet history.
 * Never accept a caller-controlled "attested" boolean or source label.
 *
 * Candidate epochs describe a complete roster AS CLAIMED; missing unnamed
 * instances are fundamentally unobservable and are NOT treated as absent.
 * An all-green diagnostic still cannot authorize a conversion denominator.
 */
export function diagnoseCandidateFleetRoster(input: Readonly<{
  campusId: string;
  cohortStart: Date;
  cohortEnd: Date;
  observedThrough: Date;
  candidateFleetEpochs: readonly CandidateFleetEpoch[];
  claimedIntervals: readonly ClaimedCaptureInterval[];
}>): FleetRosterGapDiagnostic {
  if (!input || typeof input.campusId !== "string" ||
      input.campusId.length < 1 || input.campusId.length > 191 ||
      !validDate(input.cohortStart) || !validDate(input.cohortEnd) ||
      !validDate(input.observedThrough) ||
      !Array.isArray(input.candidateFleetEpochs) ||
      !Array.isArray(input.claimedIntervals) ||
      input.candidateFleetEpochs.length > MAX_FRAMES ||
      input.claimedIntervals.length > MAX_CLAIMS) {
    return invalidResult("INVALID_WINDOW");
  }

  const start = input.cohortStart.getTime();
  const end = input.cohortEnd.getTime();
  const observed = input.observedThrough.getTime();
  const until = end + TAIL_MS;
  if (start < 0 || ![7, 30].includes((end - start) / DAY_MS) ||
      !Number.isSafeInteger(until)) return invalidResult("INVALID_WINDOW");
  if (until > observed) return invalidResult("IMMATURE_COHORT");

  const reasons = new Set<FleetGapReason>();
  const frames = [...input.candidateFleetEpochs].sort((a, b) => {
    const x = validDate(a?.from) ? a.from.getTime() : 0;
    const y = validDate(b?.from) ? b.from.getTime() : 0;
    return x - y;
  });
  if (!frames.length) reasons.add("NO_CANDIDATE_ROSTER");

  let count = 0;
  for (const f of frames) {
    if (!f || !validDate(f.from) || !validDate(f.until) ||
        f.from.getTime() < 0 || f.from.getTime() >= f.until.getTime() ||
        f.until.getTime() > observed || !Array.isArray(f.instances) ||
        f.instances.length > MAX_INSTANCES_PER_FRAME) {
      return invalidResult("INVALID_WINDOW");
    }
    count += f.instances.length;
    if (count > MAX_INSTANCE_EPOCHS) return invalidResult("INVALID_WINDOW");
    const seen = new Set<string>();
    for (const i of f.instances) {
      if (!i || typeof i.instanceId !== "string" ||
          !INSTANCE.test(i.instanceId) || !SHA.test(i.releaseSha) ||
          (i.role !== "APP" && i.role !== "ASYNC_WORKER") ||
          seen.has(i.instanceId)) {
        reasons.add("INVALID_CANDIDATE_ROSTER");
      } else {
        seen.add(i.instanceId);
      }
    }
  }

  // Scope BEFORE reading claims into a key-based index. A different campus
  // cannot supply a missing claim for this campus or leak an instance ID.
  const byInstanceStream = new Map<string, ClaimedCaptureInterval[]>();
  for (const c of input.claimedIntervals) {
    if (!c || typeof c !== "object" || c.campusId !== input.campusId) continue;
    if (!validClaim(c, observed)) {
      reasons.add("INVALID_UNVERIFIED_CLAIM");
      continue;
    }
    const key = claimKey(c.stream, c.instanceId, c.releaseSha);
    const list = byInstanceStream.get(key) ?? [];
    list.push(c);
    byInstanceStream.set(key, list);
  }

  let cursor = start;
  for (const frame of frames) {
    const from = Math.max(start, frame.from.getTime());
    const to = Math.min(until, frame.until.getTime());
    if (to <= from) continue; // valid epoch outside the measurement window
    if (from > cursor) reasons.add("CANDIDATE_ROSTER_GAP");
    if (from < cursor) reasons.add("CANDIDATE_ROSTER_OVERLAP");
    cursor = Math.max(cursor, to);

    if (!frame.instances.some((i: CandidateFleetInstance) => i.role === "APP")) {
      reasons.add("APP_INSTANCE_ABSENT");
    }
    if (!frame.instances.some((i: CandidateFleetInstance) => i.role === "ASYNC_WORKER")) {
      reasons.add("WORKER_INSTANCE_ABSENT");
    }

    for (const instance of frame.instances) {
      if (!instance || !INSTANCE.test(instance.instanceId) ||
          !SHA.test(instance.releaseSha) ||
          (instance.role !== "APP" && instance.role !== "ASYNC_WORKER")) continue;
      const required = instance.role === "ASYNC_WORKER"
        ? (["PROJECTION_WORKER"] as const)
        : APP_STREAMS;
      for (const stream of required) {
        const scoped = byInstanceStream.get(
          claimKey(stream, instance.instanceId, instance.releaseSha),
        ) ?? [];
        if (scoped.some(c => !c.captureEnabled &&
            c.from.getTime() < to && c.until.getTime() > from)) {
          reasons.add("DISABLED_CAPTURE_CLAIM");
        }
        const enabled = scoped.filter(c => c.captureEnabled);
        if (!unionCovers(enabled, from, to)) {
          reasons.add("INSTANCE_STREAM_CLAIM_GAP");
        }
      }
    }
  }
  if (cursor < until) reasons.add("CANDIDATE_ROSTER_GAP");

  const rosterProblems: readonly FleetGapReason[] = [
    "NO_CANDIDATE_ROSTER", "INVALID_CANDIDATE_ROSTER",
    "CANDIDATE_ROSTER_GAP", "CANDIDATE_ROSTER_OVERLAP",
    "APP_INSTANCE_ABSENT", "WORKER_INSTANCE_ABSENT",
  ];
  const candidateRosterCoversWindow =
    !rosterProblems.some(reason => reasons.has(reason));
  const allListedInstancesHaveClaims = candidateRosterCoversWindow &&
    !["INVALID_UNVERIFIED_CLAIM", "INSTANCE_STREAM_CLAIM_GAP",
      "DISABLED_CAPTURE_CLAIM"].some(reason => reasons.has(reason as FleetGapReason));

  return {
    status: "UNAVAILABLE_INDEPENDENT_FLEET_AUTHORITY_MISSING",
    canPublish: false, captureContinuityProven: false,
    deploymentMembershipComplete: false,
    candidateRosterCoversWindow, allListedInstancesHaveClaims,
    reasons: ORDER.filter(reason => reasons.has(reason)),
  };
}
