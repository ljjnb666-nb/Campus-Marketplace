import {
  inspectUnverifiedCandidateCheckpointForks,
} from "@/lib/analytics/funnel-host-observer-candidate-fork";
import type {
  UnverifiedCandidateReceiptCheckpoint,
} from "@/lib/analytics/funnel-host-observer-candidate-checkpoint";

/**
 * 10K-R2d-03B-02B-02B-07: candidate-only submitted window-edge diagnostic.
 * Bracketing times is NOT proof of observation or real host capture.
 * All inputs, including the window bounds, originate with the caller.
 */
export type CandidateWindowEdgeReason =
  | "DENIED_INVALID_CANDIDATE_WINDOW"
  | "DENIED_INVALID_CANDIDATE_TIPS"
  | "DENIED_SUBMITTED_FORK_OR_HASH_REUSE"
  | "DENIED_MIXED_CANDIDATE_SCOPE"
  | "DENIED_SUBMITTED_SEQUENCE_OR_TIME_GAP"
  | "DENIED_UNBRACKETED_CANDIDATE_START"
  | "DENIED_UNBRACKETED_CANDIDATE_END"
  | "CANDIDATE_SUBMITTED_WINDOW_BRACKET_ONLY";

export type CandidateWindowEdgeDiagnostic = Readonly<{
  reason: CandidateWindowEdgeReason;
  candidateWindowInternallyBracketed: boolean;
  submittedUniqueTips: number;
  independentProvisioningVerified: false;
  independentHostAuthenticated: false;
  deploymentMembershipComplete: false;
  captureContinuityProven: false;
  canPublish: false;
}>;

const MAX_TIPS = 128;
const MAX_GAP_MS = 15 * 60_000;
const MAX_WINDOW_MS = 60 * 60_000;
const FIELDS = [
  "source", "principalId", "hostId", "sessionId", "sequence",
  "lastReceiptHash", "observedAt", "signedAt",
] as const;

function outcome(
  reason: CandidateWindowEdgeReason,
  count = 0,
): CandidateWindowEdgeDiagnostic {
  return {
    reason,
    candidateWindowInternallyBracketed:
      reason === "CANDIDATE_SUBMITTED_WINDOW_BRACKET_ONLY",
    submittedUniqueTips:
      reason === "CANDIDATE_SUBMITTED_WINDOW_BRACKET_ONLY" ? count : 0,
    independentProvisioningVerified: false,
    independentHostAuthenticated: false,
    deploymentMembershipComplete: false,
    captureContinuityProven: false,
    canPublish: false,
  };
}

function dateMs(value: unknown): number {
  let ms: number;
  try {
    // Native Date internal-slot check rejects impostors and Proxy(Date).
    ms = Date.prototype.getTime.call(value);
  } catch {
    throw new Error("INVALID_CANDIDATE_DATE");
  }
  if (!Number.isFinite(ms) || ms < 0) throw new Error("INVALID_CANDIDATE_DATE");
  return ms;
}

function exactDataObject(
  value: unknown,
  names: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("INVALID_CANDIDATE_DTO");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error("INVALID_CANDIDATE_DTO");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length ||
      keys.some(k => typeof k !== "string" || !names.includes(k))) {
    throw new Error("INVALID_CANDIDATE_DTO");
  }
  const snapshot: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = descriptors[name];
    if (!descriptor || !("value" in descriptor)) {
      throw new Error("INVALID_CANDIDATE_DTO");
    }
    snapshot[name] = descriptor.value;
  }
  return snapshot;
}

function snapshotTip(value: unknown): UnverifiedCandidateReceiptCheckpoint {
  const v = exactDataObject(value, FIELDS);
  return {
    source: v.source as "UNVERIFIED_CANDIDATE",
    principalId: v.principalId as string,
    hostId: v.hostId as string,
    sessionId: v.sessionId as string,
    sequence: v.sequence as number,
    lastReceiptHash: v.lastReceiptHash as string,
    observedAt: new Date(dateMs(v.observedAt)),
    signedAt: new Date(dateMs(v.signedAt)),
  };
}

/**
 * No data is stored or committed. A result only describes this one bounded
 * set; it cannot rule out omitted hosts, intervals, events or sessions.
 */
export function inspectUnverifiedCandidateWindowEdges(input: Readonly<{
  windowStart: Date;
  windowEnd: Date;
  tips: readonly UnverifiedCandidateReceiptCheckpoint[];
}>): CandidateWindowEdgeDiagnostic {
  try {
    const args = exactDataObject(input, ["windowStart", "windowEnd", "tips"]);
    let from: number;
    let through: number;
    try {
      from = dateMs(args.windowStart);
      through = dateMs(args.windowEnd);
    } catch {
      return outcome("DENIED_INVALID_CANDIDATE_WINDOW");
    }
    if (through <= from || through - from > MAX_WINDOW_MS ||
        !Number.isSafeInteger(through)) {
      return outcome("DENIED_INVALID_CANDIDATE_WINDOW");
    }
    if (!Array.isArray(args.tips) ||
        args.tips.length < 2 || args.tips.length > MAX_TIPS) {
      return outcome("DENIED_INVALID_CANDIDATE_TIPS");
    }
    const tips: UnverifiedCandidateReceiptCheckpoint[] = [];
    for (const raw of args.tips) tips.push(snapshotTip(raw));

    // Snapshot once, then invoke the existing candidate fork/DTO validator;
    // the original caller values are never reread.
    const check = inspectUnverifiedCandidateCheckpointForks(tips);
    if (check.reason === "DENIED_CONFLICTING_CANDIDATE_TIPS" ||
        check.reason === "DENIED_CANDIDATE_HASH_SCOPE_REUSE") {
      return outcome("DENIED_SUBMITTED_FORK_OR_HASH_REUSE");
    }
    if (!check.candidateSubmittedSetInternallyConsistent) {
      return outcome("DENIED_INVALID_CANDIDATE_TIPS");
    }

    const first = tips[0];
    const principal = first.principalId;
    const host = first.hostId;
    const session = first.sessionId;
    const unique = new Map<number, UnverifiedCandidateReceiptCheckpoint>();
    for (const tip of tips) {
      if (tip.principalId !== principal || tip.hostId !== host ||
          tip.sessionId !== session) {
        return outcome("DENIED_MIXED_CANDIDATE_SCOPE");
      }
      unique.set(tip.sequence, tip);
    }
    const ordered = [...unique.values()].sort((a, b) => a.sequence - b.sequence);
    for (let i = 1; i < ordered.length; i++) {
      const prior = ordered[i - 1];
      const current = ordered[i];
      const elapsed = current.observedAt.getTime() - prior.observedAt.getTime();
      if (!Number.isSafeInteger(prior.sequence + 1) ||
          current.sequence !== prior.sequence + 1 ||
          elapsed < 0 || elapsed > MAX_GAP_MS ||
          current.signedAt.getTime() < prior.signedAt.getTime()) {
        return outcome("DENIED_SUBMITTED_SEQUENCE_OR_TIME_GAP");
      }
    }

    const startAt = ordered[0].observedAt.getTime();
    const endAt = ordered[ordered.length - 1].observedAt.getTime();
    if (startAt > from || from - startAt > MAX_GAP_MS) {
      return outcome("DENIED_UNBRACKETED_CANDIDATE_START");
    }
    if (endAt < through || endAt - through > MAX_GAP_MS) {
      return outcome("DENIED_UNBRACKETED_CANDIDATE_END");
    }
    return outcome("CANDIDATE_SUBMITTED_WINDOW_BRACKET_ONLY", unique.size);
  } catch {
    return outcome("DENIED_INVALID_CANDIDATE_TIPS");
  }
}
