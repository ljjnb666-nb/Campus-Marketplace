import type { CandidateFleetInstance } from "@/lib/analytics/funnel-fleet-roster-gap";

/**
 * Phase 10K-R2d-03B-02B-01: adversarial replay of UNVERIFIED host observer
 * candidates. No Docker connection, privileged source, signed receipts,
 * runtime publisher, database writer or deployment authority is supplied.
 */
export type UnverifiedHostLifecycleObservation = Readonly<{
  origin: "UNVERIFIED_HOST_OBSERVER";
  hostId: string;
  sessionId: string;
  sequence: number;
  observedAt: Date;
  kind: "BASELINE" | "START" | "STOP" | "HEARTBEAT" | "DISCONNECTED";
  /** Only BASELINE: claimed full snapshot from an untrusted host process. */
  instances?: readonly CandidateFleetInstance[];
  /** Only START or STOP: a claimed exact process and release identity. */
  instance?: CandidateFleetInstance;
}>;

export type HostLifecycleReason =
  | "NO_OBSERVATIONS"
  | "INVALID_OBSERVATION"
  | "MISSING_INITIAL_BASELINE"
  | "PRE_WINDOW_UNKNOWN"
  | "POST_WINDOW_UNKNOWN"
  | "SEQUENCE_GAP_OR_REPLAY"
  | "SESSION_BOUNDARY_UNVERIFIED"
  | "CLOCK_NONMONOTONIC"
  | "OBSERVER_SILENCE"
  | "OBSERVER_DISCONNECTED"
  | "BASELINE_RESET"
  | "LIFECYCLE_CONFLICT"
  | "APP_ABSENT"
  | "WORKER_ABSENT";

export type HostLifecycleReplayDiagnostic = Readonly<{
  status: "INVALID_WINDOW" | "IMMATURE_COHORT" |
    "UNAVAILABLE_INDEPENDENT_HOST_OBSERVER_MISSING";
  canPublish: false;
  deploymentMembershipComplete: false;
  captureContinuityProven: false;
  /** This is only internal consistency of untrusted, caller-supplied records. */
  candidateHistoryInternallyConsistent: boolean;
  reasons: readonly HostLifecycleReason[];
}>;

const DAY = 86_400_000;
const TAIL = 7 * DAY;
const MAX_GAP = 15 * 60_000; // Static maximum: no caller-controlled override.
const MAX_OBSERVATIONS = 12_000;
const MAX_BASELINE_INSTANCES = 128;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SHA = /^[0-9a-f]{40}$/;
const ORDER: readonly HostLifecycleReason[] = [
  "NO_OBSERVATIONS", "INVALID_OBSERVATION", "MISSING_INITIAL_BASELINE",
  "PRE_WINDOW_UNKNOWN", "POST_WINDOW_UNKNOWN",
  "SEQUENCE_GAP_OR_REPLAY", "SESSION_BOUNDARY_UNVERIFIED",
  "CLOCK_NONMONOTONIC", "OBSERVER_SILENCE", "OBSERVER_DISCONNECTED",
  "BASELINE_RESET", "LIFECYCLE_CONFLICT", "APP_ABSENT", "WORKER_ABSENT",
];

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validInstance(value: unknown): value is CandidateFleetInstance {
  if (value === null || typeof value !== "object") return false;
  const x = value as Record<string, unknown>;
  return typeof x.instanceId === "string" && ID.test(x.instanceId) &&
    typeof x.releaseSha === "string" && SHA.test(x.releaseSha) &&
    (x.role === "APP" || x.role === "ASYNC_WORKER");
}

function invalid(status: "INVALID_WINDOW" | "IMMATURE_COHORT"): HostLifecycleReplayDiagnostic {
  return { status, canPublish: false,
    deploymentMembershipComplete: false, captureContinuityProven: false,
    candidateHistoryInternallyConsistent: false, reasons: [] };
}

/**
 * An independent observer is NOT instantiated by this function. Calling it
 * with forged or self-reported host data never grants deployment authority.
 * Explicitly detect observational blindness, including silent Docker event
 * periods and process identity reuse; report no instance/host identifiers.
 */
export function replayUnverifiedHostLifecycle(input: Readonly<{
  cohortStart: Date;
  cohortEnd: Date;
  observedThrough: Date;
  observations: readonly UnverifiedHostLifecycleObservation[];
}>): HostLifecycleReplayDiagnostic {
  if (!input || !validDate(input.cohortStart) ||
      !validDate(input.cohortEnd) || !validDate(input.observedThrough) ||
      !Array.isArray(input.observations) ||
      input.observations.length > MAX_OBSERVATIONS) return invalid("INVALID_WINDOW");

  const from = input.cohortStart.getTime();
  const end = input.cohortEnd.getTime();
  const through = end + TAIL;
  const observed = input.observedThrough.getTime();
  if (from < 0 || ![7, 30].includes((end - from) / DAY) ||
      !Number.isSafeInteger(through)) return invalid("INVALID_WINDOW");
  if (through > observed) return invalid("IMMATURE_COHORT");

  const reasons = new Set<HostLifecycleReason>();
  if (input.observations.length === 0) reasons.add("NO_OBSERVATIONS");
  let first = true;
  let host: string | null = null;
  let session: string | null = null;
  let lastSeq: number | null = null;
  let lastAt: number | null = null;
  const running = new Map<string, CandidateFleetInstance>();

  // Test the state over actual half-open intervals, not just heartbeat instants.
  // STOP at t, START at t+1ms is a real 1ms gap; simultaneous transitions
  // at the same timestamp have no elapsed uncovered interval.
  function checkActiveInterval(fromAt: number, toAt: number) {
    if (Math.max(fromAt, from) >= Math.min(toAt, through)) return;
    if (![...running.values()].some(i => i.role === "APP")) {
      reasons.add("APP_ABSENT");
    }
    if (![...running.values()].some(i => i.role === "ASYNC_WORKER")) {
      reasons.add("WORKER_ABSENT");
    }
  }

  for (const row of input.observations) {
    if (!row || typeof row !== "object" ||
        row.origin !== "UNVERIFIED_HOST_OBSERVER" ||
        typeof row.hostId !== "string" || !ID.test(row.hostId) ||
        typeof row.sessionId !== "string" || !ID.test(row.sessionId) ||
        !Number.isSafeInteger(row.sequence) || row.sequence < 1 ||
        !validDate(row.observedAt) ||
        row.observedAt.getTime() < 0 || row.observedAt.getTime() > observed ||
        !["BASELINE", "START", "STOP", "HEARTBEAT", "DISCONNECTED"].includes(row.kind)) {
      reasons.add("INVALID_OBSERVATION");
      continue;
    }
    const at = row.observedAt.getTime();
    if (lastAt !== null && at > lastAt) checkActiveInterval(lastAt, at);
    if (first) {
      first = false;
      if (row.kind !== "BASELINE") reasons.add("MISSING_INITIAL_BASELINE");
      if (at > from) reasons.add("PRE_WINDOW_UNKNOWN");
      host = row.hostId;
      session = row.sessionId;
    } else {
      if (row.hostId !== host || row.sessionId !== session) {
        reasons.add("SESSION_BOUNDARY_UNVERIFIED");
      }
      if (lastSeq !== null && row.sequence !== lastSeq + 1) {
        reasons.add("SEQUENCE_GAP_OR_REPLAY");
      }
      if (lastAt !== null) {
        if (at < lastAt) reasons.add("CLOCK_NONMONOTONIC");
        if (at - lastAt > MAX_GAP && at >= from && lastAt < through) {
          reasons.add("OBSERVER_SILENCE");
        }
      }
    }
    lastSeq = row.sequence;
    lastAt = at;

    if (row.kind === "BASELINE") {
      if (!Array.isArray(row.instances) ||
          row.instances.length > MAX_BASELINE_INSTANCES ||
          row.instance !== undefined) {
        reasons.add("INVALID_OBSERVATION");
        continue;
      }
      const snapshot = new Map<string, CandidateFleetInstance>();
      for (const i of row.instances) {
        if (!validInstance(i) || snapshot.has(i.instanceId)) {
          reasons.add("INVALID_OBSERVATION");
        } else {
          snapshot.set(i.instanceId, i);
        }
      }
      if (row !== input.observations[0]) reasons.add("BASELINE_RESET");
      running.clear();
      for (const [key, item] of snapshot) running.set(key, item);
    } else if (row.kind === "START" || row.kind === "STOP") {
      if (!validInstance(row.instance) || row.instances !== undefined) {
        reasons.add("INVALID_OBSERVATION");
        continue;
      }
      const existing = running.get(row.instance.instanceId);
      if (row.kind === "START") {
        if (existing) reasons.add("LIFECYCLE_CONFLICT");
        else running.set(row.instance.instanceId, row.instance);
      } else {
        if (!existing || existing.releaseSha !== row.instance.releaseSha ||
            existing.role !== row.instance.role) {
          reasons.add("LIFECYCLE_CONFLICT");
        } else {
          running.delete(row.instance.instanceId);
        }
      }
    } else {
      if (row.instance !== undefined || row.instances !== undefined) {
        reasons.add("INVALID_OBSERVATION");
      }
      if (row.kind === "DISCONNECTED" && at < through) {
        reasons.add("OBSERVER_DISCONNECTED");
      }
      if (row.kind === "HEARTBEAT" && at >= from && at < through) {
        if (![...running.values()].some(i => i.role === "APP")) {
          reasons.add("APP_ABSENT");
        }
        if (![...running.values()].some(i => i.role === "ASYNC_WORKER")) {
          reasons.add("WORKER_ABSENT");
        }
      }
    }
  }
  if (lastAt !== null && lastAt < through) checkActiveInterval(lastAt, through);
  if (lastAt === null || lastAt < through) reasons.add("POST_WINDOW_UNKNOWN");
  if (lastAt !== null && lastAt < through && through - lastAt > MAX_GAP) {
    reasons.add("OBSERVER_SILENCE");
  }
  return {
    status: "UNAVAILABLE_INDEPENDENT_HOST_OBSERVER_MISSING",
    canPublish: false, deploymentMembershipComplete: false,
    captureContinuityProven: false,
    candidateHistoryInternallyConsistent: reasons.size === 0,
    reasons: ORDER.filter(reason => reasons.has(reason)),
  };
}
