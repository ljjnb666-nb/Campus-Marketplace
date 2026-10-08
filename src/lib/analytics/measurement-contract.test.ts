import { describe, expect, it } from "vitest";
import {
  PHASE_10K_PENDING_MEASUREMENTS,
  presentVerifiedRate,
} from "@/lib/analytics/measurement-contract";

describe("Phase 10K-R1 no-fabricated-metrics contract", () => {
  it("does not silently change uninstrumented metrics into available metrics", () => {
    expect(PHASE_10K_PENDING_MEASUREMENTS).toHaveLength(6);
    expect(new Set(PHASE_10K_PENDING_MEASUREMENTS.map((x) => x.key)).size).toBe(6);
    expect(PHASE_10K_PENDING_MEASUREMENTS.every((x) =>
      x.version === 1 && x.status === "UNAVAILABLE_PENDING_INSTRUMENTATION"
    )).toBe(true);
  });

  it("does not give global search telemetry a false campus attribution", () => {
    const search = PHASE_10K_PENDING_MEASUREMENTS.find((m) => m.key === "SEARCH_ZERO_RESULT_RATE");
    expect(search?.scope).toBe("GLOBAL_ONLY");
    expect(search?.authority).toBe("AGGREGATED_REQUEST_TELEMETRY");
  });

  it("withholds pilot north star pending a product-owned definition", () => {
    const metric = PHASE_10K_PENDING_MEASUREMENTS.find((m) => m.key === "PILOT_NORTH_STAR");
    expect(metric).toMatchObject({
      authority: "PRODUCT_DECISION_PENDING",
      status: "UNAVAILABLE_PENDING_INSTRUMENTATION",
      numerator: null, denominator: null,
    });
  });

  it("never conflates absent facts with a zero percent rate", () => {
    expect(presentVerifiedRate({ numerator: null, denominator: null, authorityComplete: true }))
      .toEqual({ available: false, reason: "MISSING_AUTHORITY" });
    expect(presentVerifiedRate({ numerator: 0, denominator: 0, authorityComplete: true }))
      .toEqual({ available: false, reason: "NO_ELIGIBLE_COHORT" });
    expect(presentVerifiedRate({ numerator: 0, denominator: 10, authorityComplete: false }))
      .toEqual({ available: false, reason: "MISSING_AUTHORITY" });
    expect(presentVerifiedRate({ numerator: 0, denominator: 10, authorityComplete: true }))
      .toEqual({ available: true, numerator: 0, denominator: 10, percent: "0.00" });
  });

  it("rejects corrupt, nonintegral, unsafe and negative counts", () => {
    for (const [numerator, denominator] of [
      [2, 1], [-1, 10], [1, -1], [1.5, 10], [NaN, 20],
      [Infinity, 20], [1, Number.MAX_SAFE_INTEGER + 1],
    ]) {
      expect(presentVerifiedRate({ numerator, denominator, authorityComplete: true }))
        .toEqual({ available: false, reason: "COUNT_INVARIANT_FAILED" });
    }
  });

  it("computes ratios only after cohort completeness proof, without event guessing", () => {
    expect(presentVerifiedRate({ numerator: 1, denominator: 3, authorityComplete: true }))
      .toEqual({ available: true, numerator: 1, denominator: 3, percent: "33.33" });
  });
});
