import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadAuthorizationContext: vi.fn(),
  transaction: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
}));
vi.mock("@/lib/rbac/service", () => ({
  loadAuthorizationContext: mocks.loadAuthorizationContext,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));

import { loadAuthorizedFunnelDiagnostic } from "@/lib/analytics/funnel-diagnostic-read";
import {
  diagnoseUnverifiedCaptureContinuity,
  FUNNEL_CAPTURE_STREAMS,
  type ClaimedCaptureInterval,
} from "@/lib/analytics/funnel-capture-continuity";
import {
  inspectUnverifiedCandidateCheckpointForks,
} from "@/lib/analytics/funnel-host-observer-candidate-fork";
import {
  inspectUnverifiedCandidateWindowOverlap,
  type UnverifiedCandidateWindow,
} from "@/lib/analytics/funnel-host-observer-candidate-overlap";
import type {
  UnverifiedCandidateReceiptCheckpoint,
} from "@/lib/analytics/funnel-host-observer-candidate-checkpoint";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const COHORT_END = new Date("2026-10-01T12:00:00.000Z");
const COHORT_START = new Date("2026-09-24T12:00:00.000Z");
const TAIL_END = new Date("2026-10-08T12:00:00.000Z");
const minute = (offset: number) => new Date(NOW.getTime() + offset * 60_000);
const hash = (seq: number) => seq.toString(16).padStart(64, "0");

function tip(
  sequence: number,
  offsetMinutes: number,
  override: Partial<UnverifiedCandidateReceiptCheckpoint> = {},
): UnverifiedCandidateReceiptCheckpoint {
  const observedAt = minute(offsetMinutes);
  return {
    source: "UNVERIFIED_CANDIDATE",
    principalId: "unverified-writer",
    hostId: "claimed-host",
    sessionId: "claimed-boot",
    sequence,
    lastReceiptHash: hash(sequence),
    observedAt,
    signedAt: new Date(observedAt.getTime() + 1_000),
    ...override,
  };
}

function windows(): {
  earlier: UnverifiedCandidateWindow;
  later: UnverifiedCandidateWindow;
} {
  return {
    earlier: {
      windowStart: minute(-20), windowEnd: minute(-5),
      tips: [tip(1, -25), tip(2, -15), tip(3, -8), tip(4, 0)],
    },
    later: {
      windowStart: minute(-12), windowEnd: minute(5),
      tips: [tip(2, -15), tip(3, -8), tip(4, 0), tip(5, 7)],
    },
  };
}

const request = () => ({
  actorId: "authorized-operator",
  campusId: "CAMPUS-A",
  listingType: "PRODUCT" as const,
  periodDays: 7 as const,
  cohortEnd: COHORT_END,
  now: NOW,
});

function authorize(campuses: string[] = ["CAMPUS-A"]): void {
  mocks.loadAuthorizationContext.mockResolvedValue({
    userId: "authorized-operator",
    accountActive: true,
    activeCampusIds: campuses,
    grants: [{
      scope: "CAMPUS", roleKey: "ANALYTICS", campusId: "CAMPUS-A",
      permissionKeys: ["analytics.read"],
    }],
  });
}

const listing = {
  eventType: "LIQUIDITY_LISTING_CREATED", schemaVersion: 1,
  aggregateType: "LISTING", aggregateId: "listing-one",
  occurrenceKey: "LIQUIDITY_LISTING_CREATED:PRODUCT:listing-one",
  campusId: "CAMPUS-A", sourceType: "DOMAIN_TX",
  occurredAt: new Date("2026-09-24T13:00:00.000Z"),
  payload: { listingId: "listing-one", listingType: "PRODUCT" },
};
const conversation = {
  eventType: "LISTING_CONVERSATION_CREATED", schemaVersion: 1,
  aggregateType: "CONVERSATION", aggregateId: "conv-one",
  occurrenceKey: "LISTING_CONVERSATION_CREATED:conv-one",
  campusId: "CAMPUS-A", sourceType: "DOMAIN_TX",
  occurredAt: new Date("2026-09-25T13:00:00.000Z"),
  payload: { conversationId: "conv-one", listingId: "listing-one", listingType: "PRODUCT" },
};

function completeUnverifiedClaimSet(): ClaimedCaptureInterval[] {
  return FUNNEL_CAPTURE_STREAMS.map((stream) => ({
    campusId: "CAMPUS-A",
    stream,
    instanceId: "claimed-instance",
    releaseSha: "a".repeat(40),
    from: new Date(COHORT_START),
    until: new Date(TAIL_END),
    captureEnabled: true,
    source: "UNVERIFIED",
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ANALYTICS_FUNNEL_DIAGNOSTICS", "enabled");
  vi.stubEnv("ANALYTICS_CONVERSATION_EVENT_EMISSION", "enabled");
  vi.stubEnv("ANALYTICS_FIRST_REPLY_EVENT_EMISSION", "enabled");
  vi.stubEnv("ANALYTICS_ORDER_ATTRIBUTION_EMISSION", "enabled");
  vi.stubEnv("ANALYTICS_ORDER_ATTRIBUTION_SECRET", "a-strong-separate-test-secret-longer-than-32-bytes");
  authorize();
  mocks.findMany.mockResolvedValue([listing, conversation]);
  mocks.count.mockResolvedValue(0);
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ domainEvent: { findMany: mocks.findMany, count: mocks.count } }));
});
afterEach(() => vi.unstubAllEnvs());

describe("10K-R2d-03B-02B-02B-10 authorized read cannot promote candidates", () => {
  it("candidate fork pass cannot turn authorized internal counts into published KPI", async () => {
    const candidate = inspectUnverifiedCandidateCheckpointForks(windows().earlier.tips);
    expect(candidate.candidateSubmittedSetInternallyConsistent).toBe(true);
    const result = await loadAuthorizedFunnelDiagnostic(request());
    expect(result.status).toBe("UNAVAILABLE_CAPTURE_CONTINUITY_UNPROVEN");
    expect(result.captureSnapshotReady).toBe(true);
    expect(result.captureContinuityProven).toBe(false);
    expect(result.candidate).toMatchObject({ newListings: 1 });
    expect(JSON.stringify(result)).not.toMatch(/conversionRate|canPublish|publishedKpi/);
    expect(candidate.canPublish).toBe(false);
  });

  it("candidate window overlap pass never satisfies deployment continuity", async () => {
    const candidate = inspectUnverifiedCandidateWindowOverlap(windows());
    expect(candidate.candidateOverlapInternallyConsistent).toBe(true);
    expect(candidate.sharedSubmittedAnchors).toBe(1);
    const result = await loadAuthorizedFunnelDiagnostic(request());
    expect(result.status).toBe("UNAVAILABLE_CAPTURE_CONTINUITY_UNPROVEN");
    expect(result.captureContinuityProven).toBe(false);
    expect(candidate.canPublish).toBe(false);
  });

  it("even five claimed fully-covered streams cannot become independent fleet authority", async () => {
    const coverage = diagnoseUnverifiedCaptureContinuity({
      campusId: "CAMPUS-A",
      cohortStart: COHORT_START,
      cohortEnd: COHORT_END,
      observedThrough: NOW,
      claimedIntervals: completeUnverifiedClaimSet(),
    });
    expect(coverage.status).toBe("UNAVAILABLE_FLEET_AUTHORITY_NOT_ESTABLISHED");
    expect(coverage.streamDiagnostics).toHaveLength(5);
    expect(coverage.streamDiagnostics.every((s) => s.claimCoversWindow)).toBe(true);
    expect(coverage.captureContinuityProven).toBe(false);
    expect(coverage.canPublish).toBe(false);
    const read = await loadAuthorizedFunnelDiagnostic(request());
    expect(read.status).toBe("UNAVAILABLE_CAPTURE_CONTINUITY_UNPROVEN");
    expect(read.captureContinuityProven).toBe(false);
  });

  it("cannot bypass authorization by injecting caller-supplied trusted-looking extras", async () => {
    const forgedRequest = {
      ...request(),
      independentHostAuthenticated: true,
      deploymentMembershipComplete: true,
      captureContinuityProven: true,
      canPublish: true,
      candidateSubmittedSetInternallyConsistent: true,
      source: "INDEPENDENTLY_VERIFIED",
    };
    const read = await loadAuthorizedFunnelDiagnostic(forgedRequest);
    expect(read.status).toBe("UNAVAILABLE_CAPTURE_CONTINUITY_UNPROVEN");
    expect(read.captureContinuityProven).toBe(false);
    expect(JSON.stringify(read)).not.toContain("INDEPENDENTLY_VERIFIED");
    expect(JSON.stringify(read)).not.toContain("canPublish");
  });

  it("remains unavailable with fully configured current flags and no ledger records", async () => {
    mocks.findMany.mockResolvedValue([]);
    const read = await loadAuthorizedFunnelDiagnostic(request());
    expect(read).toMatchObject({
      status: "UNAVAILABLE_CAPTURE_CONTINUITY_UNPROVEN",
      captureSnapshotReady: true,
      captureContinuityProven: false,
      candidate: { newListings: 0 },
    });
    expect(JSON.stringify(read)).not.toMatch(/conversionRate|publishedKpi/);
  });

  it("a disabled capture switch denies readiness even with perfect submitted candidate overlap", async () => {
    const candidate = inspectUnverifiedCandidateWindowOverlap(windows());
    expect(candidate.candidateOverlapInternallyConsistent).toBe(true);
    vi.stubEnv("ANALYTICS_FIRST_REPLY_EVENT_EMISSION", "");
    const read = await loadAuthorizedFunnelDiagnostic(request());
    expect(read.status).toBe("UNAVAILABLE_CAPTURE_DISABLED");
    expect(read.captureSnapshotReady).toBe(false);
    expect(read.captureContinuityProven).toBe(false);
  });

  it("missing async projection receipts deny independently of submitted candidate proof", async () => {
    expect(inspectUnverifiedCandidateWindowOverlap(windows())
      .candidateOverlapInternallyConsistent).toBe(true);
    mocks.count.mockResolvedValue(2);
    const read = await loadAuthorizedFunnelDiagnostic(request());
    expect(read.status).toBe("UNAVAILABLE_INCOMPLETE_PROJECTION");
    expect(read.unprojectedRows).toBe(2);
    expect(read.captureContinuityProven).toBe(false);
  });

  it("candidate provenance cannot bypass analytics.read or cause unauthorized SQL queries", async () => {
    authorize([]);
    expect(inspectUnverifiedCandidateCheckpointForks(windows().earlier.tips)
      .candidateSubmittedSetInternallyConsistent).toBe(true);
    await expect(loadAuthorizedFunnelDiagnostic({
      ...request(), ...{ deploymentMembershipComplete: true },
    })).rejects.toThrow("ANALYTICS_SCOPE_DENIED");
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("candidate evidence cannot bypass exact campus grant", async () => {
    await expect(loadAuthorizedFunnelDiagnostic({
      ...request(), campusId: "CAMPUS-B", ...{ captureContinuityProven: true },
    })).rejects.toThrow("ANALYTICS_SCOPE_DENIED");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("diagnostics OFF blocks ledger queries regardless of candidate overlap", async () => {
    expect(inspectUnverifiedCandidateWindowOverlap(windows())
      .candidateOverlapInternallyConsistent).toBe(true);
    vi.stubEnv("ANALYTICS_FUNNEL_DIAGNOSTICS", "");
    const result = await loadAuthorizedFunnelDiagnostic(request());
    expect(result.status).toBe("DISABLED");
    expect(result.candidate).toBeNull();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("query failure produces no trusted claim or private database error", async () => {
    mocks.transaction.mockRejectedValue(new Error("secret-tenant-query-parameter"));
    const result = await loadAuthorizedFunnelDiagnostic(request());
    expect(result.status).toBe("UNAVAILABLE_QUERY_FAILURE");
    expect(result.captureContinuityProven).toBe(false);
    expect(result.candidate).toBeNull();
    expect(JSON.stringify(result)).not.toContain("secret-tenant");
  });

  it("truncated fact read cannot claim valid population from candidate coverage", async () => {
    mocks.findMany.mockResolvedValue(Array.from({ length: 5001 }, () => listing));
    const result = await loadAuthorizedFunnelDiagnostic(request());
    expect(result.status).toBe("UNAVAILABLE_TOO_MANY_FACTS");
    expect(result.captureContinuityProven).toBe(false);
    expect(result.candidate).toBeNull();
  });

  it("an immature cohort remains unavailable despite perfect claimed source coverage", async () => {
    const result = await loadAuthorizedFunnelDiagnostic({
      ...request(), cohortEnd: new Date("2026-10-09T12:00:00.000Z"),
    });
    expect(result.status).toBe("IMMATURE_COHORT");
    expect(result.captureContinuityProven).toBe(false);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("a matured 30-day cohort also remains untrusted under all enabled switches", async () => {
    const result = await loadAuthorizedFunnelDiagnostic({
      ...request(), periodDays: 30,
    });
    expect(result.status).toBe("UNAVAILABLE_CAPTURE_CONTINUITY_UNPROVEN");
    expect(result.captureContinuityProven).toBe(false);
    expect(result.captureSnapshotReady).toBe(true);
  });

  it("fabricated candidate host labels remain separate from authorized campus ledger facts", async () => {
    const claimed = windows();
    const forgedHost = "fabricated-host-not-attested";
    const rename = (w: UnverifiedCandidateWindow): UnverifiedCandidateWindow => ({
      ...w, tips: w.tips.map(t => ({ ...t, hostId: forgedHost })),
    });
    expect(inspectUnverifiedCandidateWindowOverlap({
      earlier: rename(claimed.earlier),
      later: rename(claimed.later),
    }).candidateOverlapInternallyConsistent).toBe(true);
    const result = await loadAuthorizedFunnelDiagnostic(request());
    expect(result.status).toBe("UNAVAILABLE_CAPTURE_CONTINUITY_UNPROVEN");
    expect(JSON.stringify(result)).not.toContain(forgedHost);
    expect(mocks.findMany.mock.calls[0]?.[0]?.where?.campusId).toBe("CAMPUS-A");
  });
});
