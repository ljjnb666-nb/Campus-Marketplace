import { beforeEach, describe, expect, it, vi } from "vitest";

const { groupBy, findMany } = vi.hoisted(() => ({
  groupBy: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    riskFlag: {
      groupBy,
      findMany,
    },
  },
}));

import {
  evaluateRiskSignalBuckets,
  loadAuthorizedRiskIntelligence,
  resolveAuthorizedRiskScope,
  RISK_RULESET_VERSION,
} from "@/lib/risk/risk-intelligence";

beforeEach(() => {
  groupBy.mockReset().mockResolvedValue([]);
  findMany.mockReset().mockResolvedValue([]);
});

describe("Phase 10D explainable risk rules", () => {
  it("keeps unconfirmed reports/disputes advisory-only", () => {
    const result = evaluateRiskSignalBuckets([
      { kind: "REPORT_SUBMITTED", severity: "HIGH", count: 9 },
      { kind: "RENTAL_DISPUTE_OPENED", severity: "HIGH", count: 4 },
    ]);

    expect(result.attentionLevel).toBe("OBSERVE");
    expect(result.recommendedAction).toBe("MONITOR");
    expect(result.matchedRules).toEqual([
      { ruleId: "UNCONFIRMED_REPORT_CONTEXT", signalCount: 9 },
      { ruleId: "DISPUTE_CONTEXT_ONLY", signalCount: 4 },
    ]);
  });

  it("human-confirmed signals escalate deterministically without a numeric score", () => {
    const result = evaluateRiskSignalBuckets([
      { kind: "REPORT_CONFIRMED", severity: "MEDIUM", count: 2 },
      { kind: "MANUAL_FLAG", severity: "HIGH", count: 1 },
    ]);

    expect(result.attentionLevel).toBe("PRIORITY_REVIEW");
    expect(result.recommendedAction).toBe("PRIORITY_OPERATOR_REVIEW");
    expect(result.activeSignalCount).toBe(3);
    expect(result.matchedRules).toEqual([
      { ruleId: "MANUAL_HIGH_SIGNAL", signalCount: 1 },
      { ruleId: "CONFIRMED_REPORT_PRESENT", signalCount: 2 },
      { ruleId: "MANUAL_REVIEW_SIGNAL", signalCount: 1 },
    ]);
    expect(RISK_RULESET_VERSION).toBe(1);
    expect(result).not.toHaveProperty("riskScore");
    expect(result).not.toHaveProperty("trustScore");
  });

  it("returns CLEAR for no active signal", () => {
    expect(evaluateRiskSignalBuckets([])).toEqual({
      attentionLevel: "CLEAR",
      recommendedAction: "NONE",
      matchedRules: [],
      activeSignalCount: 0,
      signalBreakdown: [],
    });
  });
});

describe("Phase 10D authorization scope", () => {
  it("campus-only access requires one exact authorized campus", () => {
    const access = { global: false, campusIds: ["A"] };
    expect(resolveAuthorizedRiskScope(access, "A")).toEqual({
      scope: { kind: "CAMPUS", campusId: "A" },
      whereScope: { campusId: "A" },
    });
    expect(() => resolveAuthorizedRiskScope(access, "B")).toThrow(
      "RISK_INTELLIGENCE_SCOPE_DENIED",
    );
    expect(() => resolveAuthorizedRiskScope(access)).toThrow(
      "RISK_INTELLIGENCE_SCOPE_DENIED",
    );
  });

  it("global access may use all scopes or one exact campus", () => {
    const access = { global: true, campusIds: [] };
    expect(resolveAuthorizedRiskScope(access)).toEqual({
      scope: { kind: "ALL_SCOPES" },
      whereScope: {},
    });
    expect(resolveAuthorizedRiskScope(access, "A")).toEqual({
      scope: { kind: "CAMPUS", campusId: "A" },
      whereScope: { campusId: "A" },
    });
  });
});

describe("Phase 10D authorized read model", () => {
  it("pushes campus scope into the DB query and returns minimized evidence", async () => {
    groupBy.mockResolvedValue([
      {
        kind: "REPORT_CONFIRMED",
        severity: "MEDIUM",
        _count: { _all: 2 },
      },
    ]);
    findMany.mockResolvedValue([
      {
        id: "flag-1",
        kind: "REPORT_CONFIRMED",
        severity: "MEDIUM",
        campusId: "A",
        sourceType: "REPORT",
        createdAt: new Date("2026-10-08T00:00:00.000Z"),
      },
    ]);

    const result = await loadAuthorizedRiskIntelligence({
      access: { global: false, campusIds: ["A"] },
      targetUserId: "target-1",
      campusId: "A",
      evaluatedAt: new Date("2026-10-08T01:00:00.000Z"),
    });

    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "target-1", status: "ACTIVE", campusId: "A" },
      }),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "target-1", status: "ACTIVE", campusId: "A" },
        take: 50,
        select: {
          id: true,
          kind: true,
          severity: true,
          campusId: true,
          sourceType: true,
          createdAt: true,
        },
      }),
    );
    expect(result).toMatchObject({
      rulesetVersion: 1,
      scope: { kind: "CAMPUS", campusId: "A" },
      attentionLevel: "REVIEW",
      activeSignalCount: 2,
      evidenceTruncated: true,
    });
    expect(result.evidence[0]).toEqual({
      signalId: "flag-1",
      kind: "REPORT_CONFIRMED",
      severity: "MEDIUM",
      campusId: "A",
      sourceType: "REPORT",
      createdAt: "2026-10-08T00:00:00.000Z",
    });
    expect(result.evidence[0]).not.toHaveProperty("sourceId");
    expect(result.evidence[0]).not.toHaveProperty("note");
  });
});
