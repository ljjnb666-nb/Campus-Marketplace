import { describe, expect, it } from "vitest";
import type { CandidateFleetInstance } from "@/lib/analytics/funnel-fleet-roster-gap";
import {
  replayUnverifiedHostLifecycle,
  type UnverifiedHostLifecycleObservation as Observation,
} from "@/lib/analytics/funnel-host-lifecycle-replay";

const DAY = 86_400_000;
const MIN = 60_000;
const start = new Date("2026-01-01T00:00:00.000Z");
const end = new Date(start.getTime() + 7 * DAY);
const until = new Date(end.getTime() + 7 * DAY);
const app: CandidateFleetInstance = {
  instanceId: "app.01", role: "APP", releaseSha: "a".repeat(40),
};
const worker: CandidateFleetInstance = {
  instanceId: "worker.01", role: "ASYNC_WORKER", releaseSha: "a".repeat(40),
};
const moment = (minutes: number): Date => new Date(start.getTime() + minutes * MIN);
const BASE: Observation = {
  origin: "UNVERIFIED_HOST_OBSERVER", hostId: "host.01",
  sessionId: "boot.01", sequence: 1, observedAt: start,
  kind: "BASELINE", instances: [app, worker],
};
const heartbeat = (minutes: number, sequence: number): Observation => ({
  origin: "UNVERIFIED_HOST_OBSERVER", hostId: "host.01",
  sessionId: "boot.01", sequence, observedAt: moment(minutes),
  kind: "HEARTBEAT",
});
const durationMinutes = 14 * 24 * 60;
const complete = (): Observation[] => {
  const obs = [BASE];
  for (let minute = 15; minute <= durationMinutes; minute += 15) {
    obs.push(heartbeat(minute, obs.length + 1));
  }
  return obs;
};
const input = (observations: readonly Observation[] = complete()) => ({
  cohortStart: start, cohortEnd: end, observedThrough: until, observations,
});
const renumber = (rows: readonly Observation[]): Observation[] =>
  rows.map((row, i) => ({ ...row, sequence: i + 1 }));
const reasonsFor = (rows: readonly Observation[]) =>
  replayUnverifiedHostLifecycle(input(rows)).reasons;

describe("10K-R2d-03B-02B-01 unverified host lifecycle candidate replay", () => {
  it("never turns a perfect candidate observation series into authority or KPI permission", () => {
    expect(replayUnverifiedHostLifecycle(input())).toEqual({
      status: "UNAVAILABLE_INDEPENDENT_HOST_OBSERVER_MISSING",
      canPublish: false, deploymentMembershipComplete: false,
      captureContinuityProven: false,
      candidateHistoryInternallyConsistent: true, reasons: [],
    });
  });

  it("treats an empty host record as unknown rather than zero fleet instances", () => {
    expect(replayUnverifiedHostLifecycle(input([]))).toMatchObject({
      candidateHistoryInternallyConsistent: false,
      reasons: ["NO_OBSERVATIONS", "POST_WINDOW_UNKNOWN"],
      canPublish: false,
    });
  });

  it("detects skipped and replayed sequence numbers even with apparently continuous heartbeats", () => {
    const gap = complete();
    gap[10] = { ...gap[10]!, sequence: gap[10]!.sequence + 2 };
    expect(reasonsFor(gap)).toContain("SEQUENCE_GAP_OR_REPLAY");

    const replay = complete();
    replay[15] = { ...replay[15]!, sequence: replay[14]!.sequence };
    expect(reasonsFor(replay)).toContain("SEQUENCE_GAP_OR_REPLAY");
  });

  it("detects clock rollback instead of sorting potentially hostile records", () => {
    const rows = complete();
    rows[20] = { ...rows[20]!, observedAt: moment(1) };
    expect(reasonsFor(rows)).toContain("CLOCK_NONMONOTONIC");
  });

  it("detects silent observation gaps even if the sequence is contiguous", () => {
    const rows = complete().filter((_, i) => i < 10 || i > 25);
    expect(reasonsFor(renumber(rows))).toContain("OBSERVER_SILENCE");
  });

  it("fails closed on explicit loss of host observation", () => {
    const rows = complete();
    rows[11] = { ...rows[11]!, kind: "DISCONNECTED" };
    expect(reasonsFor(rows)).toContain("OBSERVER_DISCONNECTED");
  });

  it("keeps a pre-window disconnect unknown even if ordinary heartbeats resume without a baseline", () => {
    const beforeStart = new Date(start.getTime() - MIN);
    const preWindowLoss = new Date(start.getTime() - 1);
    const historic: Observation[] = [
      { ...BASE, observedAt: beforeStart },
      { ...heartbeat(0, 2), observedAt: preWindowLoss, kind: "DISCONNECTED" },
      heartbeat(0, 3),
      ...complete().slice(1).map((row, index) => ({ ...row, sequence: index + 4 })),
    ];
    // No 15-minute silence or sequence gap: prior code incorrectly returned
    // candidateHistoryInternallyConsistent=true for this unclosed outage.
    const result = replayUnverifiedHostLifecycle(input(historic));
    expect(result.reasons).toContain("OBSERVER_DISCONNECTED");
    expect(result.candidateHistoryInternallyConsistent).toBe(false);
    expect(result.canPublish).toBe(false);
  });

  it("rejects session switch or same-session midstream baseline reset", () => {
    const session = complete();
    session[15] = { ...session[15]!, sessionId: "boot.02" };
    expect(reasonsFor(session)).toContain("SESSION_BOUNDARY_UNVERIFIED");

    const reset = complete();
    reset[20] = { ...reset[20]!, kind: "BASELINE", instances: [app, worker] };
    expect(reasonsFor(reset)).toContain("BASELINE_RESET");
  });

  it("requires an initial baseline and a window-start observation", () => {
    const missing = complete();
    missing[0] = { ...missing[0]!, kind: "HEARTBEAT", instances: undefined };
    expect(reasonsFor(missing)).toContain("MISSING_INITIAL_BASELINE");

    const late = complete();
    late[0] = { ...late[0]!, observedAt: moment(1) };
    expect(reasonsFor(late)).toContain("PRE_WINDOW_UNKNOWN");
  });

  it("does not assume capture through the attribution tail without a closing observation", () => {
    const rows = complete().slice(0, -1);
    expect(reasonsFor(rows)).toContain("POST_WINDOW_UNKNOWN");
    expect(replayUnverifiedHostLifecycle(input(rows))
      .candidateHistoryInternallyConsistent).toBe(false);
  });

  it("detects duplicate births, wrong-release stops and unknown stops", () => {
    const duplicate = complete();
    duplicate[18] = { ...duplicate[18]!, kind: "START", instance: app };
    expect(reasonsFor(duplicate)).toContain("LIFECYCLE_CONFLICT");

    const wrongStop = complete();
    wrongStop[19] = { ...wrongStop[19]!, kind: "STOP",
      instance: { ...app, releaseSha: "b".repeat(40) } };
    expect(reasonsFor(wrongStop)).toContain("LIFECYCLE_CONFLICT");

    const unknownStop = complete();
    unknownStop[20] = { ...unknownStop[20]!, kind: "STOP",
      instance: { ...worker, instanceId: "worker.not-running" } };
    expect(reasonsFor(unknownStop)).toContain("LIFECYCLE_CONFLICT");
  });

  it("detects a 1ms process absence between healthy heartbeats but not a zero-time handover", () => {
    const rows = complete();
    const at = moment(151);
    const stop: Observation = { ...rows[10]!, kind: "STOP",
      observedAt: at, instance: app };
    const restart: Observation = { ...rows[10]!, kind: "START",
      observedAt: new Date(at.getTime() + 1), instance: app };
    const split = renumber([...rows.slice(0, 11), stop, restart, ...rows.slice(11)]);
    expect(reasonsFor(split)).toContain("APP_ABSENT");

    const sameInstant = renumber([...rows.slice(0, 11), stop,
      { ...restart, observedAt: at }, ...rows.slice(11)]);
    expect(replayUnverifiedHostLifecycle(input(sameInstant))
      .candidateHistoryInternallyConsistent).toBe(true);
  });

  it("detects zero-app or zero-worker candidate snapshots during heartbeats", () => {
    const noApp = complete();
    noApp[0] = { ...noApp[0]!, instances: [worker] };
    expect(reasonsFor(noApp)).toContain("APP_ABSENT");

    const noWorker = complete();
    noWorker[0] = { ...noWorker[0]!, instances: [app] };
    expect(reasonsFor(noWorker)).toContain("WORKER_ABSENT");
  });

  it("rejects forged observer origin and malformed boxed identity without coercion", () => {
    const fake = complete();
    fake[15] = { ...fake[15]!,
      origin: "TRUSTED" as Observation["origin"] };
    expect(reasonsFor(fake)).toContain("INVALID_OBSERVATION");

    const boxed = complete();
    boxed[0] = { ...boxed[0]!,
      instances: [{ ...app, releaseSha: new String(app.releaseSha) as unknown as string },
        worker] };
    expect(reasonsFor(boxed)).toContain("INVALID_OBSERVATION");
  });

  it("rejects null, duplicate or excessive snapshot entries without throwing", () => {
    const invalid = complete();
    invalid[0] = { ...invalid[0]!, instances: [null as unknown as CandidateFleetInstance, worker] };
    expect(reasonsFor(invalid)).toContain("INVALID_OBSERVATION");

    const duplicate = complete();
    duplicate[0] = { ...duplicate[0]!, instances: [app, app, worker] };
    expect(reasonsFor(duplicate)).toContain("INVALID_OBSERVATION");

    const oversized = complete();
    oversized[0] = { ...oversized[0]!, instances: Array(129).fill(app) };
    expect(reasonsFor(oversized)).toContain("INVALID_OBSERVATION");
  });

  it("refuses invalid 7-day/30-day cohort bounds and immature windows", () => {
    expect(replayUnverifiedHostLifecycle({ ...input(), cohortEnd: moment(6 * 24 * 60) })
      .status).toBe("INVALID_WINDOW");
    expect(replayUnverifiedHostLifecycle({ ...input(),
      observedThrough: new Date(until.getTime() - 1) }).status).toBe("IMMATURE_COHORT");
  });

  it("does not transfer instance identity, host identity or release SHA in results", () => {
    const result = JSON.stringify(replayUnverifiedHostLifecycle(input()));
    expect(result).not.toContain(app.instanceId);
    expect(result).not.toContain(worker.instanceId);
    expect(result).not.toContain("host.01");
    expect(result).not.toContain(app.releaseSha);
  });

  it("refuses more observations than allowed, without accepting truncated histories", () => {
    const rows = [...complete(), ...Array(12_001).fill(BASE)];
    expect(replayUnverifiedHostLifecycle(input(rows)).status).toBe("INVALID_WINDOW");
  });
});
