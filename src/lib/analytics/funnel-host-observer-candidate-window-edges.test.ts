import { afterEach, describe, expect, it, vi } from "vitest";
import type { UnverifiedCandidateReceiptCheckpoint } from
  "@/lib/analytics/funnel-host-observer-candidate-checkpoint";
import { inspectUnverifiedCandidateWindowEdges } from
  "@/lib/analytics/funnel-host-observer-candidate-window-edges";

const NOW = new Date("2026-10-10T08:00:00.000Z");
const minute = (offset: number) =>
  new Date(NOW.getTime() + offset * 60_000);
const HASH = (n: number) => n.toString(16).padStart(64, "0");

function tip(
  sequence: number,
  observedMinutes: number,
  changes: Partial<UnverifiedCandidateReceiptCheckpoint> = {},
): UnverifiedCandidateReceiptCheckpoint {
  return {
    source: "UNVERIFIED_CANDIDATE",
    principalId: "observer.01",
    hostId: "host.01",
    sessionId: "boot.01",
    sequence,
    lastReceiptHash: HASH(sequence),
    observedAt: minute(observedMinutes),
    signedAt: new Date(minute(observedMinutes).getTime() + 10_000),
    ...changes,
  };
}
const trio = () => [tip(1, -25), tip(2, -15), tip(3, -2)];
const scan = (
  tips: readonly UnverifiedCandidateReceiptCheckpoint[],
  windowStart = minute(-20),
  windowEnd = minute(-5),
) => inspectUnverifiedCandidateWindowEdges({ windowStart, windowEnd, tips });
const invalid = "DENIED_INVALID_CANDIDATE_TIPS";
const gap = "DENIED_SUBMITTED_SEQUENCE_OR_TIME_GAP";

afterEach(() => vi.useRealTimers());

describe("10K-R2d-03B-02B-02B-07 candidate window edges", () => {
  it("brackets only submitted candidate tip timestamps, never real capture", () => {
    expect(scan(trio())).toEqual({
      reason: "CANDIDATE_SUBMITTED_WINDOW_BRACKET_ONLY",
      candidateWindowInternallyBracketed: true,
      submittedUniqueTips: 3,
      independentProvisioningVerified: false,
      independentHostAuthenticated: false,
      deploymentMembershipComplete: false,
      captureContinuityProven: false,
      canPublish: false,
    });
  });

  it("accepts arbitrary submission order within a single candidate scope", () => {
    const [a, b, c] = trio();
    expect(scan([c, a, b]).reason).toBe("CANDIDATE_SUBMITTED_WINDOW_BRACKET_ONLY");
  });

  it("collapses identical repeated candidate tips", () => {
    const [a, b, c] = trio();
    expect(scan([a, b, a, { ...c }, c]).submittedUniqueTips).toBe(3);
  });

  it("refuses missing leading edge even if sequences are contiguous", () => {
    expect(scan([
      tip(1, -18), tip(2, -12), tip(3, -2),
    ]).reason).toBe("DENIED_UNBRACKETED_CANDIDATE_START");
  });

  it("refuses a submitted leading tip more than 15 minutes before window start", () => {
    expect(scan([
      tip(1, -40), tip(2, -25), tip(3, -15), tip(4, -2),
    ]).reason).toBe("DENIED_UNBRACKETED_CANDIDATE_START");
  });

  it("refuses missing trailing edge despite a plausible beginning", () => {
    expect(scan([
      tip(1, -25), tip(2, -15), tip(3, -7),
    ]).reason).toBe("DENIED_UNBRACKETED_CANDIDATE_END");
  });

  it("refuses a trailing tip more than 15 minutes beyond end", () => {
    expect(scan([
      tip(1, -25), tip(2, -15), tip(3, -2), tip(4, 12),
    ]).reason).toBe("DENIED_UNBRACKETED_CANDIDATE_END");
  });

  it("rejects submitted sequence holes without inferring omitted observations", () => {
    expect(scan([
      tip(1, -25), tip(3, -15), tip(4, -2),
    ]).reason).toBe(gap);
  });

  it("rejects observed time rollback and a gap longer than 15 minutes", () => {
    expect(scan([
      tip(1, -25), tip(2, -30), tip(3, -2),
    ]).reason).toBe(gap);
    expect(scan([
      tip(1, -25), tip(2, -8), tip(3, -2),
    ]).reason).toBe(gap);
  });

  it("rejects signed-clock rollback independent of observed-clock order", () => {
    const rows = trio();
    rows[0] = tip(1, -25, { signedAt: minute(-10) });
    rows[1] = tip(2, -15, { signedAt: minute(-14) });
    expect(scan(rows).reason).toBe(gap);
  });

  it("detects competing candidate hashes for one sequence", () => {
    const rows = trio();
    rows.push(tip(2, -15, { lastReceiptHash: HASH(99) }));
    expect(scan(rows).reason).toBe("DENIED_SUBMITTED_FORK_OR_HASH_REUSE");
  });

  it("detects candidate hash reuse across sequences or hosts", () => {
    const [a, b, c] = trio();
    expect(scan([a, { ...b, lastReceiptHash: a.lastReceiptHash }, c]).reason)
      .toBe("DENIED_SUBMITTED_FORK_OR_HASH_REUSE");
    expect(scan([a, b, c, {
      ...b, hostId: "host.02", lastReceiptHash: a.lastReceiptHash,
    }]).reason).toBe("DENIED_SUBMITTED_FORK_OR_HASH_REUSE");
  });

  it("rejects mixed host, session or principal scopes without authentication", () => {
    const [a, b, c] = trio();
    for (const changes of [
      { hostId: "host.02" },
      { sessionId: "boot.02" },
      { principalId: "observer.02" },
    ]) {
      expect(scan([a, { ...b, ...changes }, c]).reason)
        .toBe("DENIED_MIXED_CANDIDATE_SCOPE");
    }
  });

  it("denies invalid or overly broad candidate windows", () => {
    expect(scan(trio(), minute(-5), minute(-20)).reason)
      .toBe("DENIED_INVALID_CANDIDATE_WINDOW");
    expect(scan(trio(), minute(-5), minute(-5)).reason)
      .toBe("DENIED_INVALID_CANDIDATE_WINDOW");
    expect(scan(trio(), minute(-70), minute(-5)).reason)
      .toBe("DENIED_INVALID_CANDIDATE_WINDOW");
  });

  it("rejects malformed timestamps and fake Date impersonators", () => {
    for (const timestamp of [
      new Date("invalid"),
      new Date(-1),
      { getTime: () => NOW.getTime() } as unknown as Date,
      new Proxy(new Date(NOW), {}),
    ]) expect(scan([tip(1, -25, { observedAt: timestamp }), ...trio().slice(1)])
      .reason).toBe(invalid);
  });

  it("rejects malformed identifiers, hashes, sequence and origin", () => {
    for (const changes of [
      { hostId: "" }, { sessionId: "../admin" },
      { principalId: "p".repeat(129) }, { lastReceiptHash: "x" },
      { sequence: -1 }, { sequence: 1.1 },
      { source: "TRUSTED" as "UNVERIFIED_CANDIDATE" },
    ]) {
      expect(scan([tip(1, -25, changes), ...trio().slice(1)]).reason).toBe(invalid);
    }
  });

  it("rejects getters, symbols and extra metadata without echoing sensitive data", () => {
    const fake = { ...tip(1, -25) };
    Object.defineProperty(fake, "lastReceiptHash", {
      enumerable: true, get: () => { throw new Error("secret-getter"); },
    });
    for (const row of [
      fake,
      { ...tip(1, -25), email: "secret@example.org" },
      { ...tip(1, -25), [Symbol("secret")]: "private" },
    ]) {
      const response = scan([row, ...trio().slice(1)]);
      expect(response.reason).toBe(invalid);
      expect(JSON.stringify(response)).not.toContain("secret");
      expect(response.canPublish).toBe(false);
    }
  });

  it("rejects empty, singleton, oversized, sparse and hostile tip arrays", () => {
    expect(scan([]).reason).toBe(invalid);
    expect(scan([tip(1, -25)]).reason).toBe(invalid);
    expect(scan(Array.from({ length: 129 }, () => tip(1, -25))).reason)
      .toBe(invalid);
    expect(scan(new Array(2) as UnverifiedCandidateReceiptCheckpoint[])
      .reason).toBe(invalid);
    const hostile = new Proxy(trio(), {
      get(t, key, receiver) {
        if (key === "length") throw new Error("sensitive-length");
        return Reflect.get(t, key, receiver);
      },
    });
    expect(scan(hostile).reason).toBe(invalid);
  });

  it("accepts real Dates created before installing fake timers", () => {
    const rows = trio();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(scan(rows).candidateWindowInternallyBracketed).toBe(true);
  });

  it("accepts a bounded 128-tip candidate set without revealing identities", () => {
    const rows = Array.from({ length: 128 }, (_, i) => {
      const minutes = -25 + (23 * i) / 127;
      return tip(i + 1, minutes);
    });
    const response = scan(rows);
    expect(response.reason).toBe("CANDIDATE_SUBMITTED_WINDOW_BRACKET_ONLY");
    expect(response.submittedUniqueTips).toBe(128);
    expect(JSON.stringify(response)).not.toContain("host.01");
    expect(response.canPublish).toBe(false);
  });

  it("cannot discover omitted sessions or fabricated candidate timestamps", () => {
    // An attacker chooses every candidate timestamp and can omit an entire host.
    const first = scan(trio());
    const second = scan(trio().map(r => ({
      ...r, hostId: "unknown-but-claimed-host",
    })));
    expect(first.candidateWindowInternallyBracketed).toBe(true);
    expect(second.candidateWindowInternallyBracketed).toBe(true);
    expect(first.captureContinuityProven).toBe(false);
    expect(second.independentHostAuthenticated).toBe(false);
  });
});
