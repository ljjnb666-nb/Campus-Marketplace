import { generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { UnverifiedHostLifecycleObservation } from "@/lib/analytics/funnel-host-lifecycle-replay";
import {
  hostObserverSigningBytes,
  type CandidateObserverKey,
  type CandidateSignedHostObservation,
} from "@/lib/analytics/funnel-host-observer-signature";
import {
  candidateHostReceiptHash,
  type CandidateHostObserverReceipt,
} from "@/lib/analytics/funnel-host-observer-receipt-chain";
import {
  proposeUnverifiedCandidateCheckpointAdvance,
  type UnverifiedCandidateReceiptCheckpoint,
} from "@/lib/analytics/funnel-host-observer-candidate-checkpoint";

const NOW = new Date("2026-10-10T06:00:00.000Z");
const key = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const APP = { instanceId: "app.01", role: "APP" as const, releaseSha: "a".repeat(40) };
const WORKER = { instanceId: "worker.01", role: "ASYNC_WORKER" as const, releaseSha: "a".repeat(40) };

function observation(
  kind: "BASELINE" | "HEARTBEAT" = "HEARTBEAT",
  sequence = 2,
  at = new Date(NOW.getTime() - 500),
): UnverifiedHostLifecycleObservation {
  return {
    origin: "UNVERIFIED_HOST_OBSERVER",
    hostId: "host.01", sessionId: "boot.01", sequence, observedAt: at, kind,
    ...(kind === "BASELINE" ? { instances: [APP, WORKER] } : {}),
  };
}
function pin(
  publicKey = key.publicKey,
  changes: Partial<CandidateObserverKey> = {},
): CandidateObserverKey {
  return {
    principalId: "observer.01", hostId: "host.01", keyId: "key.01",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    validFrom: new Date(NOW.getTime() - 86_400_000),
    validUntil: new Date(NOW.getTime() + 86_400_000),
    revoked: false, ...changes,
  };
}
const registry = () => new Map<string, CandidateObserverKey>([["key.01", pin()]]);
function receipt(
  obs = observation(),
  previous: string | null = null,
  options: {
    keyId?: string; principalId?: string;
    signedAt?: Date; signer?: typeof key;
  } = {},
): CandidateHostObserverReceipt {
  const body = {
    observation: obs, signedAt: options.signedAt ?? NOW,
    principalId: options.principalId ?? "observer.01",
    keyId: options.keyId ?? "key.01",
  };
  const envelope: CandidateSignedHostObservation = {
    ...body,
    signatureBase64url: sign(null, hostObserverSigningBytes(body),
      (options.signer ?? key).privateKey).toString("base64url"),
  };
  return {
    envelope,
    previousReceiptHash: previous,
    receiptHash: candidateHostReceiptHash(envelope, previous),
  };
}
function genesis() {
  return receipt(observation("BASELINE", 1,
    new Date(NOW.getTime() - 2_000)), null, {
    signedAt: new Date(NOW.getTime() - 1_000),
  });
}
const propose = (
  receipts: readonly CandidateHostObserverReceipt[],
  previous: UnverifiedCandidateReceiptCheckpoint | null = null,
  keys: ReadonlyMap<string, CandidateObserverKey> | null = registry(),
) => proposeUnverifiedCandidateCheckpointAdvance({
  previous, receipts, registry: keys,
});
function anchor() {
  const r = propose([genesis()]);
  expect(r.reason).toBe("CANDIDATE_CHECKPOINT_PROPOSAL_ONLY");
  return r.proposedCheckpoint!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("10K-R2d-03B-02B-02B-04 unverified checkpoint transition proposal", () => {
  it("proposes a genesis checkpoint without claiming independent authority", () => {
    const r = propose([genesis()]);
    expect(r.reason).toBe("CANDIDATE_CHECKPOINT_PROPOSAL_ONLY");
    expect(r.candidateIncrementInternallyConsistent).toBe(true);
    expect(r.proposedCheckpoint).toMatchObject({
      source: "UNVERIFIED_CANDIDATE", hostId: "host.01",
      principalId: "observer.01", sessionId: "boot.01", sequence: 1,
    });
    expect(r.independentProvisioningVerified).toBe(false);
    expect(r.independentHostAuthenticated).toBe(false);
    expect(r.deploymentMembershipComplete).toBe(false);
    expect(r.captureContinuityProven).toBe(false);
    expect(r.canPublish).toBe(false);
  });

  it("accepts a contiguous two-link batch then proposes a fresh checkpoint", () => {
    const a = genesis();
    const b = receipt(observation(), a.receiptHash);
    const r = propose([a, b]);
    expect(r.reason).toBe("CANDIDATE_CHECKPOINT_PROPOSAL_ONLY");
    expect(r.proposedCheckpoint?.sequence).toBe(2);
    expect(r.proposedCheckpoint?.lastReceiptHash).toBe(b.receiptHash);
    expect(r.proposedCheckpoint?.source).toBe("UNVERIFIED_CANDIDATE");
  });

  it("continues a later caller-supplied checkpoint using the exact predecessor", () => {
    const prev = anchor();
    const b = receipt(observation(), prev.lastReceiptHash);
    const r = propose([b], prev);
    expect(r.candidateIncrementInternallyConsistent).toBe(true);
    expect(r.proposedCheckpoint?.sequence).toBe(2);
    expect(r.proposedCheckpoint?.lastReceiptHash).toBe(b.receiptHash);
  });

  it("refuses a missing registry", () => {
    expect(propose([genesis()], null, null).reason)
      .toBe("UNAVAILABLE_CANDIDATE_KEY_REGISTRY");
  });

  it("refuses forged signatures, revoked keys and missing keys", () => {
    expect(propose([receipt(observation("BASELINE", 1), null, {
      signer: other,
    })]).reason).toBe("DENIED_CANDIDATE_SIGNATURE");
    expect(propose([genesis()], null, new Map([
      ["key.01", pin(key.publicKey, { revoked: true })],
    ])).reason).toBe("DENIED_CANDIDATE_SIGNATURE");
    expect(propose([genesis()], null, new Map()).reason)
      .toBe("DENIED_CANDIDATE_SIGNATURE");
  });

  it("detects predecessor and content-hash disagreement, not just signature match", () => {
    const prev = anchor();
    const b = receipt(observation(), null);
    expect(propose([b], prev).reason)
      .toBe("DENIED_PREDECESSOR_OR_RECEIPT_HASH");
    const valid = receipt(observation(), prev.lastReceiptHash);
    expect(propose([{ ...valid, receiptHash: "a".repeat(64) }], prev).reason)
      .toBe("DENIED_PREDECESSOR_OR_RECEIPT_HASH");
  });

  it("rejects genesis without BASELINE sequence 1", () => {
    const missing = receipt(observation("HEARTBEAT", 1), null);
    expect(propose([missing]).reason).toBe("DENIED_SEQUENCE_GAP_OR_REPLAY");
    const badSeq = receipt(observation("BASELINE", 2), null);
    expect(propose([badSeq]).reason).toBe("DENIED_SEQUENCE_GAP_OR_REPLAY");
  });

  it("rejects same-sequence replay and sequence holes relative to supplied anchor", () => {
    const prev = anchor();
    expect(propose([
      receipt(observation("HEARTBEAT", 1), prev.lastReceiptHash),
    ], prev).reason).toBe("DENIED_SEQUENCE_GAP_OR_REPLAY");
    expect(propose([
      receipt(observation("HEARTBEAT", 3), prev.lastReceiptHash),
    ], prev).reason).toBe("DENIED_SEQUENCE_GAP_OR_REPLAY");
  });

  it("rejects a correctly signed DISCONNECTED event as a terminal unknown gap", () => {
    const prev = anchor();
    const disconnected: UnverifiedHostLifecycleObservation = {
      ...observation(), kind: "DISCONNECTED",
    };
    const row = receipt(disconnected, prev.lastReceiptHash);
    const response = propose([row], prev);
    expect(response.reason).toBe("DENIED_DISCONNECTED_OR_BASELINE_RESET");
    expect(response.proposedCheckpoint).toBeNull();
    expect(response.captureContinuityProven).toBe(false);
  });

  it("rejects in-session BASELINE reset even with a correct sequence and signature", () => {
    const prev = anchor();
    const row = receipt(observation("BASELINE", 2), prev.lastReceiptHash);
    const response = propose([row], prev);
    expect(response.reason).toBe("DENIED_DISCONNECTED_OR_BASELINE_RESET");
    expect(response.proposedCheckpoint).toBeNull();
    expect(response.canPublish).toBe(false);
  });

  it("rejects changed session even if the receipt is correctly signed", () => {
    const prev = anchor();
    const row = receipt({
      ...observation(), sessionId: "boot.02",
    }, prev.lastReceiptHash);
    expect(propose([row], prev).reason)
      .toBe("DENIED_HOST_SESSION_OR_PRINCIPAL_CHANGE");
  });

  it("rejects changed host with a matching second-key scope", () => {
    const prev = anchor();
    const keys = registry();
    keys.set("key.02", pin(other.publicKey, {
      keyId: "key.02", hostId: "host.02",
    }));
    const row = receipt({ ...observation(), hostId: "host.02" },
      prev.lastReceiptHash, { keyId: "key.02", signer: other });
    expect(propose([row], prev, keys).reason)
      .toBe("DENIED_HOST_SESSION_OR_PRINCIPAL_CHANGE");
  });

  it("allows candidate key rotation on same principal but does not attest it", () => {
    const prev = anchor();
    const keys = registry();
    keys.set("key.02", pin(other.publicKey, { keyId: "key.02" }));
    const row = receipt(observation(), prev.lastReceiptHash,
      { keyId: "key.02", signer: other });
    const r = propose([row], prev, keys);
    expect(r.reason).toBe("CANDIDATE_CHECKPOINT_PROPOSAL_ONLY");
    expect(r.independentHostAuthenticated).toBe(false);
    expect(r.canPublish).toBe(false);
  });

  it("rejects changed principal with a separate properly scoped candidate key", () => {
    const prev = anchor();
    const keys = registry();
    keys.set("key.02", pin(other.publicKey, {
      keyId: "key.02", principalId: "observer.02",
    }));
    const row = receipt(observation(), prev.lastReceiptHash, {
      keyId: "key.02", principalId: "observer.02", signer: other,
    });
    expect(propose([row], prev, keys).reason)
      .toBe("DENIED_HOST_SESSION_OR_PRINCIPAL_CHANGE");
  });

  it("rejects observation and signing clock rollback", () => {
    const prev = anchor();
    const earlier = receipt(observation("HEARTBEAT", 2,
      new Date(NOW.getTime() - 5_000)), prev.lastReceiptHash);
    expect(propose([earlier], prev).reason)
      .toBe("DENIED_CLOCK_ROLLBACK_OR_SILENCE");
    const signedEarlier = receipt(observation(), prev.lastReceiptHash, {
      signedAt: new Date(NOW.getTime() - 2_000),
    });
    expect(propose([signedEarlier], prev).reason)
      .toBe("DENIED_CLOCK_ROLLBACK_OR_SILENCE");
  });

  it("rejects greater than 15 minute observed gap with individually plausible timestamps", () => {
    const a = receipt(observation("BASELINE", 1,
      new Date(NOW.getTime() - 18 * 60_000)), null, {
      signedAt: new Date(NOW.getTime() - 4 * 60_000),
    });
    const b = receipt(observation(), a.receiptHash);
    expect(propose([a, b]).reason)
      .toBe("DENIED_CLOCK_ROLLBACK_OR_SILENCE");
  });

  it("rejects malformed checkpoints, metadata, forged clocks and getters without leakage", () => {
    const prev = anchor();
    const b = receipt(observation(), prev.lastReceiptHash);
    const bad = {
      ...prev, accessKey: "secret-credential",
    } as UnverifiedCandidateReceiptCheckpoint;
    const badTime = {
      ...prev, observedAt: { getTime: () => NOW.getTime() } as unknown as Date,
    };
    const forged = { ...b };
    Object.defineProperty(forged, "receiptHash", {
      enumerable: true, get: () => { throw new Error("secret-getter"); },
    });
    for (const [p, rows] of [
      [bad, [b]],
      [badTime, [b]],
      [prev, [forged]],
    ] as const) {
      const r = propose(rows, p);
      expect(r.reason).toBe("DENIED_INVALID_CANDIDATE_CHECKPOINT_OR_RECEIPTS");
      expect(JSON.stringify(r)).not.toContain("secret");
      expect(r.proposedCheckpoint).toBeNull();
    }
  });

  it("rejects empty, over-budget, malicious proxy arrays and extra receipt metadata", () => {
    const a = genesis();
    expect(propose([]).reason).toBe("DENIED_INVALID_CANDIDATE_CHECKPOINT_OR_RECEIPTS");
    expect(propose(Array.from({ length: 257 }, () => a)).reason)
      .toBe("DENIED_INVALID_CANDIDATE_CHECKPOINT_OR_RECEIPTS");
    const p = new Proxy([a], {
      get(target, prop, receiver) {
        if (prop === "length") throw new Error("secret-length");
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(propose(p).reason).toBe("DENIED_INVALID_CANDIDATE_CHECKPOINT_OR_RECEIPTS");
    // The deliberately malformed runtime object must remain untyped input:
    // TypeScript correctly forbids such an extra field in a DTO literal.
    const withExtra = { ...a, email: "private@school.edu" };
    expect(propose([withExtra]).reason)
      .toBe("DENIED_INVALID_CANDIDATE_CHECKPOINT_OR_RECEIPTS");
  });

  it("proposes a detached Date snapshot without mutating the supplied checkpoint", () => {
    const prev = anchor();
    const before = prev.observedAt.getTime();
    const r = propose([receipt(observation(), prev.lastReceiptHash)], prev);
    expect(prev.observedAt.getTime()).toBe(before);
    expect(r.proposedCheckpoint?.observedAt).not.toBe(prev.observedAt);
    r.proposedCheckpoint!.observedAt.setTime(0);
    expect(prev.observedAt.getTime()).toBe(before);
  });

  it("demonstrates that two competing candidate forks both pass without a durable CAS", () => {
    const prev = anchor();
    const a = receipt(observation("HEARTBEAT", 2,
      new Date(NOW.getTime() - 500)), prev.lastReceiptHash);
    const b = receipt(observation("HEARTBEAT", 2,
      new Date(NOW.getTime() - 400)), prev.lastReceiptHash);
    const left = propose([a], prev);
    const right = propose([b], prev);
    expect(left.candidateIncrementInternallyConsistent).toBe(true);
    expect(right.candidateIncrementInternallyConsistent).toBe(true);
    expect(left.proposedCheckpoint?.lastReceiptHash)
      .not.toBe(right.proposedCheckpoint?.lastReceiptHash);
    expect(left.captureContinuityProven).toBe(false);
    expect(right.canPublish).toBe(false);
  });
});
