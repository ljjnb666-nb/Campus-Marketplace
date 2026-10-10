import { describe, expect, it } from "vitest";
import type { UnverifiedCandidateReceiptCheckpoint } from
  "@/lib/analytics/funnel-host-observer-candidate-checkpoint";
import { inspectUnverifiedCandidateCheckpointTimeline } from
  "@/lib/analytics/funnel-host-observer-candidate-timeline";

const NOW = new Date("2026-10-10T07:00:00.000Z");
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function tip(
  overrides: Partial<UnverifiedCandidateReceiptCheckpoint> = {},
): UnverifiedCandidateReceiptCheckpoint {
  return {
    source: "UNVERIFIED_CANDIDATE",
    principalId: "observer.01",
    hostId: "host.01",
    sessionId: "boot.01",
    sequence: 1,
    lastReceiptHash: A,
    observedAt: new Date(NOW.getTime() - 1_000),
    signedAt: new Date(NOW.getTime() - 500),
    ...overrides,
  };
}

const at = (minutesBefore: number) =>
  new Date(NOW.getTime() - minutesBefore * 60_000);
const scan = (items: readonly UnverifiedCandidateReceiptCheckpoint[]) =>
  inspectUnverifiedCandidateCheckpointTimeline(items);
const invalid = "DENIED_INVALID_CANDIDATE_TIPS";

describe("10K-R2d-03B-02B-02B-06 candidate timeline", () => {
  it("reports a single submitted tip as only internally consistent", () => {
    expect(scan([tip()])).toEqual({
      reason: "CANDIDATE_SUBMITTED_TIMELINE_ONLY",
      candidateSubmittedTimelineInternallyConsistent: true,
      submittedUniqueSlots: 1,
      independentProvisioningVerified: false,
      independentHostAuthenticated: false,
      deploymentMembershipComplete: false,
      captureContinuityProven: false,
      canPublish: false,
    });
  });

  it("accepts contiguous candidate slots regardless of submission order", () => {
    const one = tip({ observedAt: at(3), signedAt: at(2) });
    const two = tip({
      sequence: 2, lastReceiptHash: B, observedAt: at(2), signedAt: at(1),
    });
    const three = tip({
      sequence: 3, lastReceiptHash: C, observedAt: at(1), signedAt: at(0),
    });
    expect(scan([three, one, two]).submittedUniqueSlots).toBe(3);
  });

  it("deduplicates identical candidate tips before timeline evaluation", () => {
    const one = tip({ observedAt: at(3), signedAt: at(2) });
    const two = tip({
      sequence: 2, lastReceiptHash: B, observedAt: at(2), signedAt: at(1),
    });
    expect(scan([one, two, one, tip({ ...one })]).submittedUniqueSlots).toBe(2);
  });

  it("compares separate principals independently without authenticating either", () => {
    const result = scan([
      tip(),
      tip({ principalId: "observer.02", lastReceiptHash: B, sequence: 5 }),
    ]);
    expect(result.candidateSubmittedTimelineInternallyConsistent).toBe(true);
    expect(result.independentHostAuthenticated).toBe(false);
  });

  it("denies same-slot competing candidate hashes", () => {
    const result = scan([tip(), tip({ lastReceiptHash: B })]);
    expect(result.reason).toBe("DENIED_SUBMITTED_FORK_OR_HASH_REUSE");
    expect(result.submittedUniqueSlots).toBe(0);
  });

  it("denies same-slot conflicting observed or signed times", () => {
    expect(scan([tip(), tip({ observedAt: at(1) })]).reason)
      .toBe("DENIED_SUBMITTED_FORK_OR_HASH_REUSE");
    expect(scan([tip(), tip({ signedAt: at(1) })]).reason)
      .toBe("DENIED_SUBMITTED_FORK_OR_HASH_REUSE");
  });

  it("denies candidate hash reuse across distinct sequences and scopes", () => {
    expect(scan([tip(), tip({ sequence: 2 })]).reason)
      .toBe("DENIED_SUBMITTED_FORK_OR_HASH_REUSE");
    expect(scan([tip(), tip({ hostId: "host.02" })]).reason)
      .toBe("DENIED_SUBMITTED_FORK_OR_HASH_REUSE");
  });

  it("denies a skipped sequence in a submitted group", () => {
    const result = scan([tip(), tip({
      sequence: 3, lastReceiptHash: C, observedAt: at(0), signedAt: at(0),
    })]);
    expect(result.reason).toBe("DENIED_SUBMITTED_SEQUENCE_GAP");
  });

  it("denies an unsafe successor after MAX_SAFE_INTEGER", () => {
    const result = scan([
      tip({ sequence: Number.MAX_SAFE_INTEGER - 1 }),
      tip({ sequence: Number.MAX_SAFE_INTEGER, lastReceiptHash: B }),
    ]);
    expect(result.candidateSubmittedTimelineInternallyConsistent).toBe(true);
    expect(scan([tip({ sequence: Number.MAX_SAFE_INTEGER }),
      tip({ sequence: 1, lastReceiptHash: B })]).reason)
      .toBe("DENIED_SUBMITTED_SEQUENCE_GAP");
  });

  it("rejects decreasing observed timestamps despite increasing sequences", () => {
    const result = scan([
      tip({ observedAt: at(1), signedAt: at(0) }),
      tip({ sequence: 2, lastReceiptHash: B, observedAt: at(2), signedAt: at(0) }),
    ]);
    expect(result.reason).toBe("DENIED_SUBMITTED_TIME_ROLLBACK_OR_SILENCE");
  });

  it("rejects decreasing signing timestamps despite increasing sequences", () => {
    const result = scan([
      tip({ observedAt: at(2), signedAt: at(0) }),
      tip({ sequence: 2, lastReceiptHash: B, observedAt: at(1), signedAt: at(1) }),
    ]);
    expect(result.reason).toBe("DENIED_SUBMITTED_TIME_ROLLBACK_OR_SILENCE");
  });

  it("denies greater than fifteen minutes of claimed observation silence", () => {
    const result = scan([
      tip({ observedAt: at(16), signedAt: at(16) }),
      tip({ sequence: 2, lastReceiptHash: B, observedAt: at(0), signedAt: at(0) }),
    ]);
    expect(result.reason).toBe("DENIED_SUBMITTED_TIME_ROLLBACK_OR_SILENCE");
  });

  it("allows exactly fifteen minutes as an unverified boundary only", () => {
    const result = scan([
      tip({ observedAt: at(15), signedAt: at(15) }),
      tip({ sequence: 2, lastReceiptHash: B, observedAt: at(0), signedAt: at(0) }),
    ]);
    expect(result.reason).toBe("CANDIDATE_SUBMITTED_TIMELINE_ONLY");
    expect(result.captureContinuityProven).toBe(false);
    expect(result.canPublish).toBe(false);
  });

  it("cannot see a missing middle record when submitted calls are split", () => {
    const a = tip({ sequence: 1 });
    const c = tip({ sequence: 3, lastReceiptHash: C });
    expect(scan([a]).candidateSubmittedTimelineInternallyConsistent).toBe(true);
    expect(scan([c]).candidateSubmittedTimelineInternallyConsistent).toBe(true);
    expect(scan([a, c]).reason).toBe("DENIED_SUBMITTED_SEQUENCE_GAP");
  });

  it("rejects malformed identifiers, hashes, source markers or sequence", () => {
    for (const row of [
      tip({ principalId: "../spoof" }),
      tip({ lastReceiptHash: "A".repeat(64) }),
      tip({ source: "TRUSTED" as "UNVERIFIED_CANDIDATE" }),
      tip({ sequence: 1.5 }),
      tip({ sequence: 0 }),
      tip({ sequence: Number.MAX_SAFE_INTEGER + 1 }),
    ]) expect(scan([row]).reason).toBe(invalid);
  });

  it("rejects invalid Date, Date impostors, proxy Dates and negative clocks", () => {
    for (const date of [
      new Date("invalid"),
      new Date(-1),
      { getTime: () => NOW.getTime() } as unknown as Date,
      new Proxy(new Date(NOW), {}),
    ]) expect(scan([tip({ observedAt: date })]).reason).toBe(invalid);
  });

  it("rejects candidate observed time beyond signed time tolerance", () => {
    expect(scan([tip({
      observedAt: new Date(NOW.getTime() + 5 * 60_000 + 1),
      signedAt: NOW,
    })]).reason).toBe(invalid);
  });

  it("rejects accessors, extra metadata and symbols without echoing credentials", () => {
    const getter = { ...tip() };
    Object.defineProperty(getter, "principalId", {
      enumerable: true, get: () => { throw new Error("secret-timeline-getter"); },
    });
    for (const row of [
      getter,
      { ...tip(), email: "secret@campus.edu" },
      { ...tip(), [Symbol("private")]: "s3cr3t" },
    ]) {
      const result = scan([row]);
      expect(result.reason).toBe(invalid);
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(JSON.stringify(result)).not.toContain("s3cr3t");
    }
  });

  it("fails closed on empty, excessive, sparse and hostile arrays", () => {
    expect(scan([]).reason).toBe(invalid);
    expect(scan(Array.from({ length: 129 }, () => tip())).reason).toBe(invalid);
    expect(scan(new Array(1) as UnverifiedCandidateReceiptCheckpoint[]).reason)
      .toBe(invalid);
    const hostile = new Proxy([tip()], {
      get(target, key, receiver) {
        if (key === "length") throw new Error("secret-array-access");
        return Reflect.get(target, key, receiver);
      },
    });
    expect(scan(hostile).reason).toBe(invalid);
  });

  it("supports the bounded 128-tip set without echoing submitted identities", () => {
    const rows = Array.from({ length: 128 }, (_, i) => tip({
      sequence: i + 1,
      lastReceiptHash: (i + 1).toString(16).padStart(64, "0"),
      observedAt: NOW,
      signedAt: NOW,
    }));
    const r = scan(rows);
    expect(r.reason).toBe("CANDIDATE_SUBMITTED_TIMELINE_ONLY");
    expect(r.submittedUniqueSlots).toBe(128);
    expect(JSON.stringify(r)).not.toContain("host.01");
    expect(r.canPublish).toBe(false);
  });
});
