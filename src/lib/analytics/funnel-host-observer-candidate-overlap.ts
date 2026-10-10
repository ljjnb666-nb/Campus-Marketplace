import type {
  UnverifiedCandidateReceiptCheckpoint,
} from "@/lib/analytics/funnel-host-observer-candidate-checkpoint";
import {
  inspectUnverifiedCandidateCheckpointForks,
} from "@/lib/analytics/funnel-host-observer-candidate-fork";
import {
  inspectUnverifiedCandidateWindowEdges,
} from "@/lib/analytics/funnel-host-observer-candidate-window-edges";

/**
 * Phase 10K-R2d-03B-02B-02B-08: compare two caller-supplied candidate
 * windows IN ONE CALL. No host/capture identity, complete history, durable
 * checkpoint, cross-request anti-replay, or production publication rights.
 */
export type CandidateOverlapReason =
  | "DENIED_INVALID_CANDIDATE_WINDOW_PAIR"
  | "DENIED_UNBRACKETED_CANDIDATE_WINDOW"
  | "DENIED_NONOVERLAPPING_CANDIDATE_WINDOWS"
  | "DENIED_MIXED_CANDIDATE_SCOPE"
  | "DENIED_CONFLICTING_CANDIDATE_TIPS"
  | "DENIED_NO_SHARED_CANDIDATE_ANCHOR"
  | "CANDIDATE_SUBMITTED_OVERLAP_ONLY";

export type CandidateOverlapDiagnostic = Readonly<{
  reason: CandidateOverlapReason;
  candidateOverlapInternallyConsistent: boolean;
  sharedSubmittedAnchors: number;
  independentProvisioningVerified: false;
  independentHostAuthenticated: false;
  deploymentMembershipComplete: false;
  captureContinuityProven: false;
  canPublish: false;
}>;

export type UnverifiedCandidateWindow = Readonly<{
  windowStart: Date;
  windowEnd: Date;
  tips: readonly UnverifiedCandidateReceiptCheckpoint[];
}>;

const TOP = ["earlier", "later"] as const;
const WINDOW = ["windowStart", "windowEnd", "tips"] as const;
const TIP = [
  "source", "principalId", "hostId", "sessionId", "sequence",
  "lastReceiptHash", "observedAt", "signedAt",
] as const;
// Two batches together must fit the existing 128-tip fork scanner.
const MAX_TIPS = 64;

function result(
  reason: CandidateOverlapReason,
  sharedSubmittedAnchors = 0,
): CandidateOverlapDiagnostic {
  return {
    reason,
    candidateOverlapInternallyConsistent:
      reason === "CANDIDATE_SUBMITTED_OVERLAP_ONLY",
    sharedSubmittedAnchors:
      reason === "CANDIDATE_SUBMITTED_OVERLAP_ONLY" ? sharedSubmittedAnchors : 0,
    independentProvisioningVerified: false,
    independentHostAuthenticated: false,
    deploymentMembershipComplete: false,
    captureContinuityProven: false,
    canPublish: false,
  };
}

function exactData(
  input: unknown,
  names: readonly string[],
): Record<string, unknown> {
  if (!input || typeof input !== "object") throw new Error("CANDIDATE_INPUT_INVALID");
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error("CANDIDATE_INPUT_INVALID");
  }
  const desc = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(input);
  if (keys.length !== names.length ||
      keys.some(k => typeof k !== "string" || !names.includes(k))) {
    throw new Error("CANDIDATE_INPUT_INVALID");
  }
  const snap: Record<string, unknown> = {};
  for (const name of names) {
    if (!desc[name] || !("value" in desc[name])) {
      throw new Error("CANDIDATE_INPUT_INVALID");
    }
    snap[name] = desc[name].value;
  }
  return snap;
}

function dateCopy(value: unknown): Date {
  let ms: number;
  try {
    ms = Date.prototype.getTime.call(value);
  } catch {
    throw new Error("CANDIDATE_DATE_INVALID");
  }
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new Error("CANDIDATE_DATE_INVALID");
  }
  return new Date(ms);
}

function copyWindow(value: unknown): UnverifiedCandidateWindow {
  const w = exactData(value, WINDOW);
  if (!Array.isArray(w.tips) || w.tips.length < 2 ||
      w.tips.length > MAX_TIPS) {
    throw new Error("CANDIDATE_WINDOW_TIPS_INVALID");
  }
  const tips: UnverifiedCandidateReceiptCheckpoint[] = [];
  for (const item of w.tips) {
    const t = exactData(item, TIP);
    tips.push({
      source: t.source as "UNVERIFIED_CANDIDATE",
      principalId: t.principalId as string,
      hostId: t.hostId as string,
      sessionId: t.sessionId as string,
      sequence: t.sequence as number,
      lastReceiptHash: t.lastReceiptHash as string,
      observedAt: dateCopy(t.observedAt),
      signedAt: dateCopy(t.signedAt),
    });
  }
  return {
    windowStart: dateCopy(w.windowStart),
    windowEnd: dateCopy(w.windowEnd),
    tips,
  };
}

function claimedScope(window: UnverifiedCandidateWindow): string {
  const tip = window.tips[0];
  return JSON.stringify([tip.principalId, tip.hostId, tip.sessionId]);
}

/**
 * Detect only a pair of submitted overlapping windows with a shared
 * exact candidate checkpoint tip IN THE INTERSECTION of their bounds.
 * An omitted fork, omitted host, or fork in a different call is invisible.
 */
export function inspectUnverifiedCandidateWindowOverlap(
  input: Readonly<{
    earlier: UnverifiedCandidateWindow;
    later: UnverifiedCandidateWindow;
  }>,
): CandidateOverlapDiagnostic {
  try {
    const pair = exactData(input, TOP);
    const earlier = copyWindow(pair.earlier);
    const later = copyWindow(pair.later);

    // Existing window and fork validators receive ONLY the detached snapshot.
    if (!inspectUnverifiedCandidateWindowEdges(earlier).candidateWindowInternallyBracketed ||
        !inspectUnverifiedCandidateWindowEdges(later).candidateWindowInternallyBracketed) {
      return result("DENIED_UNBRACKETED_CANDIDATE_WINDOW");
    }

    const start = Math.max(
      earlier.windowStart.getTime(), later.windowStart.getTime(),
    );
    const end = Math.min(
      earlier.windowEnd.getTime(), later.windowEnd.getTime(),
    );
    if (start >= end) {
      return result("DENIED_NONOVERLAPPING_CANDIDATE_WINDOWS");
    }
    if (claimedScope(earlier) !== claimedScope(later)) {
      return result("DENIED_MIXED_CANDIDATE_SCOPE");
    }

    const union = inspectUnverifiedCandidateCheckpointForks([
      ...earlier.tips, ...later.tips,
    ]);
    if (union.reason === "DENIED_CONFLICTING_CANDIDATE_TIPS" ||
        union.reason === "DENIED_CANDIDATE_HASH_SCOPE_REUSE") {
      return result("DENIED_CONFLICTING_CANDIDATE_TIPS");
    }
    if (!union.candidateSubmittedSetInternallyConsistent) {
      return result("DENIED_INVALID_CANDIDATE_WINDOW_PAIR");
    }

    const earlierBySequence = new Map(
      earlier.tips.map(tip => [tip.sequence, tip]),
    );
    let anchors = 0;
    for (const tip of new Map(
      later.tips.map(tip => [tip.sequence, tip]),
    ).values()) {
      const prior = earlierBySequence.get(tip.sequence);
      // The union candidate fork detector already rejects differing hashes
      // or timestamps on the same scope/sequence.
      const at = tip.observedAt.getTime();
      if (prior && at >= start && at <= end) anchors++;
    }
    if (anchors === 0) return result("DENIED_NO_SHARED_CANDIDATE_ANCHOR");
    return result("CANDIDATE_SUBMITTED_OVERLAP_ONLY", anchors);
  } catch {
    return result("DENIED_INVALID_CANDIDATE_WINDOW_PAIR");
  }
}
