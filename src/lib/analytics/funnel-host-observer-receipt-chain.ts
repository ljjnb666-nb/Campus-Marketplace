import { createHash } from "node:crypto";
import type { CandidateFleetInstance } from "@/lib/analytics/funnel-fleet-roster-gap";
import type { UnverifiedHostLifecycleObservation } from "@/lib/analytics/funnel-host-lifecycle-replay";
import { prepareUnverifiedHostLifecycleClaim } from "@/lib/analytics/funnel-host-lifecycle-claim-journal";
import {
  hostObserverSigningBytes,
  verifyCandidateHostObserverSignature,
  type CandidateObserverKey,
  type CandidateSignedHostObservation,
} from "@/lib/analytics/funnel-host-observer-signature";

/**
 * 10K-R2d-03B-02B-02B-03: bounded, IN-MEMORY, negative-only diagnostic.
 * This is NOT an independent observer, persistent checkpoint, or production
 * anti-replay protocol. A caller can forge the entire key registry and chain.
 */
export type CandidateHostObserverReceipt = Readonly<{
  envelope: CandidateSignedHostObservation;
  previousReceiptHash: string | null;
  receiptHash: string;
}>;

export type CandidateReceiptChainReason =
  | "UNAVAILABLE_CANDIDATE_KEY_REGISTRY"
  | "DENIED_MALFORMED_CANDIDATE_CHAIN"
  | "DENIED_CANDIDATE_SIGNATURE"
  | "DENIED_RECEIPT_HASH_OR_PREDECESSOR"
  | "DENIED_SEQUENCE_GAP_OR_REPLAY"
  | "DENIED_SCOPE_OR_SESSION_BOUNDARY"
  | "DENIED_TIME_ROLLBACK_OR_SILENCE"
  | "CANDIDATE_SINGLE_SESSION_CHAIN_ONLY";

export type CandidateReceiptChainDiagnostic = Readonly<{
  reason: CandidateReceiptChainReason;
  candidateChainInternallyConsistent: boolean;
  independentProvisioningVerified: false;
  independentHostAuthenticated: false;
  deploymentMembershipComplete: false;
  captureContinuityProven: false;
  canPublish: false;
}>;

const HASH = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const MAX_LINKS = 512;
const MAX_INSTANCES = 128;
const MAX_OBSERVER_SILENCE_MS = 15 * 60_000;
const VERSION = "campus-marketplace-candidate-host-receipt/v1";

function result(
  reason: CandidateReceiptChainReason,
  consistent = false,
): CandidateReceiptChainDiagnostic {
  return {
    reason,
    candidateChainInternallyConsistent: consistent,
    independentProvisioningVerified: false,
    independentHostAuthenticated: false,
    deploymentMembershipComplete: false,
    captureContinuityProven: false,
    canPublish: false,
  };
}

function plainData(
  value: unknown, required: readonly string[], optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("INVALID_RECEIPT");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error("INVALID_RECEIPT");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(value).some(k => typeof k !== "string" || !allowed.has(k))) {
    throw new Error("INVALID_RECEIPT");
  }
  const copy: Record<string, unknown> = {};
  for (const k of required) {
    const d = descriptors[k];
    if (!d || !("value" in d)) throw new Error("INVALID_RECEIPT");
    copy[k] = d.value;
  }
  for (const k of optional) {
    const d = descriptors[k];
    if (d) {
      if (!("value" in d)) throw new Error("INVALID_RECEIPT");
      copy[k] = d.value;
    }
  }
  return copy;
}

function immutableDate(value: unknown): Date {
  if (!(value instanceof Date) || Object.getPrototypeOf(value) !== Date.prototype) {
    throw new Error("INVALID_RECEIPT");
  }
  const ms = Date.prototype.getTime.call(value);
  if (!Number.isFinite(ms) || ms < 0) throw new Error("INVALID_RECEIPT");
  return new Date(ms);
}

function cloneInstance(input: unknown): CandidateFleetInstance {
  const d = plainData(input, ["instanceId", "role", "releaseSha"]);
  return {
    instanceId: d.instanceId as string,
    role: d.role as CandidateFleetInstance["role"],
    releaseSha: d.releaseSha as string,
  };
}

/** Snapshot all machine-only fields and reject getters and extra metadata. */
function snapshotEnvelope(input: unknown): CandidateSignedHostObservation {
  const e = plainData(input, [
    "principalId", "keyId", "signedAt", "observation", "signatureBase64url",
  ]);
  const o = plainData(e.observation, [
    "origin", "hostId", "sessionId", "sequence", "observedAt", "kind",
  ], ["instance", "instances"]);
  let instances: CandidateFleetInstance[] | undefined;
  if (o.instances !== undefined) {
    if (!Array.isArray(o.instances) || o.instances.length > MAX_INSTANCES) {
      throw new Error("INVALID_RECEIPT");
    }
    instances = o.instances.map(item => cloneInstance(item));
  }
  const observation: UnverifiedHostLifecycleObservation = {
    origin: o.origin as UnverifiedHostLifecycleObservation["origin"],
    hostId: o.hostId as string,
    sessionId: o.sessionId as string,
    sequence: o.sequence as number,
    observedAt: immutableDate(o.observedAt),
    kind: o.kind as UnverifiedHostLifecycleObservation["kind"],
    ...(o.instance === undefined ? {} : { instance: cloneInstance(o.instance) }),
    ...(instances === undefined ? {} : { instances }),
  };
  return {
    principalId: e.principalId as string,
    keyId: e.keyId as string,
    signedAt: immutableDate(e.signedAt),
    observation,
    signatureBase64url: e.signatureBase64url as string,
  };
}

/**
 * Deterministic candidate link hash, NOT an authentication tag.
 * The tuple binds the previous hash, versioned canonical signed claim bytes,
 * and detached signature without storing a raw Docker event or credential.
 */
export function candidateHostReceiptHash(
  candidate: CandidateSignedHostObservation,
  previousReceiptHash: string | null,
): string {
  try {
    if (previousReceiptHash !== null &&
        (typeof previousReceiptHash !== "string" || !HASH.test(previousReceiptHash))) {
      throw new Error("INVALID_RECEIPT");
    }
    const envelope = snapshotEnvelope(candidate);
    if (typeof envelope.signatureBase64url !== "string" ||
        !SIGNATURE.test(envelope.signatureBase64url)) {
      throw new Error("INVALID_RECEIPT");
    }
    const bytes = hostObserverSigningBytes(envelope);
    return createHash("sha256").update(JSON.stringify([
      VERSION, previousReceiptHash, bytes.toString("base64url"),
      envelope.signatureBase64url,
    ])).digest("hex");
  } catch {
    throw new Error("HOST_OBSERVER_RECEIPT_INVALID");
  }
}

/**
 * Checks a proposed single-session chain only. Even a perfect result CANNOT
 * establish durable anti-replay, independent identity, fleet completeness,
 * outage-free capture, or permission to publish.
 */
export function auditCandidateHostReceiptChain(
  input: readonly CandidateHostObserverReceipt[],
  registry: ReadonlyMap<string, CandidateObserverKey> | null | undefined,
): CandidateReceiptChainDiagnostic {
  if (!registry) return result("UNAVAILABLE_CANDIDATE_KEY_REGISTRY");
  try {
    if (!Array.isArray(input) || input.length === 0 || input.length > MAX_LINKS) {
      return result("DENIED_MALFORMED_CANDIDATE_CHAIN");
    }
    let previousHash: string | null = null;
    let host: string | null = null;
    let session: string | null = null;
    let principal: string | null = null;
    let previousSequence = 0;
    let previousObserved = 0;
    let previousSigned = 0;

    for (const raw of input) {
      const row = plainData(raw, ["envelope", "previousReceiptHash", "receiptHash"]);
      const envelope = snapshotEnvelope(row.envelope);
      const claim = prepareUnverifiedHostLifecycleClaim(envelope.observation);
      if (typeof row.receiptHash !== "string" || !HASH.test(row.receiptHash) ||
          (row.previousReceiptHash !== null &&
           (typeof row.previousReceiptHash !== "string" ||
            !HASH.test(row.previousReceiptHash)))) {
        return result("DENIED_MALFORMED_CANDIDATE_CHAIN");
      }
      const crypto = verifyCandidateHostObserverSignature(envelope, registry);
      if (!crypto.cryptographicSignatureMatches) {
        return result("DENIED_CANDIDATE_SIGNATURE");
      }
      const expected = candidateHostReceiptHash(envelope, row.previousReceiptHash);
      if (row.receiptHash !== expected || row.previousReceiptHash !== previousHash) {
        return result("DENIED_RECEIPT_HASH_OR_PREDECESSOR");
      }
      const observed = claim.observedAt.getTime();
      const signed = envelope.signedAt.getTime();
      if (host === null) {
        if (claim.sequence !== BigInt(1) || claim.kind !== "BASELINE") {
          return result("DENIED_SEQUENCE_GAP_OR_REPLAY");
        }
        host = claim.hostId;
        session = claim.sessionId;
        principal = envelope.principalId;
      } else {
        if (claim.hostId !== host || claim.sessionId !== session ||
            envelope.principalId !== principal) {
          return result("DENIED_SCOPE_OR_SESSION_BOUNDARY");
        }
        if (claim.sequence !== BigInt(previousSequence + 1)) {
          return result("DENIED_SEQUENCE_GAP_OR_REPLAY");
        }
        if (observed < previousObserved || signed < previousSigned ||
            observed - previousObserved > MAX_OBSERVER_SILENCE_MS) {
          return result("DENIED_TIME_ROLLBACK_OR_SILENCE");
        }
      }
      previousSequence = Number(claim.sequence);
      previousObserved = observed;
      previousSigned = signed;
      previousHash = row.receiptHash;
    }
    return result("CANDIDATE_SINGLE_SESSION_CHAIN_ONLY", true);
  } catch {
    return result("DENIED_MALFORMED_CANDIDATE_CHAIN");
  }
}
