import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { UnverifiedHostLifecycleObservation } from "@/lib/analytics/funnel-host-lifecycle-replay";
import { prepareUnverifiedHostLifecycleClaim } from "@/lib/analytics/funnel-host-lifecycle-claim-journal";

/**
 * 10K-R2d-03B-02B-02B-01 — detached Ed25519 verification ONLY.
 *
 * A caller-provided public key is NOT an authoritative observer identity.
 * No production registry, private keys, ingress, durable replay checkpoint or
 * independent fleet census is created by this module.
 */
export type CandidateSignedHostObservation = Readonly<{
  principalId: string;
  keyId: string;
  signedAt: Date;
  observation: UnverifiedHostLifecycleObservation;
  signatureBase64url: string;
}>;

export type CandidateObserverKey = Readonly<{
  principalId: string;
  keyId: string;
  hostId: string;
  publicKeyPem: string;
  validFrom: Date;
  validUntil: Date;
  revoked: boolean;
}>;

export type ObserverSignatureReason =
  | "UNAVAILABLE_NO_INDEPENDENT_KEY_REGISTRY"
  | "DENIED_MALFORMED_ENVELOPE"
  | "DENIED_KEY_NOT_FOUND_OR_SCOPE"
  | "DENIED_KEY_EXPIRED_OR_REVOKED"
  | "DENIED_TIME_SKEW"
  | "DENIED_INVALID_PUBLIC_KEY_OR_SIGNATURE"
  | "CANDIDATE_SIGNATURE_MATCH_ONLY";

export type ObserverSignatureDiagnostic = Readonly<{
  reason: ObserverSignatureReason;
  cryptographicSignatureMatches: boolean;
  independentHostAuthenticated: false;
  deploymentMembershipComplete: false;
  captureContinuityProven: false;
  canPublish: false;
}>;

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SIGNATURE_BASE64URL = /^[A-Za-z0-9_-]{86}$/;
const MAX_SIGNED_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_OBSERVED_TO_SIGNED_MS = 15 * 60_000;

function finiteDate(v: unknown): v is Date {
  return v instanceof Date && Number.isFinite(v.getTime()) && v.getTime() >= 0;
}

function result(
  reason: ObserverSignatureReason,
  match = false,
): ObserverSignatureDiagnostic {
  return {
    reason,
    cryptographicSignatureMatches: match,
    independentHostAuthenticated: false,
    deploymentMembershipComplete: false,
    captureContinuityProven: false,
    canPublish: false,
  };
}

/**
 * Signing bytes are a versioned, unambiguous JSON tuple that binds observer
 * principal, key epoch, receipt time, and the fully canonicalized claim digest.
 * The digest is NOT independently sufficient to authenticate a host.
 *
 * This function never incorporates raw Docker payloads, metadata or secrets.
 */
type CanonicalSigningSnapshot = Readonly<{
  bytes: Buffer;
  principalId: string;
  keyId: string;
  hostId: string;
  signedAtMs: number;
  observedAtMs: number;
}>;

/**
 * Snapshot untrusted candidate fields only once. A later hostId getter or
 * mutation must never change the host scope being checked against the key:
 * it must be the hostId that was hashed into claimKey.
 */
/**
 * Read each allowlisted observation field once into plain data properties.
 * prepareUnverifiedHostLifecycleClaim validates this snapshot, not potentially
 * stateful getters on the original object. Copy only safe machine fields.
 */
function snapshotObservation(
  observation: UnverifiedHostLifecycleObservation,
): UnverifiedHostLifecycleObservation {
  const { origin, hostId, sessionId, sequence, observedAt, kind } = observation;
  const instance = observation.instance;
  const instances = observation.instances;
  const copyInstance = (row: typeof instance) => {
    if (!row) throw new Error("HOST_OBSERVER_INSTANCE_INVALID");
    const { instanceId, releaseSha, role } = row;
    return { instanceId, releaseSha, role };
  };
  return {
    origin, hostId, sessionId, sequence,
    observedAt: new Date(observedAt.getTime()), kind,
    ...(instance === undefined ? {} : { instance: copyInstance(instance) }),
    ...(instances === undefined ? {} : {
      instances: instances.map(row => copyInstance(row)),
    }),
  };
}

function canonicalSigningSnapshot(
  envelope: Pick<CandidateSignedHostObservation,
    "principalId" | "keyId" | "signedAt" | "observation">,
): CanonicalSigningSnapshot {
  if (!envelope) throw new Error("HOST_OBSERVER_SIGNING_ENVELOPE_INVALID");
  const { principalId, keyId, signedAt, observation } = envelope;
  if (typeof principalId !== "string" || !ID.test(principalId) ||
      typeof keyId !== "string" || !ID.test(keyId) ||
      !finiteDate(signedAt)) {
    throw new Error("HOST_OBSERVER_SIGNING_ENVELOPE_INVALID");
  }
  const signedAtMs = signedAt.getTime();
  const claim = prepareUnverifiedHostLifecycleClaim(snapshotObservation(observation));
  return {
    bytes: Buffer.from(JSON.stringify([
      "campus-marketplace-host-observer/v1",
      principalId,
      keyId,
      new Date(signedAtMs).toISOString(),
      claim.claimKey,
    ]), "utf8"),
    principalId,
    keyId,
    hostId: claim.hostId,
    signedAtMs,
    observedAtMs: claim.observedAt.getTime(),
  };
}

export function hostObserverSigningBytes(
  envelope: Pick<CandidateSignedHostObservation,
    "principalId" | "keyId" | "signedAt" | "observation">,
): Buffer {
  return canonicalSigningSnapshot(envelope).bytes;
}

/**
 * In-memory cryptographic candidate check. The key registry is passed in and
 * CAN BE FORGED by the caller; even a valid signature CANNOT set any
 * independent authentication / capture continuity / KPI flags to true.
 * Trusted principal provisioning and transport ingress are separate gates.
 */
export function verifyCandidateHostObserverSignature(
  envelope: CandidateSignedHostObservation,
  registry: ReadonlyMap<string, CandidateObserverKey> | null | undefined,
): ObserverSignatureDiagnostic {
  if (!registry) return result("UNAVAILABLE_NO_INDEPENDENT_KEY_REGISTRY");

  let snapshot: CanonicalSigningSnapshot;
  let signatureBase64url: string;
  try {
    signatureBase64url = envelope.signatureBase64url;
    if (typeof signatureBase64url !== "string" ||
        !SIGNATURE_BASE64URL.test(signatureBase64url)) {
      return result("DENIED_MALFORMED_ENVELOPE");
    }
    snapshot = canonicalSigningSnapshot(envelope);
  } catch {
    return result("DENIED_MALFORMED_ENVELOPE");
  }

  let key: CandidateObserverKey | undefined;
  try {
    key = registry.get(snapshot.keyId);
    if (!key || key.keyId !== snapshot.keyId ||
        key.principalId !== snapshot.principalId ||
        key.hostId !== snapshot.hostId) {
      return result("DENIED_KEY_NOT_FOUND_OR_SCOPE");
    }
  } catch {
    // A malformed caller-injected registry must not crash verification.
    return result("DENIED_KEY_NOT_FOUND_OR_SCOPE");
  }

  const now = Date.now();
  try {
    // The key must be valid at BOTH signing and checking time, with no grace.
    if (key.revoked !== false ||
        !finiteDate(key.validFrom) || !finiteDate(key.validUntil) ||
        key.validUntil.getTime() <= key.validFrom.getTime() ||
        snapshot.signedAtMs < key.validFrom.getTime() ||
        snapshot.signedAtMs >= key.validUntil.getTime() ||
        now < key.validFrom.getTime() ||
        now >= key.validUntil.getTime()) {
      return result("DENIED_KEY_EXPIRED_OR_REVOKED");
    }
  } catch {
    return result("DENIED_KEY_EXPIRED_OR_REVOKED");
  }

  // Never accept caller-controlled clocks or stale/implausible timestamps.
  if (Math.abs(now - snapshot.signedAtMs) > MAX_SIGNED_CLOCK_SKEW_MS ||
      snapshot.observedAtMs > snapshot.signedAtMs + MAX_SIGNED_CLOCK_SKEW_MS ||
      snapshot.signedAtMs - snapshot.observedAtMs > MAX_OBSERVED_TO_SIGNED_MS) {
    return result("DENIED_TIME_SKEW");
  }
  try {
    const signature = Buffer.from(signatureBase64url, "base64url");
    if (signature.length !== 64 ||
        signature.toString("base64url") !== signatureBase64url) {
      return result("DENIED_MALFORMED_ENVELOPE");
    }
    if (typeof key.publicKeyPem !== "string" ||
        key.publicKeyPem.length < 64 || key.publicKeyPem.length > 2048) {
      return result("DENIED_INVALID_PUBLIC_KEY_OR_SIGNATURE");
    }
    const publicKey = createPublicKey(key.publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519" ||
        !cryptoVerify(null, snapshot.bytes, publicKey, signature)) {
      return result("DENIED_INVALID_PUBLIC_KEY_OR_SIGNATURE");
    }
  } catch {
    return result("DENIED_INVALID_PUBLIC_KEY_OR_SIGNATURE");
  }
  return result("CANDIDATE_SIGNATURE_MATCH_ONLY", true);
}
