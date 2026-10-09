import { describe, expect, it } from "vitest";
import { FUNNEL_CAPTURE_STREAMS, type ClaimedCaptureInterval } from
  "@/lib/analytics/funnel-capture-continuity";
import {
  diagnoseCandidateFleetRoster,
  type CandidateFleetEpoch,
  type CandidateFleetInstance,
} from "@/lib/analytics/funnel-fleet-roster-gap";

const DAY = 86_400_000;
const start = new Date("2026-01-01T00:00:00.000Z");
const end = new Date(start.getTime() + 7 * DAY);
const through = new Date(end.getTime() + 7 * DAY);
const observed = new Date(through.getTime() + DAY);
const shaA = "a".repeat(40);
const shaB = "b".repeat(40);
const app = (instanceId = "app.01", releaseSha = shaA): CandidateFleetInstance =>
  ({ instanceId, releaseSha, role: "APP" });
const worker = (instanceId = "worker.01", releaseSha = shaA): CandidateFleetInstance =>
  ({ instanceId, releaseSha, role: "ASYNC_WORKER" });
const epoch = (
  instances: readonly CandidateFleetInstance[],
  from = start, until = through,
): CandidateFleetEpoch => ({ from, until, instances });
const claim = (
  stream: (typeof FUNNEL_CAPTURE_STREAMS)[number],
  instance: CandidateFleetInstance,
  from = start, until = through,
  attrs: Partial<ClaimedCaptureInterval> = {},
): ClaimedCaptureInterval => ({
  campusId: "campus-a", stream, instanceId: instance.instanceId,
  releaseSha: instance.releaseSha, from, until, captureEnabled: true,
  source: "UNVERIFIED", ...attrs,
});
const claimsFor = (
  instances: readonly CandidateFleetInstance[],
  from = start, until = through,
): ClaimedCaptureInterval[] => instances.flatMap(instance =>
  FUNNEL_CAPTURE_STREAMS.filter(stream =>
    instance.role === "APP" ? stream !== "PROJECTION_WORKER" :
      stream === "PROJECTION_WORKER"
  ).map(stream => claim(stream, instance, from, until)));
const input = (
  fleet: readonly CandidateFleetEpoch[] = [epoch([app(), worker()])],
  claims: readonly ClaimedCaptureInterval[] = claimsFor([app(), worker()]),
) => ({
  campusId: "campus-a", cohortStart: start, cohortEnd: end,
  observedThrough: observed, candidateFleetEpochs: fleet,
  claimedIntervals: claims,
});

describe("10K-R2d-03B-02A candidate fleet census gaps remain negative-only", () => {
  it("never confuses a complete-looking candidate roster with independent authority", () => {
    expect(diagnoseCandidateFleetRoster(input())).toEqual({
      status: "UNAVAILABLE_INDEPENDENT_FLEET_AUTHORITY_MISSING",
      canPublish: false, captureContinuityProven: false,
      deploymentMembershipComplete: false,
      candidateRosterCoversWindow: true,
      allListedInstancesHaveClaims: true,
      reasons: [],
    });
  });

  it("cannot derive all-zero activity from an absent roster or zero observed claims", () => {
    const result = diagnoseCandidateFleetRoster(input([], []));
    expect(result).toMatchObject({
      candidateRosterCoversWindow: false,
      allListedInstancesHaveClaims: false,
      reasons: ["NO_CANDIDATE_ROSTER", "CANDIDATE_ROSTER_GAP"],
      canPublish: false,
    });
  });

  it("requires claims for BOTH old and new app instances during rolling deployment", () => {
    const split = new Date(start.getTime() + 4 * DAY);
    const oldApp = app("app.old", shaA);
    const newApp = app("app.new", shaB);
    const wk = worker();
    const fleet = [
      epoch([oldApp, wk], start, split),
      epoch([oldApp, newApp, wk], split, through),
    ];
    // "Per-stream union" appears complete without any claim from the new app.
    const claims = claimsFor([oldApp, wk]);
    const result = diagnoseCandidateFleetRoster(input(fleet, claims));
    expect(result).toMatchObject({
      candidateRosterCoversWindow: true,
      allListedInstancesHaveClaims: false,
      reasons: ["INSTANCE_STREAM_CLAIM_GAP"],
    });
  });

  it("never borrows another campus's stream claims", () => {
    const all = claimsFor([app(), worker()]);
    const mismatched = all.map(c => ({
      ...c, campusId: c.stream === "FIRST_REPLY" ? "campus-b" : "campus-a",
    }));
    const result = diagnoseCandidateFleetRoster(input(undefined, mismatched));
    expect(result.reasons).toEqual(["INSTANCE_STREAM_CLAIM_GAP"]);
    expect(result.allListedInstancesHaveClaims).toBe(false);
  });

  it("rejects missing async worker and missing app roster membership separately", () => {
    const missingWorker = diagnoseCandidateFleetRoster(
      input([epoch([app()])], claimsFor([app()])));
    expect(missingWorker.reasons).toContain("WORKER_INSTANCE_ABSENT");
    const missingApp = diagnoseCandidateFleetRoster(
      input([epoch([worker()])], claimsFor([worker()])));
    expect(missingApp.reasons).toContain("APP_INSTANCE_ABSENT");
    expect(missingApp.deploymentMembershipComplete).toBe(false);
  });

  it("rejects 1ms roster hole; adjacent half-open frames are continuous", () => {
    const mid = new Date(start.getTime() + 4 * DAY);
    const gap = new Date(mid.getTime() + 1);
    const instances = [app(), worker()];
    expect(diagnoseCandidateFleetRoster(input([
      epoch(instances, start, mid), epoch(instances, gap, through),
    ])).reasons).toContain("CANDIDATE_ROSTER_GAP");
    expect(diagnoseCandidateFleetRoster(input([
      epoch(instances, start, mid), epoch(instances, mid, through),
    ])).candidateRosterCoversWindow).toBe(true);
  });

  it("treats overlapping snapshots as ambiguous rather than selecting a convenient one", () => {
    const mid = new Date(start.getTime() + 4 * DAY);
    const overlap = new Date(mid.getTime() - 1);
    const result = diagnoseCandidateFleetRoster(input([
      epoch([app(), worker()], start, mid),
      epoch([app(), worker()], overlap, through),
    ]));
    expect(result.reasons).toContain("CANDIDATE_ROSTER_OVERLAP");
    expect(result.candidateRosterCoversWindow).toBe(false);
  });

  it("does not accept a claim for the wrong release SHA or instance ID", () => {
    const current = app("app.02", shaB);
    const roster = [epoch([current, worker()])];
    const result = diagnoseCandidateFleetRoster(input(
      roster, claimsFor([app("app.02", shaA), worker()])));
    expect(result.reasons).toContain("INSTANCE_STREAM_CLAIM_GAP");
    expect(result.allListedInstancesHaveClaims).toBe(false);
  });

  it("marks disabled overlapping claims even if another enabled claim covers the epoch", () => {
    const claims = claimsFor([app(), worker()]);
    claims.push(claim("LISTING_CREATED", app(), start, through, { captureEnabled: false }));
    const result = diagnoseCandidateFleetRoster(input(undefined, claims));
    expect(result.reasons).toEqual(["DISABLED_CAPTURE_CLAIM"]);
    expect(result.allListedInstancesHaveClaims).toBe(false);
  });

  it("does not elevate descriptive DEPLOY_LOG or HEARTBEAT provenance into authority", () => {
    const claims = claimsFor([app(), worker()]).map(c => ({
      ...c, source: "DEPLOY_LOG" as const,
    }));
    const result = diagnoseCandidateFleetRoster(input(undefined, claims));
    expect(result.reasons).toEqual([
      "INVALID_UNVERIFIED_CLAIM", "INSTANCE_STREAM_CLAIM_GAP",
    ]);
    expect(result.canPublish).toBe(false);
  });

  it("accepts split adjacent unverified claims but denies a 1ms claim hole", () => {
    const middle = new Date(start.getTime() + 3 * DAY);
    const instances = [app(), worker()];
    const split = [
      ...claimsFor(instances, start, middle),
      ...claimsFor(instances, middle, through),
    ];
    expect(diagnoseCandidateFleetRoster(input(undefined, split))
      .allListedInstancesHaveClaims).toBe(true);
    const bad = split.filter(c =>
      !(c.stream === "FIRST_REPLY" && c.from.getTime() === middle.getTime()));
    bad.push(claim("FIRST_REPLY", app(), new Date(middle.getTime() + 1), through));
    expect(diagnoseCandidateFleetRoster(input(undefined, bad))
      .reasons).toContain("INSTANCE_STREAM_CLAIM_GAP");
  });

  it("refuses malformed instances, duplicated identity, invalid epoch and excessive inputs", () => {
    const bad = [
      app("duplicate"), app("duplicate"), worker(),
    ];
    expect(diagnoseCandidateFleetRoster(input([epoch(bad)])).reasons)
      .toContain("INVALID_CANDIDATE_ROSTER");
    for (const frames of [
      [epoch([app(), worker()], through, start)],
      [epoch([app("../invalid"), worker()])],
      Array(513).fill(epoch([app(), worker()])),
      [epoch(Array(129).fill(app()))],
    ]) {
      const result = diagnoseCandidateFleetRoster(input(frames));
      expect(result.canPublish).toBe(false);
      expect(result.deploymentMembershipComplete).toBe(false);
    }
    expect(diagnoseCandidateFleetRoster(input(undefined,
      Array(10001).fill(claim("FIRST_REPLY", app())))).status).toBe("INVALID_WINDOW");
  });

  it("denies immature and non-7/30-day cohort windows", () => {
    expect(diagnoseCandidateFleetRoster({
      ...input(), observedThrough: new Date(through.getTime() - 1),
    }).status).toBe("IMMATURE_COHORT");
    expect(diagnoseCandidateFleetRoster({
      ...input(), cohortEnd: new Date(start.getTime() + 6 * DAY),
    }).status).toBe("INVALID_WINDOW");
  });

  it("handles mature 30-day cohorts and clamps epoch boundaries", () => {
    const thirty = new Date(start.getTime() + 30 * DAY);
    const until = new Date(thirty.getTime() + 7 * DAY);
    const extraStart = new Date(start.getTime() - DAY);
    const extraEnd = new Date(until.getTime() + DAY);
    const instances = [app(), worker()];
    const result = diagnoseCandidateFleetRoster({
      ...input(),
      cohortEnd: thirty, observedThrough: new Date(until.getTime() + 2 * DAY),
      candidateFleetEpochs: [epoch(instances, extraStart, extraEnd)],
      claimedIntervals: claimsFor(instances, extraStart, extraEnd),
    });
    expect(result).toMatchObject({
      canPublish: false, deploymentMembershipComplete: false,
      candidateRosterCoversWindow: true, allListedInstancesHaveClaims: true,
    });
  });

  it("does not leak campus, instance, release or stream claim identities", () => {
    const json = JSON.stringify(diagnoseCandidateFleetRoster(input()));
    expect(json).not.toContain("campus-a");
    expect(json).not.toContain("app.01");
    expect(json).not.toContain("worker.01");
    expect(json).not.toContain(shaA);
  });
});
