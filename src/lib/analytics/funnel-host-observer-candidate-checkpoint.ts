import type { CandidateFleetInstance } from "@/lib/analytics/funnel-fleet-roster-gap";
import type { UnverifiedHostLifecycleObservation } from "@/lib/analytics/funnel-host-lifecycle-replay";
import {
  candidateHostReceiptHash,
  type CandidateHostObserverReceipt,
} from "@/lib/analytics/funnel-host-observer-receipt-chain";
import {
  verifyCandidateHostObserverSignature,
  type CandidateObserverKey,
  type CandidateSignedHostObservation,
} from "@/lib/analytics/funnel-host-observer-signature";
import { prepareUnverifiedHostLifecycleClaim } from "@/lib/analytics/funnel-host-lifecycle-claim-journal";

/**
 * Phase 10K-R2d-03B-02B-02B-04: in-memory checkpoint TRANSITION PROPOSAL.
 * Even a successful transition is NOT independently verified, recorded,
 * durable, crash-safe, or a production anti-replay / identity mechanism.
 */
export type UnverifiedCandidateReceiptCheckpoint = Readonly<{
  source: "UNVERIFIED_CANDIDATE";
  principalId: string;
  hostId: string;
  sessionId: string;
  sequence: number;
  lastReceiptHash: string;
  observedAt: Date;
  signedAt: Date;
}>;

export type CandidateCheckpointReason =
  | "UNAVAILABLE_CANDIDATE_KEY_REGISTRY"
  | "DENIED_INVALID_CANDIDATE_CHECKPOINT_OR_RECEIPTS"
  | "DENIED_CANDIDATE_SIGNATURE"
  | "DENIED_PREDECESSOR_OR_RECEIPT_HASH"
  | "DENIED_SEQUENCE_GAP_OR_REPLAY"
  | "DENIED_HOST_SESSION_OR_PRINCIPAL_CHANGE"
  | "DENIED_DISCONNECTED_OR_BASELINE_RESET"
  | "DENIED_CLOCK_ROLLBACK_OR_SILENCE"
  | "CANDIDATE_CHECKPOINT_PROPOSAL_ONLY";

export type CandidateCheckpointDiagnostic = Readonly<{
  reason: CandidateCheckpointReason;
  candidateIncrementInternallyConsistent: boolean;
  proposedCheckpoint: UnverifiedCandidateReceiptCheckpoint | null;
  independentProvisioningVerified: false;
  independentHostAuthenticated: false;
  deploymentMembershipComplete: false;
  captureContinuityProven: false;
  canPublish: false;
}>;

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_BATCH = 256;
const MAX_BASELINE = 128;
const MAX_SILENCE_MS = 15 * 60_000;

function outcome(
  reason: CandidateCheckpointReason,
  proposal: UnverifiedCandidateReceiptCheckpoint | null = null,
): CandidateCheckpointDiagnostic {
  return {
    reason,
    candidateIncrementInternallyConsistent: proposal !== null,
    proposedCheckpoint: proposal,
    independentProvisioningVerified: false,
    independentHostAuthenticated: false,
    deploymentMembershipComplete: false,
    captureContinuityProven: false,
    canPublish: false,
  };
}

function snapshotRecord(
  input: unknown, required: readonly string[], optional: readonly string[] = [],
): Record<string, unknown> {
  if (!input || typeof input !== "object") throw new Error("CHECKPOINT_INVALID");
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) throw new Error("CHECKPOINT_INVALID");
  const desc = Object.getOwnPropertyDescriptors(input);
  const permitted = new Set([...required, ...optional]);
  if (Reflect.ownKeys(input).some(k => typeof k !== "string" || !permitted.has(k))) {
    throw new Error("CHECKPOINT_INVALID");
  }
  const result: Record<string, unknown> = {};
  for (const name of required) {
    if (!desc[name] || !("value" in desc[name])) throw new Error("CHECKPOINT_INVALID");
    result[name] = desc[name].value;
  }
  for (const name of optional) {
    if (desc[name]) {
      if (!("value" in desc[name])) throw new Error("CHECKPOINT_INVALID");
      result[name] = desc[name].value;
    }
  }
  return result;
}

function copyDate(value: unknown): Date {
  let at: number;
  try {
    at = Date.prototype.getTime.call(value);
  } catch {
    throw new Error("CHECKPOINT_INVALID");
  }
  if (!Number.isFinite(at) || at < 0) throw new Error("CHECKPOINT_INVALID");
  return new Date(at);
}

function copyInstance(value: unknown): CandidateFleetInstance {
  const r = snapshotRecord(value, ["instanceId", "releaseSha", "role"]);
  return {
    instanceId: r.instanceId as string,
    releaseSha: r.releaseSha as string,
    role: r.role as CandidateFleetInstance["role"],
  };
}

function snapshotReceipt(input: unknown): CandidateHostObserverReceipt {
  const row = snapshotRecord(input, ["envelope", "previousReceiptHash", "receiptHash"]);
  const e = snapshotRecord(row.envelope, [
    "principalId", "keyId", "signedAt", "observation", "signatureBase64url",
  ]);
  const o = snapshotRecord(e.observation, [
    "origin", "hostId", "sessionId", "sequence", "observedAt", "kind",
  ], ["instance", "instances"]);
  let instances: readonly CandidateFleetInstance[] | undefined;
  if (o.instances !== undefined) {
    if (!Array.isArray(o.instances) || o.instances.length > MAX_BASELINE) {
      throw new Error("CHECKPOINT_INVALID");
    }
    instances = o.instances.map(x => copyInstance(x));
  }
  const observation: UnverifiedHostLifecycleObservation = {
    origin: o.origin as UnverifiedHostLifecycleObservation["origin"],
    hostId: o.hostId as string,
    sessionId: o.sessionId as string,
    sequence: o.sequence as number,
    observedAt: copyDate(o.observedAt),
    kind: o.kind as UnverifiedHostLifecycleObservation["kind"],
    ...(o.instance === undefined ? {} : { instance: copyInstance(o.instance) }),
    ...(instances === undefined ? {} : { instances }),
  };
  const envelope: CandidateSignedHostObservation = {
    principalId: e.principalId as string,
    keyId: e.keyId as string,
    signedAt: copyDate(e.signedAt),
    observation,
    signatureBase64url: e.signatureBase64url as string,
  };
  return {
    envelope,
    previousReceiptHash: row.previousReceiptHash as string | null,
    receiptHash: row.receiptHash as string,
  };
}

function snapshotCheckpoint(value: unknown): UnverifiedCandidateReceiptCheckpoint {
  const row = snapshotRecord(value, [
    "source", "principalId", "hostId", "sessionId", "sequence",
    "lastReceiptHash", "observedAt", "signedAt",
  ]);
  if (row.source !== "UNVERIFIED_CANDIDATE" ||
      typeof row.principalId !== "string" || !ID.test(row.principalId) ||
      typeof row.hostId !== "string" || !ID.test(row.hostId) ||
      typeof row.sessionId !== "string" || !ID.test(row.sessionId) ||
      !Number.isSafeInteger(row.sequence) || (row.sequence as number) < 1 ||
      typeof row.lastReceiptHash !== "string" || !HASH.test(row.lastReceiptHash)) {
    throw new Error("CHECKPOINT_INVALID");
  }
  const observedAt = copyDate(row.observedAt);
  const signedAt = copyDate(row.signedAt);
  if (observedAt.getTime() > signedAt.getTime() + 5 * 60_000) {
    throw new Error("CHECKPOINT_INVALID");
  }
  return {
    source: "UNVERIFIED_CANDIDATE",
    principalId: row.principalId,
    hostId: row.hostId,
    sessionId: row.sessionId,
    sequence: row.sequence as number,
    lastReceiptHash: row.lastReceiptHash,
    observedAt,
    signedAt,
  };
}

/**
 * Validate one near-real-time candidate batch relative to an optional
 * caller-supplied checkpoint. No persistence or trusted checkpoint authority
 * is created here. The caller can forge both the prior state and all keys.
 * Each returned proposal is a new machine-only immutable-shape value.
 */
export function proposeUnverifiedCandidateCheckpointAdvance(input: Readonly<{
  previous: UnverifiedCandidateReceiptCheckpoint | null;
  receipts: readonly CandidateHostObserverReceipt[];
  registry: ReadonlyMap<string, CandidateObserverKey> | null | undefined;
}>): CandidateCheckpointDiagnostic {
  try {
    const args = snapshotRecord(input, ["previous", "receipts", "registry"]);
    if (!args.registry) return outcome("UNAVAILABLE_CANDIDATE_KEY_REGISTRY");
    if (!Array.isArray(args.receipts) || args.receipts.length < 1 ||
        args.receipts.length > MAX_BATCH) {
      return outcome("DENIED_INVALID_CANDIDATE_CHECKPOINT_OR_RECEIPTS");
    }
    let checkpoint = args.previous === null ? null : snapshotCheckpoint(args.previous);
    for (const raw of args.receipts) {
      const row = snapshotReceipt(raw);
      const { envelope } = row;
      const claim = prepareUnverifiedHostLifecycleClaim(envelope.observation);
      if (typeof row.receiptHash !== "string" || !HASH.test(row.receiptHash) ||
          (row.previousReceiptHash !== null &&
           (typeof row.previousReceiptHash !== "string" ||
            !HASH.test(row.previousReceiptHash)))) {
        return outcome("DENIED_INVALID_CANDIDATE_CHECKPOINT_OR_RECEIPTS");
      }
      const signature = verifyCandidateHostObserverSignature(
        envelope, args.registry as ReadonlyMap<string, CandidateObserverKey>,
      );
      if (!signature.cryptographicSignatureMatches) {
        return outcome("DENIED_CANDIDATE_SIGNATURE");
      }
      const expected = candidateHostReceiptHash(envelope, row.previousReceiptHash);
      if (expected !== row.receiptHash ||
          row.previousReceiptHash !== (checkpoint?.lastReceiptHash ?? null)) {
        return outcome("DENIED_PREDECESSOR_OR_RECEIPT_HASH");
      }
      // A disconnect is an explicit observation gap, never checkpoint
      // continuity. A subsequent baseline is not the same boot-session
      // continuity: it requires a separately reviewed recovery boundary.
      if (claim.kind === "DISCONNECTED" ||
          (checkpoint !== null && claim.kind === "BASELINE")) {
        return outcome("DENIED_DISCONNECTED_OR_BASELINE_RESET");
      }
      if (checkpoint === null) {
        if (claim.sequence !== BigInt(1) || claim.kind !== "BASELINE") {
          return outcome("DENIED_SEQUENCE_GAP_OR_REPLAY");
        }
      } else {
        if (claim.hostId !== checkpoint.hostId ||
            claim.sessionId !== checkpoint.sessionId ||
            envelope.principalId !== checkpoint.principalId) {
          return outcome("DENIED_HOST_SESSION_OR_PRINCIPAL_CHANGE");
        }
        if (!Number.isSafeInteger(checkpoint.sequence + 1) ||
            claim.sequence !== BigInt(checkpoint.sequence + 1)) {
          return outcome("DENIED_SEQUENCE_GAP_OR_REPLAY");
        }
        const observed = claim.observedAt.getTime();
        if (observed < checkpoint.observedAt.getTime() ||
            envelope.signedAt.getTime() < checkpoint.signedAt.getTime() ||
            observed - checkpoint.observedAt.getTime() > MAX_SILENCE_MS) {
          return outcome("DENIED_CLOCK_ROLLBACK_OR_SILENCE");
        }
      }
      checkpoint = {
        source: "UNVERIFIED_CANDIDATE",
        principalId: envelope.principalId,
        hostId: claim.hostId,
        sessionId: claim.sessionId,
        sequence: Number(claim.sequence),
        lastReceiptHash: row.receiptHash,
        observedAt: new Date(claim.observedAt.getTime()),
        signedAt: new Date(envelope.signedAt.getTime()),
      };
    }
    return outcome("CANDIDATE_CHECKPOINT_PROPOSAL_ONLY", checkpoint);
  } catch {
    return outcome("DENIED_INVALID_CANDIDATE_CHECKPOINT_OR_RECEIPTS");
  }
}
