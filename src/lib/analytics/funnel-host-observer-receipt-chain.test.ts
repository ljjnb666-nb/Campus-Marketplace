import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnverifiedHostLifecycleObservation } from "@/lib/analytics/funnel-host-lifecycle-replay";
import {
  hostObserverSigningBytes,
  type CandidateObserverKey,
  type CandidateSignedHostObservation,
} from "@/lib/analytics/funnel-host-observer-signature";
import {
  auditCandidateHostReceiptChain,
  candidateHostReceiptHash,
  type CandidateHostObserverReceipt,
} from "@/lib/analytics/funnel-host-observer-receipt-chain";

const NOW = new Date("2026-10-10T06:00:00.000Z");
const pair = generateKeyPairSync("ed25519");
const rotated = generateKeyPairSync("ed25519");
const forged = generateKeyPairSync("ed25519");
const APP = { instanceId: "app.01", role: "APP" as const, releaseSha: "a".repeat(40) };
const WORKER = { instanceId: "worker.01", role: "ASYNC_WORKER" as const, releaseSha: "a".repeat(40) };

function baseline(
  observedAt = new Date(NOW.getTime() - 2_000),
): UnverifiedHostLifecycleObservation {
  return {
    origin: "UNVERIFIED_HOST_OBSERVER", hostId: "host.01", sessionId: "boot.01",
    sequence: 1, observedAt, kind: "BASELINE", instances: [APP, WORKER],
  };
}
function heartbeat(
  sequence = 2, observedAt = new Date(NOW.getTime() - 500),
): UnverifiedHostLifecycleObservation {
  return {
    origin: "UNVERIFIED_HOST_OBSERVER", hostId: "host.01", sessionId: "boot.01",
    sequence, observedAt, kind: "HEARTBEAT",
  };
}

function pin(
  keyId = "key.01", publicKey = pair.publicKey, changes: Partial<CandidateObserverKey> = {},
): CandidateObserverKey {
  return {
    principalId: "observer.01", keyId, hostId: "host.01",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    validFrom: new Date(NOW.getTime() - 86_400_000),
    validUntil: new Date(NOW.getTime() + 86_400_000),
    revoked: false,
    ...changes,
  };
}
const registry = () => new Map<string, CandidateObserverKey>([["key.01", pin()]]);
function make(
  observation: UnverifiedHostLifecycleObservation,
  previousReceiptHash: string | null = null,
  options: {
    keyId?: string;
    principalId?: string;
    signer?: typeof pair;
    signedAt?: Date;
  } = {},
): CandidateHostObserverReceipt {
  const signed = {
    principalId: options.principalId ?? "observer.01",
    keyId: options.keyId ?? "key.01",
    signedAt: options.signedAt ?? NOW,
    observation,
  };
  const envelope: CandidateSignedHostObservation = {
    ...signed,
    signatureBase64url: sign(null, hostObserverSigningBytes(signed),
      (options.signer ?? pair).privateKey).toString("base64url"),
  };
  return {
    envelope, previousReceiptHash,
    receiptHash: candidateHostReceiptHash(envelope, previousReceiptHash),
  };
}
const chain = () => {
  const a = make(baseline());
  return [a, make(heartbeat(), a.receiptHash)];
};
const check = (
  links: readonly CandidateHostObserverReceipt[],
  keys: ReadonlyMap<string, CandidateObserverKey> | null = registry(),
) => auditCandidateHostReceiptChain(links, keys);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("10K-R2d-03B-02B-02B-03 candidate signed receipt chain", () => {
  it("matches a deterministic two-link chain but grants absolutely no authority", () => {
    const rows = chain();
    const output = check(rows);
    expect(output).toEqual({
      reason: "CANDIDATE_SINGLE_SESSION_CHAIN_ONLY",
      candidateChainInternallyConsistent: true,
      independentProvisioningVerified: false,
      independentHostAuthenticated: false,
      deploymentMembershipComplete: false,
      captureContinuityProven: false,
      canPublish: false,
    });
    expect(candidateHostReceiptHash(rows[1].envelope, rows[0].receiptHash))
      .toBe(rows[1].receiptHash);
  });

  it("refuses absent candidate key registry", () => {
    expect(check(chain(), null).reason).toBe("UNAVAILABLE_CANDIDATE_KEY_REGISTRY");
  });

  it("rejects signature forged with a different private key", () => {
    const a = make(baseline(), null, { signer: forged });
    expect(check([a]).reason).toBe("DENIED_CANDIDATE_SIGNATURE");
  });

  it("rejects an expired or revoked key without post-expiry grace", () => {
    const a = make(baseline());
    expect(check([a], new Map([["key.01", pin("key.01", pair.publicKey, {
      revoked: true,
    })]])).reason).toBe("DENIED_CANDIDATE_SIGNATURE");
    expect(check([a], new Map([["key.01", pin("key.01", pair.publicKey, {
      validUntil: NOW,
    })]])).reason).toBe("DENIED_CANDIDATE_SIGNATURE");
  });

  it("rejects a tampered candidate observation even if the link hash is retained", () => {
    const a = make(baseline());
    const tampered = { ...a, envelope: {
      ...a.envelope, observation: {
        ...a.envelope.observation, sessionId: "boot.99",
      },
    } };
    expect(check([tampered]).reason).toBe("DENIED_CANDIDATE_SIGNATURE");
  });

  it("rejects modified receipt hash or predecessor", () => {
    const [a, b] = chain();
    expect(check([{ ...a, receiptHash: "f".repeat(64) }]).reason)
      .toBe("DENIED_RECEIPT_HASH_OR_PREDECESSOR");
    expect(check([a, { ...b, previousReceiptHash: "f".repeat(64) }]).reason)
      .toBe("DENIED_RECEIPT_HASH_OR_PREDECESSOR");
    expect(check([a, { ...b, receiptHash: "0".repeat(64) }]).reason)
      .toBe("DENIED_RECEIPT_HASH_OR_PREDECESSOR");
  });

  it("rejects repeated/replayed sequence and missing sequence values", () => {
    const a = make(baseline());
    expect(check([a, make(heartbeat(1), a.receiptHash)]).reason)
      .toBe("DENIED_SEQUENCE_GAP_OR_REPLAY");
    expect(check([a, make(heartbeat(3), a.receiptHash)]).reason)
      .toBe("DENIED_SEQUENCE_GAP_OR_REPLAY");
    expect(check([a, a]).reason).toBe("DENIED_RECEIPT_HASH_OR_PREDECESSOR");
  });

  it("requires an initial BASELINE at sequence 1", () => {
    expect(check([make(heartbeat(1))]).reason).toBe("DENIED_SEQUENCE_GAP_OR_REPLAY");
    expect(check([make({ ...baseline(), sequence: 2 })]).reason)
      .toBe("DENIED_SEQUENCE_GAP_OR_REPLAY");
  });

  it("rejects cross-session and cross-principal chain extension", () => {
    const a = make(baseline());
    const nextSession = make({ ...heartbeat(), sessionId: "boot.02" }, a.receiptHash);
    expect(check([a, nextSession]).reason).toBe("DENIED_SCOPE_OR_SESSION_BOUNDARY");
    const other = make(heartbeat(), a.receiptHash, {
      principalId: "observer.02", keyId: "key.02", signer: rotated,
    });
    const keys = registry();
    keys.set("key.02", pin("key.02", rotated.publicKey, {
      principalId: "observer.02",
    }));
    expect(check([a, other], keys).reason).toBe("DENIED_SCOPE_OR_SESSION_BOUNDARY");
  });

  it("rejects a host change, including a correctly signed different host", () => {
    const a = make(baseline());
    const otherHost = make({ ...heartbeat(), hostId: "host.02" }, a.receiptHash,
      { keyId: "key.02", signer: rotated });
    const keys = registry();
    keys.set("key.02", pin("key.02", rotated.publicKey, { hostId: "host.02" }));
    expect(check([a, otherHost], keys).reason).toBe("DENIED_SCOPE_OR_SESSION_BOUNDARY");
  });

  it("accepts an in-session candidate key rotation but never authenticates it", () => {
    const a = make(baseline());
    const b = make(heartbeat(), a.receiptHash, {
      keyId: "key.02", signer: rotated,
    });
    const keys = registry();
    keys.set("key.02", pin("key.02", rotated.publicKey));
    const output = check([a, b], keys);
    expect(output.candidateChainInternallyConsistent).toBe(true);
    expect(output.independentHostAuthenticated).toBe(false);
    expect(output.canPublish).toBe(false);
  });

  it("rejects observation-time rollback and signing-time rollback", () => {
    const a = make(baseline(new Date(NOW.getTime() - 1_000)));
    const older = make(heartbeat(2, new Date(NOW.getTime() - 2_000)), a.receiptHash);
    expect(check([a, older]).reason).toBe("DENIED_TIME_ROLLBACK_OR_SILENCE");
    const later = make(heartbeat(), a.receiptHash, {
      signedAt: new Date(NOW.getTime() - 60_000),
    });
    expect(check([a, later]).reason).toBe("DENIED_TIME_ROLLBACK_OR_SILENCE");
  });

  it("rejects a greater-than-15-minute gap even if each signature is plausible", () => {
    const a = make(baseline(new Date(NOW.getTime() - 15 * 60_000)), null, {
      signedAt: new Date(NOW.getTime() - 2 * 60_000),
    });
    const b = make(heartbeat(2, new Date(NOW.getTime() + 2 * 60_000)),
      a.receiptHash);
    expect(check([a, b]).reason).toBe("DENIED_TIME_ROLLBACK_OR_SILENCE");
  });

  it("rejects stale or future signature timestamps at verifier runtime", () => {
    const a = make(baseline(), null, {
      signedAt: new Date(NOW.getTime() - 5 * 60_000 - 1),
    });
    expect(check([a]).reason).toBe("DENIED_CANDIDATE_SIGNATURE");
  });

  it("rejects unknown metadata, accessor fields and does not emit secrets", () => {
    const a = make(baseline());
    const extra = { ...a, accessKey: "secret-private" };
    const getter = { ...a };
    Object.defineProperty(getter, "receiptHash", {
      enumerable: true,
      get: () => { throw new Error("secret-getter"); },
    });
    for (const input of [extra, getter]) {
      const response = check([input]);
      expect(response.reason).toBe("DENIED_MALFORMED_CANDIDATE_CHAIN");
      expect(response.canPublish).toBe(false);
      expect(JSON.stringify(response)).not.toContain("secret");
    }
    expect(check([{ ...a, envelope: { ...a.envelope,
      observation: { ...a.envelope.observation, email: "secret@example.com" } as unknown as UnverifiedHostLifecycleObservation,
    } }]).reason).toBe("DENIED_MALFORMED_CANDIDATE_CHAIN");
  });

  it("fails closed on malformed, over-budget, or hostile arrays", () => {
    const a = make(baseline());
    expect(check([]).reason).toBe("DENIED_MALFORMED_CANDIDATE_CHAIN");
    expect(check(Array.from({ length: 513 }, () => a)).reason)
      .toBe("DENIED_MALFORMED_CANDIDATE_CHAIN");
    const badArray = new Proxy([a], {
      get(target, prop, receiver) {
        if (prop === "length") throw new Error("secret-length");
        return Reflect.get(target, prop, receiver);
      },
    });
    const response = check(badArray);
    expect(response.reason).toBe("DENIED_MALFORMED_CANDIDATE_CHAIN");
    expect(JSON.stringify(response)).not.toContain("secret-length");
  });

  it("rejects malformed hashes, base64url signatures, and predecessor inputs", () => {
    const a = make(baseline());
    expect(check([{ ...a, receiptHash: "bad" }]).reason)
      .toBe("DENIED_MALFORMED_CANDIDATE_CHAIN");
    expect(check([{ ...a, previousReceiptHash: "invalid" }]).reason)
      .toBe("DENIED_MALFORMED_CANDIDATE_CHAIN");
    expect(() => candidateHostReceiptHash({
      ...a.envelope, signatureBase64url: "A===",
    }, null)).toThrow("HOST_OBSERVER_RECEIPT_INVALID");
  });
});
