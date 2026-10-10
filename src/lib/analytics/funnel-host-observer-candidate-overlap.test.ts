import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  UnverifiedCandidateReceiptCheckpoint,
} from "@/lib/analytics/funnel-host-observer-candidate-checkpoint";
import {
  inspectUnverifiedCandidateWindowOverlap,
  type UnverifiedCandidateWindow,
} from "@/lib/analytics/funnel-host-observer-candidate-overlap";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const hash = (seq: number) => seq.toString(16).padStart(64, "0");
const tip = (
  sequence: number, minutes: number,
  override: Partial<UnverifiedCandidateReceiptCheckpoint> = {},
): UnverifiedCandidateReceiptCheckpoint => ({
  source: "UNVERIFIED_CANDIDATE",
  principalId: "observer.01", hostId: "host.01", sessionId: "boot.01",
  sequence, lastReceiptHash: hash(sequence),
  observedAt: at(minutes),
  signedAt: new Date(at(minutes).getTime() + 1_000),
  ...override,
});

function pair(): { earlier: UnverifiedCandidateWindow; later: UnverifiedCandidateWindow } {
  return {
    earlier: {
      windowStart: at(-20), windowEnd: at(-5),
      tips: [tip(1, -25), tip(2, -15), tip(3, -8), tip(4, 0)],
    },
    later: {
      windowStart: at(-12), windowEnd: at(5),
      tips: [tip(2, -15), tip(3, -8), tip(4, 0), tip(5, 7)],
    },
  };
}
const scan = (
  override: Partial<{earlier: UnverifiedCandidateWindow; later: UnverifiedCandidateWindow}> = {},
) => inspectUnverifiedCandidateWindowOverlap({ ...pair(), ...override });
const invalid = "DENIED_INVALID_CANDIDATE_WINDOW_PAIR";
afterEach(() => vi.useRealTimers());

describe("10K-R2d-03B-02B-02B-08 candidate overlapping windows", () => {
  it("identifies an exactly shared candidate tip within the submitted overlap only", () => {
    expect(scan()).toEqual({
      reason: "CANDIDATE_SUBMITTED_OVERLAP_ONLY",
      candidateOverlapInternallyConsistent: true,
      sharedSubmittedAnchors: 1,
      independentProvisioningVerified: false,
      independentHostAuthenticated: false,
      deploymentMembershipComplete: false,
      captureContinuityProven: false,
      canPublish: false,
    });
  });

  it("accepts reversed input windows without inventing source authority", () => {
    const { earlier, later } = pair();
    const r = inspectUnverifiedCandidateWindowOverlap({ earlier: later, later: earlier });
    expect(r.reason).toBe("CANDIDATE_SUBMITTED_OVERLAP_ONLY");
    expect(r.independentHostAuthenticated).toBe(false);
  });

  it("collapses duplicate candidate anchors rather than counting repeated submissions", () => {
    const { later } = pair();
    const r = scan({ later: { ...later, tips: [...later.tips, later.tips[1], later.tips[1]] } });
    expect(r.sharedSubmittedAnchors).toBe(1);
  });

  it("requires strictly overlapping time bounds, not touching endpoints", () => {
    const { later } = pair();
    const shifted: UnverifiedCandidateWindow = {
      ...later, windowStart: at(-5), windowEnd: at(5),
    };
    expect(scan({ later: shifted }).reason)
      .toBe("DENIED_NONOVERLAPPING_CANDIDATE_WINDOWS");
  });

  it("rejects completely disjoint but individually bracketed windows", () => {
    const later: UnverifiedCandidateWindow = {
      windowStart: at(10), windowEnd: at(20),
      tips: [tip(4, 0), tip(5, 15), tip(6, 22)],
    };
    expect(scan({ later }).reason).toBe("DENIED_NONOVERLAPPING_CANDIDATE_WINDOWS");
  });

  it("rejects a separate candidate sequence that shares no checkpoint", () => {
    const { later } = pair();
    const alternative = [tip(9, -15), tip(10, -8), tip(11, 0), tip(12, 7)];
    expect(scan({ later: { ...later, tips: alternative } }).reason)
      .toBe("DENIED_NO_SHARED_CANDIDATE_ANCHOR");
  });

  it("does not mistake a shared tip outside the overlap for an in-window anchor", () => {
    const { earlier, later } = pair();
    const second: UnverifiedCandidateWindow = {
      ...later,
      tips: [
        tip(2, -15), tip(7, -8), tip(8, 0), tip(9, 7),
      ],
    };
    // The later window by itself has a sequence gap: fail closed.
    expect(scan({ earlier, later: second }).reason)
      .toBe("DENIED_UNBRACKETED_CANDIDATE_WINDOW");
  });

  it("denies competing hashes for a matching scope and sequence", () => {
    const { later } = pair();
    const tips = later.tips.map(t =>
      t.sequence === 3 ? { ...t, lastReceiptHash: hash(99) } : t,
    );
    expect(scan({ later: { ...later, tips } }).reason)
      .toBe("DENIED_CONFLICTING_CANDIDATE_TIPS");
  });

  it("denies contradictory signing or observation timestamps for shared sequence", () => {
    const { later } = pair();
    for (const changes of [
      { signedAt: new Date(at(-8).getTime() + 2_000) },
      { observedAt: at(-9) },
    ]) {
      const tips = later.tips.map(t => t.sequence === 3 ? { ...t, ...changes } : t);
      expect(scan({ later: { ...later, tips } }).reason)
        .toBe("DENIED_CONFLICTING_CANDIDATE_TIPS");
    }
  });

  it("denies a reused candidate hash in a different sequence", () => {
    const { later } = pair();
    const tips = later.tips.map(t =>
      t.sequence === 5 ? { ...t, lastReceiptHash: hash(1) } : t,
    );
    expect(scan({ later: { ...later, tips } }).reason)
      .toBe("DENIED_CONFLICTING_CANDIDATE_TIPS");
  });

  it("denies different candidate principal scope across windows", () => {
    const { later } = pair();
    const tips = later.tips.map(t => ({ ...t, principalId: "observer.02" }));
    expect(scan({ later: { ...later, tips } }).reason)
      .toBe("DENIED_MIXED_CANDIDATE_SCOPE");
  });

  it("denies different host and boot-session scopes across windows", () => {
    const { later } = pair();
    for (const change of [{ hostId: "host.02" }, { sessionId: "boot.02" }]) {
      const tips = later.tips.map(t => ({ ...t, ...change }));
      expect(scan({ later: { ...later, tips } }).reason)
        .toBe("DENIED_MIXED_CANDIDATE_SCOPE");
    }
  });

  it("rejects a locally broken window before attempting overlap reconciliation", () => {
    const { later } = pair();
    expect(scan({ later: { ...later, tips: later.tips.slice(0, 2) } }).reason)
      .toBe("DENIED_UNBRACKETED_CANDIDATE_WINDOW");
  });

  it("fails closed on forged or negative time bound objects", () => {
    const { later } = pair();
    for (const date of [
      new Date(-1), new Date("invalid"),
      { getTime: () => NOW.getTime() } as unknown as Date,
      new Proxy(new Date(NOW), {}),
    ]) {
      expect(scan({ later: { ...later, windowEnd: date } }).reason).toBe(invalid);
    }
  });

  it("rejects hostile accessor metadata and symbols without revealing values", () => {
    const { later } = pair();
    const withGetter = { ...later.tips[0] };
    Object.defineProperty(withGetter, "hostId", {
      enumerable: true,
      get: () => { throw new Error("secret-accessor"); },
    });
    for (const bad of [
      withGetter,
      { ...later.tips[0], email: "student-private@campus.edu" },
      { ...later.tips[0], [Symbol("secret")]: "hidden" },
    ]) {
      const resp = scan({ later: { ...later, tips: [bad, ...later.tips.slice(1)] } });
      expect(resp.reason).toBe(invalid);
      expect(JSON.stringify(resp)).not.toContain("secret");
      expect(JSON.stringify(resp)).not.toContain("private@");
    }
  });

  it("rejects empty, singleton, oversized and sparse candidate batches", () => {
    const { later } = pair();
    for (const tips of [
      [], [later.tips[0]], Array.from({ length: 65 }, () => later.tips[0]),
      new Array(2) as UnverifiedCandidateReceiptCheckpoint[],
    ]) {
      expect(scan({ later: { ...later, tips } }).reason).toBe(invalid);
    }
  });

  it("preserves native Date brand across fake timer replacement", () => {
    const original = pair();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(inspectUnverifiedCandidateWindowOverlap(original).reason)
      .toBe("CANDIDATE_SUBMITTED_OVERLAP_ONLY");
  });

  it("accepts exact 64 + 64 bounded tips without identity disclosure", () => {
    const stamp = (seq: number) => -25 + ((seq - 1) * 25) / 63;
    const earlier: UnverifiedCandidateWindow = {
      windowStart: at(-20), windowEnd: at(-5),
      tips: Array.from({ length: 64 }, (_, n) => tip(n + 1, stamp(n + 1))),
    };
    const later: UnverifiedCandidateWindow = {
      windowStart: at(-12), windowEnd: at(5),
      tips: Array.from({ length: 64 }, (_, n) => tip(n + 33, stamp(n + 33))),
    };
    const out = inspectUnverifiedCandidateWindowOverlap({ earlier, later });
    expect(out.reason).toBe("CANDIDATE_SUBMITTED_OVERLAP_ONLY");
    expect(out.sharedSubmittedAnchors).toBeGreaterThan(0);
    expect(JSON.stringify(out)).not.toContain("host.01");
    expect(out.canPublish).toBe(false);
  });

  it("proves independently submitted or omitted forks remain undiscoverable", () => {
    const original = pair();
    const first = inspectUnverifiedCandidateWindowOverlap(original);
    const unrelated = pair();
    unrelated.earlier.tips = unrelated.earlier.tips as never;
    // A second call can claim a separate host with a self-consistent chain.
    const changed: UnverifiedCandidateWindow = {
      ...unrelated.later,
      tips: unrelated.later.tips.map(t => ({
        ...t, hostId: "host.02",
        lastReceiptHash: t.lastReceiptHash === hash(3) ? hash(33) : t.lastReceiptHash,
      })),
    };
    // Those two calls do not share a persistent state or globally agreed scope.
    const r = inspectUnverifiedCandidateWindowOverlap({
      earlier: { ...unrelated.earlier, tips: unrelated.earlier.tips.map(t => ({
        ...t, hostId: "host.02",
        lastReceiptHash: t.lastReceiptHash === hash(3) ? hash(33) : t.lastReceiptHash,
      })) },
      later: changed,
    });
    expect(first.candidateOverlapInternallyConsistent).toBe(true);
    expect(r.candidateOverlapInternallyConsistent).toBe(true);
    expect(first.captureContinuityProven).toBe(false);
    expect(r.canPublish).toBe(false);
  });

  it("never reports trusted capture even for positive overlap evidence", () => {
    const r = scan();
    expect(r.independentProvisioningVerified).toBe(false);
    expect(r.independentHostAuthenticated).toBe(false);
    expect(r.deploymentMembershipComplete).toBe(false);
    expect(r.captureContinuityProven).toBe(false);
    expect(r.canPublish).toBe(false);
  });
});
