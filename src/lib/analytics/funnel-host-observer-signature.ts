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
export function hostObserverSigningBytes(
  envelope: Pick<CandidateSignedHostObservation,
    "principalId" | "keyId" | "signedAt" | "observation">,
): Buffer {
  if (!envelope || typeof envelope.principalId !== "string" ||
      !ID.test(envelope.principalId) ||
      typeof envelope.keyId !== "string" || !ID.test(envelope.keyId) ||
      !finiteDate(envelope.signedAt)) {
    throw new Error("HOST_OBSERVER_SIGNING_ENVELOPE_INVALID");
  }
  const claim = prepareUnverifiedHostLifecycleClaim(envelope.observation);
  return Buffer.from(JSON.stringify([
    "campus-marketplace-host-observer/v1",
    envelope.principalId,
    envelope.keyId,
    envelope.signedAt.toISOString(),
    claim.claimKey,
  ]), "utf8");
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
  if (!envelope || !finiteDate(envelope.signedAt) ||
      typeof envelope.signatureBase64url !== "string" ||
      !SIGNATURE_BASE64URL.test(envelope.signatureBase64url)) {
    return result("DENIED_MALFORMED_ENVELOPE");
  }

  let bytes: Buffer;
  try {
    bytes = hostObserverSigningBytes(envelope);
  } catch {
    return result("DENIED_MALFORMED_ENVELOPE");
  }

  const key = registry.get(envelope.keyId);
  if (!key || key.keyId !== envelope.keyId ||
      key.principalId !== envelope.principalId ||
      key.hostId !== envelope.observation.hostId) {
    return result("DENIED_KEY_NOT_FOUND_OR_SCOPE");
  }
  if (key.revoked !== false ||
      !finiteDate(key.validFrom) || !finiteDate(key.validUntil) ||
      key.validUntil.getTime() <= key.validFrom.getTime() ||
      envelope.signedAt.getTime() < key.validFrom.getTime() ||
      envelope.signedAt.getTime() >= key.validUntil.getTime()) {
    return result("DENIED_KEY_EXPIRED_OR_REVOKED");
  }
  // No caller-controlled 'now' or tolerance. No acceptance of stale replay
  // just because a caller can supply a signed timestamp from the past.
  const now = Date.now();
  const signed = envelope.signedAt.getTime();
  const observed = envelope.observation.observedAt.getTime();
  if (Math.abs(now - signed) > MAX_SIGNED_CLOCK_SKEW_MS ||
      observed > signed + MAX_SIGNED_CLOCK_SKEW_MS ||
      signed - observed > MAX_OBSERVED_TO_SIGNED_MS) {
    return result("DENIED_TIME_SKEW");
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(envelope.signatureBase64url, "base64url");
    if (signature.length !== 64 ||
        signature.toString("base64url") !== envelope.signatureBase64url) {
      return result("DENIED_MALFORMED_ENVELOPE");
    }
    const publicKey = createPublicKey(key.publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") {
      return result("DENIED_INVALID_PUBLIC_KEY_OR_SIGNATURE");
    }
    if (!cryptoVerify(null, bytes, publicKey, signature)) {
      return result("DENIED_INVALID_PUBLIC_KEY_OR_SIGNATURE");
    }
  } catch {
    return result("DENIED_INVALID_PUBLIC_KEY_OR_SIGNATURE");
  }
  return result("CANDIDATE_SIGNATURE_MATCH_ONLY", true);
}
