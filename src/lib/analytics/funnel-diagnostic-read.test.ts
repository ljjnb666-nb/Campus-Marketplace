import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const now = new Date("2026-10-09T12:00:00.000Z");
const end = new Date("2026-10-01T12:00:00.000Z");
const start = new Date("2026-09-24T12:00:00.000Z");
const through = new Date("2026-10-08T12:00:00.000Z");
const request = () => ({
  actorId: "operator", campusId: "CAMPUS-A",
  listingType: "PRODUCT" as const, periodDays: 7 as const,
  cohortEnd: end, now,
});

function auth(campusIds: string[] = ["CAMPUS-A"], global = false) {
  mocks.loadAuthorizationContext.mockResolvedValue({
    userId: "operator", accountActive: true, activeCampusIds: campusIds,
    grants: [{ scope: global ? "GLOBAL" : "CAMPUS",
      roleKey: "ANALYTICS", campusId: global ? null : "CAMPUS-A",
      permissionKeys: ["analytics.read"] }],
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
const conv = {
  eventType: "LISTING_CONVERSATION_CREATED", schemaVersion: 1,
  aggregateType: "CONVERSATION", aggregateId: "conv-one",
  occurrenceKey: "LISTING_CONVERSATION_CREATED:conv-one",
  campusId: "CAMPUS-A", sourceType: "DOMAIN_TX",
  occurredAt: new Date("2026-09-25T13:00:00.000Z"),
  payload: { conversationId: "conv-one", listingId: "listing-one", listingType: "PRODUCT" },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ANALYTICS_FUNNEL_DIAGNOSTICS", "enabled");
  vi.stubEnv("ANALYTICS_CONVERSATION_EVENT_EMISSION", "");
  vi.stubEnv("ANALYTICS_FIRST_REPLY_EVENT_EMISSION", "");
  vi.stubEnv("ANALYTICS_ORDER_ATTRIBUTION_EMISSION", "");
  vi.stubEnv("ANALYTICS_ORDER_ATTRIBUTION_SECRET", "");
  auth();
  mocks.findMany.mockResolvedValue([listing, conv]);
  mocks.count.mockResolvedValue(0);
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ domainEvent: { findMany: mocks.findMany, count: mocks.count } }));
});
afterEach(() => vi.unstubAllEnvs());

describe("R2d-02 authorized PostgreSQL diagnostic and coverage fence", () => {
  it("diagnostics are default OFF even with analytics.read and cannot query the ledger", async () => {
    vi.stubEnv("ANALYTICS_FUNNEL_DIAGNOSTICS", "");
    const result = await loadAuthorizedFunnelDiagnostic(request());
    expect(result).toMatchObject({ status: "DISABLED", candidate: null });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects missing/inactive grant before accessing any event or transaction", async () => {
    mocks.loadAuthorizationContext.mockResolvedValue(null);
    await expect(loadAuthorizedFunnelDiagnostic(request())).rejects.toThrow("ANALYTICS_SCOPE_DENIED");
    auth([]);
    await expect(loadAuthorizedFunnelDiagnostic(request())).rejects.toThrow("ANALYTICS_SCOPE_DENIED");
    auth(["CAMPUS-A"]);
    await expect(loadAuthorizedFunnelDiagnostic({ ...request(), campusId: "CAMPUS-B" }))
      .rejects.toThrow("ANALYTICS_SCOPE_DENIED");
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("requires exact-campus and bounded all-event PostgreSQL predicates", async () => {
    const result = await loadAuthorizedFunnelDiagnostic(request());
    expect(mocks.loadAuthorizationContext).toHaveBeenCalledWith("operator");
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function),
      expect.objectContaining({
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 15_000,
      }));
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        campusId: "CAMPUS-A",
        occurredAt: { gte: start, lte: through },
        eventType: { in: [
          "LIQUIDITY_LISTING_CREATED",
          "LISTING_CONVERSATION_CREATED",
          "LISTING_CONVERSATION_FIRST_REPLY",
          "LISTING_CONVERSATION_ORDER_ATTRIBUTED",
        ] },
      },
      select: {
        eventType: true, schemaVersion: true, aggregateType: true,
        aggregateId: true, occurrenceKey: true, campusId: true,
        sourceType: true, occurredAt: true, payload: true,
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: 5001,
    });
    expect(mocks.count).toHaveBeenCalledWith({ where: expect.objectContaining({
      campusId: "CAMPUS-A", sourceType: "DOMAIN_TX",
      projectionReceipts: { none: {
        projectionKey: "ANALYTICS_METRIC_CONTRIBUTIONS",
        projectionVersion: 3,
      } },
    }) });
    expect(result).toMatchObject({
      status: "UNAVAILABLE_CAPTURE_DISABLED",
      eventRows: 2, unprojectedRows: 0,
      captureSnapshotReady: false, captureContinuityProven: false,
      candidate: { newListings: 1, listingsWithConversations: 1, eligibleConversations: 1 },
    });
  });

  it("authorizes explicit campus under GLOBAL grant but never joins other tenants", async () => {
    auth([], true);
    await loadAuthorizedFunnelDiagnostic(request());
    expect(mocks.findMany.mock.calls[0]?.[0]?.where?.campusId).toBe("CAMPUS-A");
  });

  it("rejects an immature window before touching the event ledger", async () => {
    expect((await loadAuthorizedFunnelDiagnostic({
      ...request(), cohortEnd: new Date("2026-10-08T12:00:00.000Z"),
    })).status).toBe("IMMATURE_COHORT");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects unsupported periods, invalid dates and future windows", async () => {
    for (const change of [
      { periodDays: 60 as 7 },
      { cohortEnd: new Date("invalid") },
      { cohortEnd: new Date("2030-10-01") },
    ]) {
      expect((await loadAuthorizedFunnelDiagnostic({ ...request(), ...change })).status)
        .toBe("INVALID_WINDOW");
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("remains UNAVAILABLE even when all three capture flags appear enabled now", async () => {
    vi.stubEnv("ANALYTICS_CONVERSATION_EVENT_EMISSION", "enabled");
    vi.stubEnv("ANALYTICS_FIRST_REPLY_EVENT_EMISSION", "enabled");
    vi.stubEnv("ANALYTICS_ORDER_ATTRIBUTION_EMISSION", "enabled");
    vi.stubEnv("ANALYTICS_ORDER_ATTRIBUTION_SECRET", "a-strong-separate-private-test-secret-key");
    const result = await loadAuthorizedFunnelDiagnostic(request());
    expect(result).toMatchObject({
      status: "UNAVAILABLE_CAPTURE_CONTINUITY_UNPROVEN",
      captureSnapshotReady: true, captureContinuityProven: false,
      candidate: { eligibleConversations: 1 },
    });
  });

  it("does not treat missing async projection receipts as a complete window", async () => {
    vi.stubEnv("ANALYTICS_CONVERSATION_EVENT_EMISSION", "enabled");
    vi.stubEnv("ANALYTICS_FIRST_REPLY_EVENT_EMISSION", "enabled");
    vi.stubEnv("ANALYTICS_ORDER_ATTRIBUTION_EMISSION", "enabled");
    vi.stubEnv("ANALYTICS_ORDER_ATTRIBUTION_SECRET", "a-strong-separate-private-test-secret-key");
    mocks.count.mockResolvedValue(2);
    const result = await loadAuthorizedFunnelDiagnostic(request());
    expect(result).toMatchObject({
      status: "UNAVAILABLE_INCOMPLETE_PROJECTION", eventRows: 2,
      unprojectedRows: 2, captureContinuityProven: false,
    });
  });

  it("fails closed when count exceeds 5,000 rather than using a truncated denominator", async () => {
    mocks.findMany.mockResolvedValue(Array.from({ length: 5001 }, () => listing));
    const result = await loadAuthorizedFunnelDiagnostic(request());
    expect(result).toMatchObject({
      status: "UNAVAILABLE_TOO_MANY_FACTS", candidate: null, eventRows: 5001,
    });
  });

  it("database/transaction failure is an unavailable result without exposed driver error", async () => {
    mocks.transaction.mockRejectedValue(new Error("postgres query revealed sensitive param"));
    const result = await loadAuthorizedFunnelDiagnostic(request());
    expect(result).toMatchObject({
      status: "UNAVAILABLE_QUERY_FAILURE", candidate: null,
      eventRows: null, unprojectedRows: null,
    });
    expect(JSON.stringify(result)).not.toContain("sensitive param");
  });

  it("no facts is NOT a verified 0% conversion; no rate is returned", async () => {
    mocks.findMany.mockResolvedValue([]);
    const result = await loadAuthorizedFunnelDiagnostic(request());
    expect(result).toMatchObject({
      status: "UNAVAILABLE_CAPTURE_DISABLED",
      candidate: { newListings: 0, eligibleConversations: 0 },
    });
    expect(JSON.stringify(result)).not.toMatch(/percent|conversionRate|published/);
  });
});
