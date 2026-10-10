import { createHash, createPublicKey } from "node:crypto";
import type { CandidateObserverKey } from "@/lib/analytics/funnel-host-observer-signature";

/**
 * 10K-R2d-03B-02B-02B-02: candidate pin catalog, NOT independent enrollment.
 * A caller controls this input and can forge both its keys and fingerprints.
 * No signing private key, runtime transport or publication authority exists.
 */
export type ObserverKeyPinCandidate = Readonly<{
  principalId: string;
  hostId: string;
  keyId: string;
  publicKeyPem: string;
  spkiSha256: string;
  validFrom: Date;
  validUntil: Date;
  revoked: boolean;
}>;

export type CandidateObserverPinCatalog = Readonly<{
  status: "DENIED_INVALID_CANDIDATE_PINSET" | "CANDIDATE_PINSET_CONSISTENT_ONLY";
  pinCount: number;
  /** Returns a fresh key-epoch value; no mutable internal Map escapes. */
  getCandidateKey: (keyId: string) => CandidateObserverKey | undefined;
  independentProvisioningVerified: false;
  independentHostAuthenticated: false;
  deploymentMembershipComplete: false;
  captureContinuityProven: false;
  canPublish: false;
}>;

type InternalPin = Readonly<{
  principalId: string;
  hostId: string;
  keyId: string;
  publicKeyPem: string;
  validFromMs: number;
  validUntilMs: number;
  revoked: boolean;
}>;

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const FP = /^[0-9a-f]{64}$/;
const MAX_PINS = 128;
const KEYS = [
  "principalId", "hostId", "keyId", "publicKeyPem",
  "spkiSha256", "validFrom", "validUntil", "revoked",
] as const;

function readPlainCandidate(value: unknown): Record<(typeof KEYS)[number], unknown> {
  if (value === null || typeof value !== "object" ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
       Object.getPrototypeOf(value) !== null)) {
    throw new Error("OBSERVER_PINSET_INVALID");
  }
  // Reject secrets, labels, user metadata, symbol properties, and accessors.
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== KEYS.length) {
    throw new Error("OBSERVER_PINSET_INVALID");
  }
  const copied = {} as Record<(typeof KEYS)[number], unknown>;
  for (const field of KEYS) {
    const descriptor = descriptors[field];
    if (!descriptor || !("value" in descriptor)) {
      throw new Error("OBSERVER_PINSET_INVALID");
    }
    copied[field] = descriptor.value;
  }
  return copied;
}

function finiteTime(value: unknown): number {
  if (!(value instanceof Date) || Object.getPrototypeOf(value) !== Date.prototype) {
    throw new Error("OBSERVER_PINSET_INVALID");
  }
  const t = Date.prototype.getTime.call(value);
  if (!Number.isFinite(t) || t < 0) throw new Error("OBSERVER_PINSET_INVALID");
  return t;
}

function invalid(): CandidateObserverPinCatalog {
  return {
    status: "DENIED_INVALID_CANDIDATE_PINSET",
    pinCount: 0,
    getCandidateKey: () => undefined,
    independentProvisioningVerified: false,
    independentHostAuthenticated: false,
    deploymentMembershipComplete: false,
    captureContinuityProven: false,
    canPublish: false,
  };
}

/**
 * Checks candidate principal/host/key epoch and exact canonical Ed25519 SPKI
 * pinning, without granting authority to the caller-supplied pin manifest.
 * Pins are never persisted and cannot be used as an independent trust root.
 */
export function prepareCandidateObserverPinCatalog(input: unknown): CandidateObserverPinCatalog {
  try {
    // A proxy of an array can throw while reading length or iteration.
    // Bound checks belong inside this fail-closed exception boundary.
    if (!Array.isArray(input) || input.length < 1 || input.length > MAX_PINS) {
      return invalid();
    }
    const keys = new Map<string, InternalPin>();
    const fingerprints = new Set<string>();
    const principals = new Map<string, string>();

    for (const value of input) {
      const pin = readPlainCandidate(value);
      const { principalId, hostId, keyId, publicKeyPem, spkiSha256, revoked } = pin;
      if (typeof principalId !== "string" || !ID.test(principalId) ||
          typeof hostId !== "string" || !ID.test(hostId) ||
          typeof keyId !== "string" || !ID.test(keyId) ||
          typeof spkiSha256 !== "string" || !FP.test(spkiSha256) ||
          typeof publicKeyPem !== "string" ||
          publicKeyPem.length < 64 || publicKeyPem.length > 2048 ||
          revoked !== true && revoked !== false ||
          keys.has(keyId) || fingerprints.has(spkiSha256) ||
          (principals.has(principalId) && principals.get(principalId) !== hostId)) {
        return invalid();
      }
      // createPublicKey accepts private-key PEM too: explicitly require SPKI
      // PUBLIC KEY and the exact canonical PEM serialization.
      if (!publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----\n")) return invalid();
      const publicKey = createPublicKey(publicKeyPem);
      if (publicKey.asymmetricKeyType !== "ed25519") return invalid();
      const canonicalPem = publicKey.export({ type: "spki", format: "pem" }).toString();
      if (publicKeyPem !== canonicalPem) return invalid();
      const actualFingerprint = createHash("sha256")
        .update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
      if (actualFingerprint !== spkiSha256) return invalid();
      const validFromMs = finiteTime(pin.validFrom);
      const validUntilMs = finiteTime(pin.validUntil);
      if (validUntilMs <= validFromMs) return invalid();
      principals.set(principalId, hostId);
      fingerprints.add(spkiSha256);
      keys.set(keyId, {
        principalId, hostId, keyId, publicKeyPem,
        validFromMs, validUntilMs, revoked,
      });
    }
    return {
      status: "CANDIDATE_PINSET_CONSISTENT_ONLY",
      pinCount: keys.size,
      getCandidateKey: (keyId: string) => {
        if (typeof keyId !== "string") return undefined;
        const pin = keys.get(keyId);
        return pin ? {
          principalId: pin.principalId,
          hostId: pin.hostId,
          keyId: pin.keyId,
          publicKeyPem: pin.publicKeyPem,
          validFrom: new Date(pin.validFromMs),
          validUntil: new Date(pin.validUntilMs),
          revoked: pin.revoked,
        } : undefined;
      },
      independentProvisioningVerified: false,
      independentHostAuthenticated: false,
      deploymentMembershipComplete: false,
      captureContinuityProven: false,
      canPublish: false,
    };
  } catch {
    return invalid();
  }
}
