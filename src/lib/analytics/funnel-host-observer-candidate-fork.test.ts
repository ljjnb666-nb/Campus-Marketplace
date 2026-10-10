import { afterEach, describe, expect, it, vi } from "vitest";
import type { UnverifiedCandidateReceiptCheckpoint } from
  "@/lib/analytics/funnel-host-observer-candidate-checkpoint";
import { inspectUnverifiedCandidateCheckpointForks } from
  "@/lib/analytics/funnel-host-observer-candidate-fork";

const NOW = new Date("2026-10-10T07:00:00.000Z");
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function tip(
  changes: Partial<UnverifiedCandidateReceiptCheckpoint> = {},
): UnverifiedCandidateReceiptCheckpoint {
  return {
    source: "UNVERIFIED_CANDIDATE",
    principalId: "observer.01",
    hostId: "host.01",
    sessionId: "boot.01",
    sequence: 1,
    lastReceiptHash: A,
    observedAt: new Date(NOW.getTime() - 1_000),
    signedAt: new Date(NOW.getTime() - 100),
    ...changes,
  };
}
const scan = (rows: readonly UnverifiedCandidateReceiptCheckpoint[]) =>
  inspectUnverifiedCandidateCheckpointForks(rows);
const malformed = "DENIED_MALFORMED_CANDIDATE_TIP_SET";
const conflicting = "DENIED_CONFLICTING_CANDIDATE_TIPS";

afterEach(() => vi.useRealTimers());

describe("10K-R2d-03B-02B-02B-05 candidate fork scan", () => {
  it("never promotes a single apparently consistent tip to trusted authority", () => {
    const v = scan([tip()]);
    expect(v).toEqual({
      reason: "CANDIDATE_SUBMITTED_TIPS_NO_CONFLICT_ONLY",
      candidateSubmittedSetInternallyConsistent: true,
      uniqueSubmittedSlots: 1,
      independentProvisioningVerified: false,
      independentHostAuthenticated: false,
      deploymentMembershipComplete: false,
      captureContinuityProven: false,
      canPublish: false,
    });
  });

  it("deduplicates byte-equivalent checkpoint tips of the same slot", () => {
    const first = tip();
    const copy = tip({
      observedAt: new Date(first.observedAt),
      signedAt: new Date(first.signedAt),
    });
    expect(scan([first, copy, first]).uniqueSubmittedSlots).toBe(1);
  });

  it("accepts different candidate sequence slots with distinct hashes", () => {
    const r = scan([
      tip(), tip({ sequence: 2, lastReceiptHash: B }),
      tip({ sequence: 3, lastReceiptHash: C }),
    ]);
    expect(r.reason).toBe("CANDIDATE_SUBMITTED_TIPS_NO_CONFLICT_ONLY");
    expect(r.uniqueSubmittedSlots).toBe(3);
    expect(r.canPublish).toBe(false);
  });

  it("detects same-principal/session/sequence competing hashes", () => {
    const r = scan([tip(), tip({ lastReceiptHash: B })]);
    expect(r.reason).toBe(conflicting);
    expect(r.candidateSubmittedSetInternallyConsistent).toBe(false);
    expect(r.uniqueSubmittedSlots).toBe(0);
  });

  it("detects same hash but contradictory observed timestamps in one slot", () => {
    const r = scan([tip(), tip({
      observedAt: new Date(NOW.getTime() - 2_000),
    })]);
    expect(r.reason).toBe(conflicting);
  });

  it("detects same hash but contradictory signed timestamps in one slot", () => {
    const r = scan([tip(), tip({
      signedAt: new Date(NOW.getTime() - 200),
    })]);
    expect(r.reason).toBe(conflicting);
  });

  it("rejects same candidate receipt hash reused across principals", () => {
    expect(scan([tip(), tip({ principalId: "observer.02" })]).reason)
      .toBe("DENIED_CANDIDATE_HASH_SCOPE_REUSE");
  });

  it("rejects same candidate receipt hash reused across hosts", () => {
    expect(scan([tip(), tip({ hostId: "host.02" })]).reason)
      .toBe("DENIED_CANDIDATE_HASH_SCOPE_REUSE");
  });

  it("rejects same candidate receipt hash reused across sequences or sessions", () => {
    expect(scan([tip(), tip({ sequence: 2 })]).reason)
      .toBe("DENIED_CANDIDATE_HASH_SCOPE_REUSE");
    expect(scan([tip(), tip({ sessionId: "boot.02" })]).reason)
      .toBe("DENIED_CANDIDATE_HASH_SCOPE_REUSE");
  });

  it("allows different principals to submit disjoint untrusted tips", () => {
    const r = scan([tip(), tip({
      principalId: "observer.02", lastReceiptHash: B,
    })]);
    expect(r.candidateSubmittedSetInternallyConsistent).toBe(true);
    expect(r.independentHostAuthenticated).toBe(false);
  });

  it("refuses wrong source, missing fields and invalid identifier scopes", () => {
    for (const row of [
      { ...tip(), source: "AUTHENTICATED" },
      { ...tip(), principalId: "../admin" },
      { ...tip(), hostId: "" },
      { ...tip(), sessionId: "b".repeat(129) },
      (({ signedAt: _ignored, ...rest }) => rest)(tip()),
    ]) {
      expect(scan([row as UnverifiedCandidateReceiptCheckpoint]).reason)
        .toBe(malformed);
    }
  });

  it("refuses malformed or uppercase candidate digests", () => {
    for (const hash of ["x", "A".repeat(64), "z".repeat(64), "0".repeat(63)]) {
      expect(scan([tip({ lastReceiptHash: hash })]).reason).toBe(malformed);
    }
  });

  it("refuses zero, fractional and unsafe sequences", () => {
    for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(scan([tip({ sequence })]).reason).toBe(malformed);
    }
  });

  it("refuses invalid, negative, forged and proxied Date instances", () => {
    for (const observedAt of [
      new Date("invalid"), new Date(-1),
      { getTime: () => NOW.getTime() } as unknown as Date,
      new Proxy(new Date(NOW), {}),
    ]) expect(scan([tip({ observedAt })]).reason).toBe(malformed);
  });

  it("refuses a timestamp snapshot with excessive future observation skew", () => {
    const row = tip({
      observedAt: new Date(NOW.getTime() + 5 * 60_000 + 1),
      signedAt: new Date(NOW.getTime()),
    });
    expect(scan([row]).reason).toBe(malformed);
  });

  it("rejects accessor fields, symbols and extra metadata without leaking secrets", () => {
    const getter = { ...tip() };
    Object.defineProperty(getter, "lastReceiptHash", {
      enumerable: true, get: () => { throw new Error("secret-getter"); },
    });
    const inputs = [
      getter,
      { ...tip(), email: "private@campus.edu" },
      { ...tip(), [Symbol("credential")]: "s3cr3t" },
    ];
    for (const row of inputs) {
      const result = scan([row]);
      expect(result.reason).toBe(malformed);
      expect(result.canPublish).toBe(false);
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(JSON.stringify(result)).not.toContain("private@");
    }
  });

  it("rejects empty, oversized, sparse and hostile proxy arrays", () => {
    expect(scan([]).reason).toBe(malformed);
    expect(scan(Array.from({ length: 129 }, () => tip())).reason).toBe(malformed);
    expect(scan(new Array(1) as UnverifiedCandidateReceiptCheckpoint[]).reason)
      .toBe(malformed);
    const hostile = new Proxy([tip()], {
      get(target, prop, receiver) {
        if (prop === "length") throw new Error("sensitive-array-length");
        return Reflect.get(target, prop, receiver);
      },
    });
    const result = scan(hostile);
    expect(result.reason).toBe(malformed);
    expect(JSON.stringify(result)).not.toContain("sensitive-array-length");
  });

  it("accepts real Dates created before installing Vitest fake timers", () => {
    const old = tip({ observedAt: NOW, signedAt: new Date(NOW) });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(scan([old]).candidateSubmittedSetInternallyConsistent).toBe(true);
  });

  it("proves split calls cannot see a conflicting fork omitted from their input", () => {
    const left = scan([tip()]);
    const right = scan([tip({ lastReceiptHash: B })]);
    expect(left.candidateSubmittedSetInternallyConsistent).toBe(true);
    expect(right.candidateSubmittedSetInternallyConsistent).toBe(true);
    expect(left.canPublish).toBe(false);
    expect(right.canPublish).toBe(false);
    expect(scan([tip(), tip({ lastReceiptHash: B })]).reason).toBe(conflicting);
  });

  it("never mutates input Date values or reports candidate identities in diagnostics", () => {
    const original = tip();
    const ms = original.observedAt.getTime();
    const result = scan([original]);
    expect(original.observedAt.getTime()).toBe(ms);
    expect(JSON.stringify(result)).not.toContain(original.principalId);
    expect(JSON.stringify(result)).not.toContain(original.hostId);
    expect(JSON.stringify(result)).not.toContain(original.lastReceiptHash);
  });
});
