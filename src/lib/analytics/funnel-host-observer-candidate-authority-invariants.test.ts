import { describe, expect, it } from "vitest";
import {
  proposeUnverifiedCandidateCheckpointAdvance,
  type UnverifiedCandidateReceiptCheckpoint,
} from "@/lib/analytics/funnel-host-observer-candidate-checkpoint";
import {
  inspectUnverifiedCandidateCheckpointForks,
} from "@/lib/analytics/funnel-host-observer-candidate-fork";
import {
  inspectUnverifiedCandidateCheckpointTimeline,
} from "@/lib/analytics/funnel-host-observer-candidate-timeline";
import {
  inspectUnverifiedCandidateWindowEdges,
} from "@/lib/analytics/funnel-host-observer-candidate-window-edges";
import {
  inspectUnverifiedCandidateWindowOverlap,
  type UnverifiedCandidateWindow,
} from "@/lib/analytics/funnel-host-observer-candidate-overlap";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const hash = (n: number) => n.toString(16).padStart(64, "0");

function tip(
  sequence: number,
  observedMinute: number,
  changes: Partial<UnverifiedCandidateReceiptCheckpoint> = {},
): UnverifiedCandidateReceiptCheckpoint {
  return {
    source: "UNVERIFIED_CANDIDATE",
    principalId: "unverified-principal",
    hostId: "claimed-host",
    sessionId: "claimed-boot",
    sequence,
    lastReceiptHash: hash(sequence),
    observedAt: at(observedMinute),
    signedAt: new Date(at(observedMinute).getTime() + 1_000),
    ...changes,
  };
}

function earlier(): UnverifiedCandidateWindow {
  return {
    windowStart: at(-20),
    windowEnd: at(-5),
    tips: [tip(1, -25), tip(2, -15), tip(3, -8), tip(4, 0)],
  };
}

function later(): UnverifiedCandidateWindow {
  return {
    windowStart: at(-12),
    windowEnd: at(5),
    tips: [tip(2, -15), tip(3, -8), tip(4, 0), tip(5, 7)],
  };
}

function checkWindow(w: UnverifiedCandidateWindow) {
  return inspectUnverifiedCandidateWindowEdges(w);
}

type AuthorityFlags = Readonly<{
  independentProvisioningVerified: false;
  independentHostAuthenticated: false;
  deploymentMembershipComplete: false;
  captureContinuityProven: false;
  canPublish: false;
}>;

function assertNoProductionAuthority(output: AuthorityFlags): void {
  expect(output.independentProvisioningVerified).toBe(false);
  expect(output.independentHostAuthenticated).toBe(false);
  expect(output.deploymentMembershipComplete).toBe(false);
  expect(output.captureContinuityProven).toBe(false);
  expect(output.canPublish).toBe(false);
}

function allPositiveCandidateDiagnostics(): AuthorityFlags[] {
  const one = earlier();
  const two = later();
  return [
    inspectUnverifiedCandidateCheckpointForks(one.tips),
    inspectUnverifiedCandidateCheckpointTimeline(one.tips),
    inspectUnverifiedCandidateWindowEdges(one),
    inspectUnverifiedCandidateWindowOverlap({ earlier: one, later: two }),
  ];
}

describe("10K-R2d-03B-02B-02B-09 candidate authority invariants", () => {
  it("keeps the fork detector negative-only for internally consistent inputs", () => {
    const r = inspectUnverifiedCandidateCheckpointForks(earlier().tips);
    expect(r.candidateSubmittedSetInternallyConsistent).toBe(true);
    assertNoProductionAuthority(r);
  });

  it("keeps the timeline detector negative-only for contiguous candidate tips", () => {
    const r = inspectUnverifiedCandidateCheckpointTimeline(earlier().tips);
    expect(r.candidateSubmittedTimelineInternallyConsistent).toBe(true);
    assertNoProductionAuthority(r);
  });

  it("keeps the window-edge detector negative-only even when bounds are bracketed", () => {
    const r = checkWindow(earlier());
    expect(r.candidateWindowInternallyBracketed).toBe(true);
    assertNoProductionAuthority(r);
  });

  it("keeps overlap diagnostic negative-only even with a shared candidate anchor", () => {
    const r = inspectUnverifiedCandidateWindowOverlap({
      earlier: earlier(), later: later(),
    });
    expect(r.candidateOverlapInternallyConsistent).toBe(true);
    expect(r.sharedSubmittedAnchors).toBe(1);
    assertNoProductionAuthority(r);
  });

  it("never treats a missing candidate key registry as host authentication", () => {
    const r = proposeUnverifiedCandidateCheckpointAdvance({
      previous: null, receipts: [], registry: null,
    });
    expect(r.reason).toBe("UNAVAILABLE_CANDIDATE_KEY_REGISTRY");
    assertNoProductionAuthority(r);
  });

  it("never lets an empty receipt batch create a trusted checkpoint", () => {
    const r = proposeUnverifiedCandidateCheckpointAdvance({
      previous: null, receipts: [], registry: new Map(),
    });
    expect(r.reason).not.toBe("CANDIDATE_CHECKPOINT_PROPOSAL_ONLY");
    assertNoProductionAuthority(r);
  });

  it("maintains identical denied production flags across all positive candidates", () => {
    for (const r of allPositiveCandidateDiagnostics()) {
      assertNoProductionAuthority(r);
    }
  });

  it("rejects spoofed origin labels across the four checkpoint consumers", () => {
    const one = earlier();
    const changed = one.tips.map(t => ({
      ...t, source: "AUTHENTICATED" as "UNVERIFIED_CANDIDATE",
    }));
    const bad = { ...one, tips: changed };
    expect(inspectUnverifiedCandidateCheckpointForks(changed)
      .candidateSubmittedSetInternallyConsistent).toBe(false);
    expect(inspectUnverifiedCandidateCheckpointTimeline(changed)
      .candidateSubmittedTimelineInternallyConsistent).toBe(false);
    expect(checkWindow(bad).candidateWindowInternallyBracketed).toBe(false);
    expect(inspectUnverifiedCandidateWindowOverlap({ earlier: bad, later: later() })
      .candidateOverlapInternallyConsistent).toBe(false);
  });

  it("rejects attacker-supplied extra PII fields without exposing them", () => {
    const one = earlier();
    const rows = [{ ...one.tips[0], email: "private-student@example.edu" }, ...one.tips.slice(1)];
    const outputs = [
      inspectUnverifiedCandidateCheckpointForks(rows),
      inspectUnverifiedCandidateCheckpointTimeline(rows),
      checkWindow({ ...one, tips: rows }),
      inspectUnverifiedCandidateWindowOverlap({
        earlier: { ...one, tips: rows }, later: later(),
      }),
    ];
    for (const output of outputs) {
      assertNoProductionAuthority(output);
      expect(JSON.stringify(output)).not.toContain("private-student");
    }
    expect(outputs.every(x => x.canPublish === false)).toBe(true);
  });

  it("rejects accessor-based candidate data without invoking getter", () => {
    let called = 0;
    const row = { ...tip(1, -25) };
    Object.defineProperty(row, "hostId", {
      enumerable: true,
      get() { called++; throw new Error("private-secret"); },
    });
    const rows = [row, ...earlier().tips.slice(1)];
    const outputs = [
      inspectUnverifiedCandidateCheckpointForks(rows),
      inspectUnverifiedCandidateCheckpointTimeline(rows),
      checkWindow({ ...earlier(), tips: rows }),
    ];
    expect(called).toBe(0);
    for (const output of outputs) {
      assertNoProductionAuthority(output);
      expect(JSON.stringify(output)).not.toContain("private-secret");
    }
  });

  it("rejects candidate objects with symbolic extra metadata", () => {
    const row = { ...tip(1, -25), [Symbol("secret")]: "no-echo" };
    const rows = [row, ...earlier().tips.slice(1)];
    expect(inspectUnverifiedCandidateCheckpointForks(rows)
      .candidateSubmittedSetInternallyConsistent).toBe(false);
    expect(inspectUnverifiedCandidateCheckpointTimeline(rows)
      .candidateSubmittedTimelineInternallyConsistent).toBe(false);
    expect(checkWindow({ ...earlier(), tips: rows }).candidateWindowInternallyBracketed)
      .toBe(false);
  });

  it("rejects forged Date impostors across all supplied-time consumers", () => {
    const forged = { getTime: () => NOW.getTime() } as unknown as Date;
    const rows = [tip(1, -25, { observedAt: forged }), ...earlier().tips.slice(1)];
    expect(inspectUnverifiedCandidateCheckpointForks(rows)
      .candidateSubmittedSetInternallyConsistent).toBe(false);
    expect(inspectUnverifiedCandidateCheckpointTimeline(rows)
      .candidateSubmittedTimelineInternallyConsistent).toBe(false);
    expect(checkWindow({ ...earlier(), tips: rows }).candidateWindowInternallyBracketed)
      .toBe(false);
    expect(inspectUnverifiedCandidateWindowOverlap({
      earlier: { ...earlier(), tips: rows }, later: later(),
    }).candidateOverlapInternallyConsistent).toBe(false);
  });

  it("rejects same-slot candidate forks without enabling publication", () => {
    const a = tip(2, -15);
    const b = tip(2, -15, { lastReceiptHash: hash(99) });
    const fork = inspectUnverifiedCandidateCheckpointForks([a, b]);
    expect(fork.reason).toBe("DENIED_CONFLICTING_CANDIDATE_TIPS");
    assertNoProductionAuthority(fork);
    const timeline = inspectUnverifiedCandidateCheckpointTimeline([a, b]);
    expect(timeline.candidateSubmittedTimelineInternallyConsistent).toBe(false);
    assertNoProductionAuthority(timeline);
  });

  it("rejects cross-sequence hash reuse across both fork and timeline modules", () => {
    const input = [
      tip(1, -25),
      tip(2, -15, { lastReceiptHash: hash(1) }),
    ];
    expect(inspectUnverifiedCandidateCheckpointForks(input).reason)
      .toBe("DENIED_CANDIDATE_HASH_SCOPE_REUSE");
    expect(inspectUnverifiedCandidateCheckpointTimeline(input)
      .candidateSubmittedTimelineInternallyConsistent).toBe(false);
  });

  it("rejects missing submitted sequence without claiming full-history coverage", () => {
    const rows = [tip(1, -25), tip(3, -8)];
    expect(inspectUnverifiedCandidateCheckpointTimeline(rows).reason)
      .toBe("DENIED_SUBMITTED_SEQUENCE_GAP");
    expect(checkWindow({ ...earlier(), tips: rows })
      .candidateWindowInternallyBracketed).toBe(false);
  });

  it("rejects candidate clock rollback in timeline and window comparison", () => {
    const rows = [tip(1, -10), tip(2, -15), tip(3, -8)];
    expect(inspectUnverifiedCandidateCheckpointTimeline(rows)
      .candidateSubmittedTimelineInternallyConsistent).toBe(false);
    expect(checkWindow({ ...earlier(), tips: rows })
      .candidateWindowInternallyBracketed).toBe(false);
  });

  it("rejects a candidate window with a missing trailing bracket", () => {
    const w = earlier();
    const r = checkWindow({ ...w, tips: w.tips.slice(0, 3) });
    expect(r.reason).toBe("DENIED_UNBRACKETED_CANDIDATE_END");
    assertNoProductionAuthority(r);
  });

  it("rejects shared candidate hashes that conflict across overlapping windows", () => {
    const second = later();
    const changed = second.tips.map(t =>
      t.sequence === 3 ? { ...t, lastReceiptHash: hash(333) } : t,
    );
    const r = inspectUnverifiedCandidateWindowOverlap({
      earlier: earlier(), later: { ...second, tips: changed },
    });
    expect(r.reason).toBe("DENIED_CONFLICTING_CANDIDATE_TIPS");
    assertNoProductionAuthority(r);
  });

  it("rejects windows with no submitted shared checkpoint even when time overlaps", () => {
    const second = later();
    const disjoint = [
      tip(9, -15), tip(10, -8), tip(11, 0), tip(12, 7),
    ];
    const r = inspectUnverifiedCandidateWindowOverlap({
      earlier: earlier(), later: { ...second, tips: disjoint },
    });
    expect(r.reason).toBe("DENIED_NO_SHARED_CANDIDATE_ANCHOR");
    assertNoProductionAuthority(r);
  });

  it("demonstrates omitted forks cannot be found in separate candidate calls", () => {
    const left = inspectUnverifiedCandidateCheckpointForks([tip(1, -25)]);
    const right = inspectUnverifiedCandidateCheckpointForks([
      tip(1, -25, { lastReceiptHash: hash(999) }),
    ]);
    expect(left.candidateSubmittedSetInternallyConsistent).toBe(true);
    expect(right.candidateSubmittedSetInternallyConsistent).toBe(true);
    assertNoProductionAuthority(left);
    assertNoProductionAuthority(right);
  });

  it("demonstrates caller-fabricated host labels are not independent identity", () => {
    const a = earlier(), b = later();
    const fake = "arbitrary-host-not-attested";
    const rename = (w: UnverifiedCandidateWindow): UnverifiedCandidateWindow => ({
      ...w,
      tips: w.tips.map(t => ({ ...t, hostId: fake })),
    });
    const r = inspectUnverifiedCandidateWindowOverlap({
      earlier: rename(a), later: rename(b),
    });
    expect(r.candidateOverlapInternallyConsistent).toBe(true);
    expect(r.independentHostAuthenticated).toBe(false);
    expect(r.deploymentMembershipComplete).toBe(false);
    expect(r.canPublish).toBe(false);
  });

  it("does not expose candidate IDs or digests in any positive diagnostic", () => {
    for (const r of allPositiveCandidateDiagnostics()) {
      const serialized = JSON.stringify(r);
      expect(serialized).not.toContain("claimed-host");
      expect(serialized).not.toContain("unverified-principal");
      expect(serialized).not.toContain(hash(3));
    }
  });

  it("does not mutate caller-provided candidate Date objects", () => {
    const a = earlier(), b = later();
    const t = a.tips[0];
    const before = {
      time: t.observedAt.getTime(),
      signed: t.signedAt.getTime(),
      hash: t.lastReceiptHash,
      length: a.tips.length,
    };
    const r = inspectUnverifiedCandidateWindowOverlap({ earlier: a, later: b });
    expect(r.candidateOverlapInternallyConsistent).toBe(true);
    expect(t.observedAt.getTime()).toBe(before.time);
    expect(t.signedAt.getTime()).toBe(before.signed);
    expect(t.lastReceiptHash).toBe(before.hash);
    expect(a.tips.length).toBe(before.length);
  });

  it("fails closed on sparse submitted batches and never grants trust", () => {
    const sparse = new Array(3) as UnverifiedCandidateReceiptCheckpoint[];
    const outputs = [
      inspectUnverifiedCandidateCheckpointForks(sparse),
      inspectUnverifiedCandidateCheckpointTimeline(sparse),
      checkWindow({ ...earlier(), tips: sparse }),
      inspectUnverifiedCandidateWindowOverlap({
        earlier: { ...earlier(), tips: sparse }, later: later(),
      }),
    ];
    for (const output of outputs) {
      assertNoProductionAuthority(output);
      expect(output.canPublish).toBe(false);
    }
  });
});
