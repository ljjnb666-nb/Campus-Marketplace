import type { UnverifiedCandidateReceiptCheckpoint } from
  "@/lib/analytics/funnel-host-observer-candidate-checkpoint";

/**
 * Phase 10K-R2d-03B-02B-02B-05 — compare UNVERIFIED caller-submitted
 * checkpoint tips in one bounded set. No DB read/write, durable CAS,
 * independent observer, replay protection or publication permission.
 */
export type CandidateForkScanReason =
  | "DENIED_MALFORMED_CANDIDATE_TIP_SET"
  | "DENIED_CONFLICTING_CANDIDATE_TIPS"
  | "DENIED_CANDIDATE_HASH_SCOPE_REUSE"
  | "CANDIDATE_SUBMITTED_TIPS_NO_CONFLICT_ONLY";

export type CandidateForkScanDiagnostic = Readonly<{
  reason: CandidateForkScanReason;
  /** True only for this one supplied set; does NOT prove no hidden fork. */
  candidateSubmittedSetInternallyConsistent: boolean;
  uniqueSubmittedSlots: number;
  independentProvisioningVerified: false;
  independentHostAuthenticated: false;
  deploymentMembershipComplete: false;
  captureContinuityProven: false;
  canPublish: false;
}>;

type NormalizedTip = Readonly<{
  principalId: string;
  hostId: string;
  sessionId: string;
  sequence: number;
  lastReceiptHash: string;
  observedMs: number;
  signedMs: number;
}>;

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_TIPS = 128;
const MAX_FUTURE_OBSERVATION_SKEW = 5 * 60_000;
const FIELDS = [
  "source", "principalId", "hostId", "sessionId", "sequence",
  "lastReceiptHash", "observedAt", "signedAt",
] as const;

function denied(reason: CandidateForkScanReason): CandidateForkScanDiagnostic {
  return {
    reason,
    candidateSubmittedSetInternallyConsistent: false,
    uniqueSubmittedSlots: 0,
    independentProvisioningVerified: false,
    independentHostAuthenticated: false,
    deploymentMembershipComplete: false,
    captureContinuityProven: false,
    canPublish: false,
  };
}

function dateValue(value: unknown): number {
  // Native internal-slot check allows genuine pre-fake-timer Dates and
  // rejects impostors or Proxy(Date). No user-defined getTime is invoked.
  let time: number;
  try {
    time = Date.prototype.getTime.call(value);
  } catch {
    throw new Error("INVALID_CANDIDATE_TIP");
  }
  if (!Number.isFinite(time) || time < 0) {
    throw new Error("INVALID_CANDIDATE_TIP");
  }
  return time;
}

function normalizeTip(value: unknown): NormalizedTip {
  if (value === null || typeof value !== "object") {
    throw new Error("INVALID_CANDIDATE_TIP");
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error("INVALID_CANDIDATE_TIP");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== FIELDS.length) {
    throw new Error("INVALID_CANDIDATE_TIP");
  }
  const values: Record<string, unknown> = {};
  for (const field of FIELDS) {
    const d = descriptors[field];
    if (!d || !("value" in d)) throw new Error("INVALID_CANDIDATE_TIP");
    values[field] = d.value;
  }
  const {
    source, principalId, hostId, sessionId, sequence, lastReceiptHash,
    observedAt, signedAt,
  } = values;
  if (source !== "UNVERIFIED_CANDIDATE" ||
      typeof principalId !== "string" || !ID.test(principalId) ||
      typeof hostId !== "string" || !ID.test(hostId) ||
      typeof sessionId !== "string" || !ID.test(sessionId) ||
      !Number.isSafeInteger(sequence) || (sequence as number) < 1 ||
      typeof lastReceiptHash !== "string" || !HASH.test(lastReceiptHash)) {
    throw new Error("INVALID_CANDIDATE_TIP");
  }
  const observedMs = dateValue(observedAt);
  const signedMs = dateValue(signedAt);
  if (observedMs > signedMs + MAX_FUTURE_OBSERVATION_SKEW) {
    throw new Error("INVALID_CANDIDATE_TIP");
  }
  return {
    principalId, hostId, sessionId, sequence: sequence as number,
    lastReceiptHash, observedMs, signedMs,
  };
}

/**
 * Reconcile only the explicitly supplied candidate checkpoint tips.
 * Identical copies collapse; contradictory hashes or timestamps under
 * the SAME principal/host/session/sequence are flagged as a candidate fork.
 * Reusing a tip hash across distinct scopes/sequence numbers is also denied.
 *
 * This function does NOT authenticate the submitted tips, enforce a global
 * uniqueness constraint, find omitted branches, or atomically accept a tip.
 * Two forks submitted in separate calls can EACH appear consistent.
 */
export function inspectUnverifiedCandidateCheckpointForks(
  input: readonly UnverifiedCandidateReceiptCheckpoint[],
): CandidateForkScanDiagnostic {
  try {
    if (!Array.isArray(input) || input.length < 1 || input.length > MAX_TIPS) {
      return denied("DENIED_MALFORMED_CANDIDATE_TIP_SET");
    }

    // JSON tuples avoid collisions from permitted punctuation in IDs.
    const slots = new Map<string, NormalizedTip>();
    const byReceiptHash = new Map<string, string>();

    for (const raw of input) {
      const tip = normalizeTip(raw);
      const slot = JSON.stringify([
        tip.principalId, tip.hostId, tip.sessionId, tip.sequence,
      ]);
      const prior = slots.get(slot);
      if (prior &&
          (prior.lastReceiptHash !== tip.lastReceiptHash ||
           prior.observedMs !== tip.observedMs ||
           prior.signedMs !== tip.signedMs)) {
        return denied("DENIED_CONFLICTING_CANDIDATE_TIPS");
      }
      const priorSlot = byReceiptHash.get(tip.lastReceiptHash);
      if (priorSlot !== undefined && priorSlot !== slot) {
        return denied("DENIED_CANDIDATE_HASH_SCOPE_REUSE");
      }
      slots.set(slot, tip);
      byReceiptHash.set(tip.lastReceiptHash, slot);
    }

    return {
      reason: "CANDIDATE_SUBMITTED_TIPS_NO_CONFLICT_ONLY",
      candidateSubmittedSetInternallyConsistent: true,
      uniqueSubmittedSlots: slots.size,
      independentProvisioningVerified: false,
      independentHostAuthenticated: false,
      deploymentMembershipComplete: false,
      captureContinuityProven: false,
      canPublish: false,
    };
  } catch {
    return denied("DENIED_MALFORMED_CANDIDATE_TIP_SET");
  }
}
