import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostObserverSigningBytes,
  verifyCandidateHostObserverSignature,
  type CandidateObserverKey,
  type CandidateSignedHostObservation,
} from "@/lib/analytics/funnel-host-observer-signature";
import type { UnverifiedHostLifecycleObservation } from
  "@/lib/analytics/funnel-host-lifecycle-replay";

const NOW = new Date("2026-10-10T06:00:00.000Z");
const SHA = "a".repeat(40);
const exampleObservation = (): UnverifiedHostLifecycleObservation => ({
  origin: "UNVERIFIED_HOST_OBSERVER",
  hostId: "host.01",
  sessionId: "boot.01",
  sequence: 1,
  observedAt: new Date(NOW.getTime() - 1_000),
  kind: "BASELINE",
  instances: [
    { instanceId: "app.01", role: "APP", releaseSha: SHA },
    { instanceId: "worker.01", role: "ASYNC_WORKER", releaseSha: SHA },
  ],
});

const signer = generateKeyPairSync("ed25519");
const secondSigner = generateKeyPairSync("ed25519");
const pub = signer.publicKey.export({ type: "spki", format: "pem" }).toString();

function pinned(): CandidateObserverKey {
  return {
    principalId: "observer.01", keyId: "key.01", hostId: "host.01",
    publicKeyPem: pub,
    validFrom: new Date(NOW.getTime() - 24 * 60 * 60_000),
    validUntil: new Date(NOW.getTime() + 24 * 60 * 60_000),
    revoked: false,
  };
}
function signed(
  changes: Partial<Omit<CandidateSignedHostObservation, "signatureBase64url">> = {},
  key = signer.privateKey,
): CandidateSignedHostObservation {
  const body = {
    principalId: "observer.01",
    keyId: "key.01",
    signedAt: NOW,
    observation: exampleObservation(),
    ...changes,
  };
  return {
    ...body, signatureBase64url: sign(null, hostObserverSigningBytes(body), key)
      .toString("base64url"),
  };
}
function verify(
  envelope: CandidateSignedHostObservation,
  key: CandidateObserverKey | null = pinned(),
) {
  return verifyCandidateHostObserverSignature(
    envelope, key ? new Map([[key.keyId, key]]) : null,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("10K-R2d-03B-02B-02B-01 observer signature: negative-only authority", () => {
  it("accepts a cryptographic match without establishing independent host identity", () => {
    expect(verify(signed())).toEqual({
      reason: "CANDIDATE_SIGNATURE_MATCH_ONLY",
      cryptographicSignatureMatches: true,
      independentHostAuthenticated: false,
      deploymentMembershipComplete: false,
      captureContinuityProven: false,
      canPublish: false,
    });
  });

  it("fails closed without a separately provisioned registry", () => {
    expect(verify(signed(), null).reason).toBe("UNAVAILABLE_NO_INDEPENDENT_KEY_REGISTRY");
  });

  it("rejects another principal and key epoch even with otherwise valid signatures", () => {
    const otherPrincipal = signed({ principalId: "observer.02" });
    const otherEpoch = signed({ keyId: "key.02" });
    expect(verify(otherPrincipal).reason).toBe("DENIED_KEY_NOT_FOUND_OR_SCOPE");
    expect(verify(otherEpoch).reason).toBe("DENIED_KEY_NOT_FOUND_OR_SCOPE");
  });

  it("binds the key's host scope to the claimed observation host", () => {
    const otherHost = signed({
      observation: { ...exampleObservation(), hostId: "host.02" },
    });
    expect(verify(otherHost).reason).toBe("DENIED_KEY_NOT_FOUND_OR_SCOPE");
    expect(verify(signed(), { ...pinned(), hostId: "host.02" }).reason)
      .toBe("DENIED_KEY_NOT_FOUND_OR_SCOPE");
  });

  it("rejects forged signatures and tampered payload after signing", () => {
    const forged = signed({}, secondSigner.privateKey);
    expect(verify(forged).reason).toBe("DENIED_INVALID_PUBLIC_KEY_OR_SIGNATURE");
    const original = signed();
    const changed = {
      ...original, observation: { ...original.observation, sequence: 2 },
    };
    expect(verify(changed).reason).toBe("DENIED_INVALID_PUBLIC_KEY_OR_SIGNATURE");
  });

  it("binds versioned signing bytes to full canonical instance roster", () => {
    const original = signed();
    const tampered = {
      ...original, observation: {
        ...original.observation, instances: [
          { instanceId: "app.01", role: "APP" as const, releaseSha: "b".repeat(40) },
        ],
      },
    };
    expect(verify(tampered).reason).toBe("DENIED_INVALID_PUBLIC_KEY_OR_SIGNATURE");
    expect(hostObserverSigningBytes(original).toString("utf8")).toContain("campus-marketplace-host-observer/v1");
  });

  it("rejects revoked and expired, or not-yet-valid observer key epochs", () => {
    expect(verify(signed(), { ...pinned(), revoked: true }).reason)
      .toBe("DENIED_KEY_EXPIRED_OR_REVOKED");
    expect(verify(signed(), {
      ...pinned(), validUntil: new Date(NOW.getTime()),
    }).reason).toBe("DENIED_KEY_EXPIRED_OR_REVOKED");
    expect(verify(signed(), {
      ...pinned(), validFrom: new Date(NOW.getTime() + 1_000),
    }).reason).toBe("DENIED_KEY_EXPIRED_OR_REVOKED");
  });

  it("rejects a signed-before-expiry payload after the key expires", () => {
    // A once-valid signature is not eligible for a grace period after
    // key expiry, even when its signedAt is inside the 5-minute skew window.
    const beforeExpiry = signed({
      signedAt: new Date(NOW.getTime() - 30_000),
    });
    const alreadyExpired = {
      ...pinned(), validUntil: new Date(NOW.getTime() - 1),
    };
    expect(verify(beforeExpiry, alreadyExpired).reason)
      .toBe("DENIED_KEY_EXPIRED_OR_REVOKED");
    // The end is exclusive even when signedAt was legitimately in range.
    const atBoundary = { ...pinned(), validUntil: new Date(NOW) };
    expect(verify(beforeExpiry, atBoundary).reason)
      .toBe("DENIED_KEY_EXPIRED_OR_REVOKED");
  });

  it("rejects oversized or non-string PEM from an injected registry", () => {
    expect(verify(signed(), {
      ...pinned(), publicKeyPem: "x".repeat(2049),
    }).reason).toBe("DENIED_INVALID_PUBLIC_KEY_OR_SIGNATURE");
    expect(verify(signed(), {
      ...pinned(), publicKeyPem: null as unknown as string,
    }).reason).toBe("DENIED_INVALID_PUBLIC_KEY_OR_SIGNATURE");
  });

  it("rejects malformed public key and wrong asymmetric algorithm", () => {
    expect(verify(signed(), {
      ...pinned(), publicKeyPem: "not a key",
    }).reason).toBe("DENIED_INVALID_PUBLIC_KEY_OR_SIGNATURE");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(verify(signed(), {
      ...pinned(), publicKeyPem: rsa.publicKey.export({
        format: "pem", type: "spki",
      }).toString(),
    }).reason).toBe("DENIED_INVALID_PUBLIC_KEY_OR_SIGNATURE");
  });

  it("rejects stale and future signed envelopes using the runtime clock", () => {
    const stale = signed({ signedAt: new Date(NOW.getTime() - 5 * 60_000 - 1) });
    const future = signed({ signedAt: new Date(NOW.getTime() + 5 * 60_000 + 1) });
    expect(verify(stale).reason).toBe("DENIED_TIME_SKEW");
    expect(verify(future).reason).toBe("DENIED_TIME_SKEW");
  });

  it("refuses observation timestamps not plausibly tied to the signed event", () => {
    const ancient = signed({
      observation: { ...exampleObservation(),
        observedAt: new Date(NOW.getTime() - 15 * 60_000 - 1) },
    });
    const futureObservation = signed({
      observation: { ...exampleObservation(),
        observedAt: new Date(NOW.getTime() + 5 * 60_000 + 1) },
    });
    expect(verify(ancient).reason).toBe("DENIED_TIME_SKEW");
    expect(verify(futureObservation).reason).toBe("DENIED_TIME_SKEW");
  });

  it("rejects malformed or noncanonical signatures and observation shape", () => {
    const original = signed();
    expect(verify({ ...original, signatureBase64url: "AA===" }).reason)
      .toBe("DENIED_MALFORMED_ENVELOPE");
    expect(verify({
      ...original, observation: { ...original.observation, hostId: "../spoof" },
    }).reason).toBe("DENIED_MALFORMED_ENVELOPE");
    expect(verify({
      ...original, signedAt: new Date("bad"),
    }).reason).toBe("DENIED_MALFORMED_ENVELOPE");
  });

  it("does not sign arbitrary baseline metadata or expose a secret", () => {
    const observation = {
      ...exampleObservation(), instances: [{
        instanceId: "app.01", releaseSha: SHA, role: "APP" as const,
        email: "secret-user@example.com", accessKey: "not-for-signing",
      }],
    };
    const content = hostObserverSigningBytes({
      principalId: "observer.01", keyId: "key.01", signedAt: NOW, observation,
    }).toString("utf8");
    expect(content).not.toContain("secret-user@example.com");
    expect(content).not.toContain("not-for-signing");
  });

  it("a repeated valid signature is NOT evidence of replay protection", () => {
    const same = signed();
    expect(verify(same).cryptographicSignatureMatches).toBe(true);
    expect(verify(same).cryptographicSignatureMatches).toBe(true);
    expect(verify(same).canPublish).toBe(false);
    // Durable nonce/sequence authority and independent host provisioning
    // MUST be reviewed in a separate ingestion/credential stage.
  });
  it("binds the pinned host to the SAME claim snapshot that was signed", () => {
    // Stateful getters can change during normalization or after it. Neither
    // the claim digest nor the key-scope comparison may use a second hostId.
    for (const switchAfter of [3, 4]) {
      const original = signed();
      let reads = 0;
      const observation = { ...original.observation };
      Object.defineProperty(observation, "hostId", {
        enumerable: true,
        get: () => (++reads <= switchAfter ? "host.01" : "host.02"),
      });
      const outcome = verify(
        { ...original, observation },
        { ...pinned(), hostId: "host.02" },
      );
      expect(outcome.reason).toBe("DENIED_KEY_NOT_FOUND_OR_SCOPE");
      expect(outcome.cryptographicSignatureMatches).toBe(false);
      expect(outcome.canPublish).toBe(false);
      expect(reads).toBe(1);
    }
  });

  it("rejects malformed or throwing caller-injected key registries without leaking", () => {
    const envelope = signed();
    const exploding = {
      get: () => { throw new Error("secret-registry-value"); },
    } as unknown as ReadonlyMap<string, CandidateObserverKey>;
    const malformed = {} as ReadonlyMap<string, CandidateObserverKey>;
    for (const registry of [exploding, malformed]) {
      const output = verifyCandidateHostObserverSignature(envelope, registry);
      expect(output.reason).toBe("DENIED_KEY_NOT_FOUND_OR_SCOPE");
      expect(output.cryptographicSignatureMatches).toBe(false);
      expect(output.independentHostAuthenticated).toBe(false);
      expect(output.canPublish).toBe(false);
      expect(JSON.stringify(output)).not.toContain("secret-registry-value");
    }
  });

});
