import {
  inspectUnverifiedCandidateCheckpointForks,
} from "@/lib/analytics/funnel-host-observer-candidate-fork";
import type {
  UnverifiedCandidateReceiptCheckpoint,
} from "@/lib/analytics/funnel-host-observer-candidate-checkpoint";

/**
 * Phase 10K-R2d-03B-02B-02B-06 — submitted-candidate timeline diagnostic.
 * A caller can omit arbitrary records and forge all candidate checkpoints.
 * This does NOT prove capture continuity, source identity, durable replay
 * resistance, deployment completeness or authorization to publish.
 */
export type CandidateTimelineReason =
  | "DENIED_INVALID_CANDIDATE_TIPS"
  | "DENIED_SUBMITTED_FORK_OR_HASH_REUSE"
  | "DENIED_SUBMITTED_SEQUENCE_GAP"
  | "DENIED_SUBMITTED_TIME_ROLLBACK_OR_SILENCE"
  | "CANDIDATE_SUBMITTED_TIMELINE_ONLY";

export type CandidateTimelineDiagnostic = Readonly<{
  reason: CandidateTimelineReason;
  candidateSubmittedTimelineInternallyConsistent: boolean;
  submittedUniqueSlots: number;
  independentProvisioningVerified: false;
  independentHostAuthenticated: false;
  deploymentMembershipComplete: false;
  captureContinuityProven: false;
  canPublish: false;
}>;

type SnapshotTip = Readonly<{
  checkpoint: UnverifiedCandidateReceiptCheckpoint;
  principalId: string;
  hostId: string;
  sessionId: string;
  sequence: number;
  receiptHash: string;
  observedMs: number;
  signedMs: number;
}>;

const FIELDS = [
  "source", "principalId", "hostId", "sessionId", "sequence",
  "lastReceiptHash", "observedAt", "signedAt",
] as const;
const MAX_TIPS = 128;
const MAX_OBSERVED_SILENCE_MS = 15 * 60_000;

function diagnostic(
  reason: CandidateTimelineReason,
  count = 0,
): CandidateTimelineDiagnostic {
  return {
    reason,
    candidateSubmittedTimelineInternallyConsistent:
      reason === "CANDIDATE_SUBMITTED_TIMELINE_ONLY",
    submittedUniqueSlots: reason === "CANDIDATE_SUBMITTED_TIMELINE_ONLY" ? count : 0,
    independentProvisioningVerified: false,
    independentHostAuthenticated: false,
    deploymentMembershipComplete: false,
    captureContinuityProven: false,
    canPublish: false,
  };
}

function dateMilliseconds(value: unknown): number {
  // Internal slot validation avoids invoking attacker-controlled getTime().
  let ms: number;
  try {
    ms = Date.prototype.getTime.call(value);
  } catch {
    throw new Error("CANDIDATE_TIP_INVALID");
  }
  if (!Number.isFinite(ms) || ms < 0) throw new Error("CANDIDATE_TIP_INVALID");
  return ms;
}

function snapshotTip(value: unknown): SnapshotTip {
  if (value === null || typeof value !== "object") {
    throw new Error("CANDIDATE_TIP_INVALID");
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error("CANDIDATE_TIP_INVALID");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== FIELDS.length) {
    throw new Error("CANDIDATE_TIP_INVALID");
  }
  const fields: Record<string, unknown> = {};
  for (const field of FIELDS) {
    const descriptor = descriptors[field];
    if (!descriptor || !("value" in descriptor)) {
      throw new Error("CANDIDATE_TIP_INVALID");
    }
    fields[field] = descriptor.value;
  }
  const observedMs = dateMilliseconds(fields.observedAt);
  const signedMs = dateMilliseconds(fields.signedAt);
  const checkpoint: UnverifiedCandidateReceiptCheckpoint = {
    source: fields.source as "UNVERIFIED_CANDIDATE",
    principalId: fields.principalId as string,
    hostId: fields.hostId as string,
    sessionId: fields.sessionId as string,
    sequence: fields.sequence as number,
    lastReceiptHash: fields.lastReceiptHash as string,
    observedAt: new Date(observedMs),
    signedAt: new Date(signedMs),
  };
  return {
    checkpoint,
    principalId: checkpoint.principalId,
    hostId: checkpoint.hostId,
    sessionId: checkpoint.sessionId,
    sequence: checkpoint.sequence,
    receiptHash: checkpoint.lastReceiptHash,
    observedMs,
    signedMs,
  };
}

/**
 * Detect time/sequence contradictions among ALL the supplied candidate tips.
 * Tuples may arrive in any order and identical duplicate tips are ignored.
 * Missing tips across separate requests remain UNOBSERVABLE by construction.
 */
export function inspectUnverifiedCandidateCheckpointTimeline(
  input: readonly UnverifiedCandidateReceiptCheckpoint[],
): CandidateTimelineDiagnostic {
  try {
    if (!Array.isArray(input) || input.length < 1 || input.length > MAX_TIPS) {
      return diagnostic("DENIED_INVALID_CANDIDATE_TIPS");
    }
    const snapshots: SnapshotTip[] = [];
    for (const value of input) snapshots.push(snapshotTip(value));
    // Validate the SINGLE canonical snapshot, never reread untrusted inputs.
    const fork = inspectUnverifiedCandidateCheckpointForks(
      snapshots.map(x => x.checkpoint),
    );
    if (fork.reason === "DENIED_CONFLICTING_CANDIDATE_TIPS" ||
        fork.reason === "DENIED_CANDIDATE_HASH_SCOPE_REUSE") {
      return diagnostic("DENIED_SUBMITTED_FORK_OR_HASH_REUSE");
    }
    if (!fork.candidateSubmittedSetInternallyConsistent) {
      return diagnostic("DENIED_INVALID_CANDIDATE_TIPS");
    }

    const groups = new Map<string, Map<number, SnapshotTip>>();
    for (const tip of snapshots) {
      const groupId = JSON.stringify([
        tip.principalId, tip.hostId, tip.sessionId,
      ]);
      let slots = groups.get(groupId);
      if (!slots) {
        slots = new Map<number, SnapshotTip>();
        groups.set(groupId, slots);
      }
      // Identical slot duplicates were already checked by the fork scanner.
      slots.set(tip.sequence, tip);
    }

    for (const slots of groups.values()) {
      const ordered = [...slots.values()].sort((a, b) => a.sequence - b.sequence);
      for (let i = 1; i < ordered.length; i++) {
        const prev = ordered[i - 1];
        const curr = ordered[i];
        if (!Number.isSafeInteger(prev.sequence + 1) ||
            curr.sequence !== prev.sequence + 1) {
          return diagnostic("DENIED_SUBMITTED_SEQUENCE_GAP");
        }
        if (curr.observedMs < prev.observedMs ||
            curr.signedMs < prev.signedMs ||
            curr.observedMs - prev.observedMs > MAX_OBSERVED_SILENCE_MS) {
          return diagnostic("DENIED_SUBMITTED_TIME_ROLLBACK_OR_SILENCE");
        }
      }
    }
    return diagnostic(
      "CANDIDATE_SUBMITTED_TIMELINE_ONLY",
      fork.uniqueSubmittedSlots,
    );
  } catch {
    return diagnostic("DENIED_INVALID_CANDIDATE_TIPS");
  }
}
