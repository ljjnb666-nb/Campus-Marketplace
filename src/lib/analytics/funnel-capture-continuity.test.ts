import { describe, expect, it } from "vitest";
import {
  diagnoseUnverifiedCaptureContinuity,
  FUNNEL_CAPTURE_STREAMS,
  type ClaimedCaptureInterval,
  type FunnelCaptureStream,
} from "@/lib/analytics/funnel-capture-continuity";

const cohortStart = new Date("2026-06-01T00:00:00.000Z");
const cohortEnd = new Date("2026-06-08T00:00:00.000Z");
const observedThrough = new Date("2026-06-16T00:00:00.000Z");
const sha = "a".repeat(40);
const input = (claims: readonly ClaimedCaptureInterval[] = []) => ({
  campusId: "campus-a", cohortStart, cohortEnd, observedThrough,
  claimedIntervals: claims,
});
const claim = (stream: FunnelCaptureStream, attrs: Partial<ClaimedCaptureInterval> = {}):
  ClaimedCaptureInterval => ({
  campusId: "campus-a", stream, instanceId: "app.01", releaseSha: sha,
  from: cohortStart, until: new Date("2026-06-15T00:00:00.000Z"),
  captureEnabled: true, source: "DEPLOY_LOG", ...attrs,
});
const allStreams = () => FUNNEL_CAPTURE_STREAMS.map(x => claim(x));

describe("10K-R2d-03A untrusted capture coverage negative-only contract", () => {
  it("does not infer coverage from an empty ledger or green CI", () => {
    const result = diagnoseUnverifiedCaptureContinuity(input());
    expect(result).toMatchObject({
      status: "UNAVAILABLE_FLEET_AUTHORITY_NOT_ESTABLISHED",
      canPublish: false, captureContinuityProven: false,
      deploymentMembershipComplete: false,
    });
    if (!("deploymentMembershipComplete" in result)) throw Error("invalid result");
    expect(result.streamDiagnostics).toHaveLength(5);
    expect(result.streamDiagnostics.every(s => !s.claimCoversWindow &&
      s.reasons.includes("NO_CLAIMS"))).toBe(true);
  });

  it("refuses publication EVEN IF every stream's log claims continuous capture", () => {
    const result = diagnoseUnverifiedCaptureContinuity(input(allStreams()));
    expect(result).toMatchObject({
      status: "UNAVAILABLE_FLEET_AUTHORITY_NOT_ESTABLISHED",
      canPublish: false, captureContinuityProven: false,
      deploymentMembershipComplete: false,
    });
    expect(result.streamDiagnostics.every(s =>
      s.claimCoversWindow && s.reasons.length === 0)).toBe(true);
  });

  it("requires exact contiguous half-open intervals, including 7d attribution tail", () => {
    const days = (d: number) => new Date(cohortStart.getTime() + d * 86_400_000);
    const result = diagnoseUnverifiedCaptureContinuity(input([
      claim("LISTING_CREATED", { until: days(7) }),
      claim("LISTING_CREATED", { from: days(7), until: days(14), instanceId: "app.02" }),
      claim("CONVERSATION_CREATED", { until: days(7) }),
      claim("CONVERSATION_CREATED", { from: days(7 + 1 / 86_400_000), until: days(14) }),
    ]));
    expect(result.streamDiagnostics.find(s => s.stream === "LISTING_CREATED"))
      .toMatchObject({ claimCoversWindow: true, reasons: [] });
    expect(result.streamDiagnostics.find(s => s.stream === "CONVERSATION_CREATED"))
      .toMatchObject({ claimCoversWindow: false, reasons: ["CLAIMED_INTERVAL_GAP"] });
  });

  it("does not accept a claim that ends before the seven-day attribution tail", () => {
    const result = diagnoseUnverifiedCaptureContinuity(input([
      claim("LISTING_CREATED", { until: cohortEnd }),
    ]));
    expect(result.streamDiagnostics.find(s => s.stream === "LISTING_CREATED"))
      .toMatchObject({ claimCoversWindow: false, reasons: ["CLAIMED_INTERVAL_GAP"] });
  });

  it("excludes other campus and other streams", () => {
    const result = diagnoseUnverifiedCaptureContinuity(input([
      claim("LISTING_CREATED", { campusId: "campus-b" }),
      claim("ORDER_ATTRIBUTION"),
    ]));
    expect(result.streamDiagnostics.find(s => s.stream === "LISTING_CREATED"))
      .toMatchObject({ claimCoversWindow: false, reasons: ["NO_CLAIMS"] });
    expect(result.streamDiagnostics.find(s => s.stream === "ORDER_ATTRIBUTION"))
      .toMatchObject({ claimCoversWindow: true, reasons: [] });
  });

  it("treats a disabled in-window observation as negative evidence", () => {
    const result = diagnoseUnverifiedCaptureContinuity(input([
      claim("FIRST_REPLY", { captureEnabled: false }),
    ]));
    expect(result.streamDiagnostics.find(s => s.stream === "FIRST_REPLY"))
      .toMatchObject({
        claimCoversWindow: false,
        reasons: ["DISABLED_CLAIM", "CLAIMED_INTERVAL_GAP"],
      });
  });

  it("does not flag disabled coverage outside the observation window", () => {
    const result = diagnoseUnverifiedCaptureContinuity(input([
      claim("FIRST_REPLY", { from: new Date("2026-05-01T00:00:00Z"),
        until: new Date("2026-05-10T00:00:00Z"), captureEnabled: false }),
      claim("FIRST_REPLY"),
    ]));
    expect(result.streamDiagnostics.find(s => s.stream === "FIRST_REPLY"))
      .toMatchObject({ claimCoversWindow: true, reasons: [] });
  });

  it("rejects invalid release, instance, source, interval, or unaudited switch shape", () => {
    const invalid: ClaimedCaptureInterval[] = [
      claim("ORDER_ATTRIBUTION", { releaseSha: "unknown" }),
      claim("ORDER_ATTRIBUTION", { instanceId: "../secret" }),
      claim("ORDER_ATTRIBUTION", { source: "FAKE" as "DEPLOY_LOG" }),
      claim("ORDER_ATTRIBUTION", { until: cohortStart }),
      claim("ORDER_ATTRIBUTION", { from: new Date("invalid") }),
      claim("ORDER_ATTRIBUTION", { captureEnabled: "yes" as unknown as boolean }),
    ];
    const result = diagnoseUnverifiedCaptureContinuity(input(invalid));
    expect(result.streamDiagnostics.find(s => s.stream === "ORDER_ATTRIBUTION"))
      .toMatchObject({ claimCoversWindow: false });
    expect(result.streamDiagnostics.find(s => s.stream === "ORDER_ATTRIBUTION")?.reasons)
      .toContain("INVALID_CLAIM");
  });

  it("future claims cannot be counted as historical capture", () => {
    const result = diagnoseUnverifiedCaptureContinuity(input([
      claim("PROJECTION_WORKER", { until: new Date("2026-07-01T00:00:00Z") }),
    ]));
    expect(result.streamDiagnostics.find(s => s.stream === "PROJECTION_WORKER"))
      .toMatchObject({ claimCoversWindow: false, reasons: ["INVALID_CLAIM", "CLAIMED_INTERVAL_GAP"] });
  });

  it("does not mistake a current heartbeat for 14 days of runtime coverage", () => {
    const result = diagnoseUnverifiedCaptureContinuity(input([
      claim("PROJECTION_WORKER", { from: new Date("2026-06-14T23:00:00Z"),
        source: "RUNTIME_HEARTBEAT" }),
    ]));
    expect(result.streamDiagnostics.find(s => s.stream === "PROJECTION_WORKER"))
      .toMatchObject({ claimCoversWindow: false, reasons: ["CLAIMED_INTERVAL_GAP"] });
  });

  it("repeated/overlapping claims do not confer authority", () => {
    const all = allStreams();
    const result = diagnoseUnverifiedCaptureContinuity(input([...all, ...all]));
    expect(result).toMatchObject({
      status: "UNAVAILABLE_FLEET_AUTHORITY_NOT_ESTABLISHED",
      captureContinuityProven: false, canPublish: false,
    });
  });

  it("refuses immature cohorts BEFORE evaluating any claims", () => {
    expect(diagnoseUnverifiedCaptureContinuity({
      ...input(allStreams()),
      observedThrough: new Date(cohortEnd.getTime() + 7 * 86_400_000 - 1),
    })).toEqual({
      status: "IMMATURE_COHORT", canPublish: false,
      captureContinuityProven: false, streamDiagnostics: [],
    });
  });

  it("supports 30-day mature UTC cohorts with an extra seven-day tail", () => {
    const end = new Date(cohortStart.getTime() + 30 * 86_400_000);
    const through = new Date(end.getTime() + 7 * 86_400_000);
    const result = diagnoseUnverifiedCaptureContinuity({
      campusId: "campus-a", cohortStart, cohortEnd: end, observedThrough: through,
      claimedIntervals: FUNNEL_CAPTURE_STREAMS.map(stream => claim(stream, { until: through })),
    });
    expect(result.streamDiagnostics.every(s => s.claimCoversWindow)).toBe(true);
    expect(result.canPublish).toBe(false);
  });

  it("rejects corrupt windows and excess untrusted claims without any output identifiers", () => {
    const cases = [
      { ...input(), campusId: "" },
      { ...input(), cohortEnd: cohortStart },
      { ...input(), cohortStart: new Date("invalid") },
      { ...input(), cohortEnd: new Date(cohortStart.getTime() + 6 * 86_400_000) },
      { ...input(), claimedIntervals: Array(10001).fill(claim("FIRST_REPLY")) },
    ];
    for (const arg of cases) {
      expect(diagnoseUnverifiedCaptureContinuity(arg)).toEqual({
        status: "INVALID_WINDOW", canPublish: false,
        captureContinuityProven: false, streamDiagnostics: [],
      });
    }
    const redacted = JSON.stringify(diagnoseUnverifiedCaptureContinuity(input(allStreams())));
    expect(redacted).not.toContain("app.01");
    expect(redacted).not.toContain(sha);
    expect(redacted).not.toContain("campus-a");
  });
});
