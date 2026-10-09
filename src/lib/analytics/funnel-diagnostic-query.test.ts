import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  validateDomainEventIntent,
  LIQUIDITY_LISTING_CREATED_EVENT_TYPE as LISTING,
  LISTING_CONVERSATION_CREATED_EVENT_TYPE as CONVERSATION,
  LISTING_CONVERSATION_ORDER_ATTRIBUTED_EVENT_TYPE as ORDER,
} from "@/lib/domain-events/domain-event-registry";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), campus: vi.fn(), events: vi.fn(), receipts: vi.fn(), jobs: vi.fn(),
}));
vi.mock("@/lib/rbac/service", () => ({ loadAuthorizationContext: mocks.auth }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  campus: { findUnique: mocks.campus },
  domainEvent: { findMany: mocks.events },
  projectionReceipt: { findMany: mocks.receipts },
  asyncJob: { findMany: mocks.jobs },
}}));

import {
  loadAuthorizedUnreleasedFunnelDiagnostic, FUNNEL_DIAGNOSTIC_EVENT_LIMIT,
} from "@/lib/analytics/funnel-diagnostic-query";

const now = new Date("2026-10-09T08:00:00.000Z");
const observed = now.getTime();
const start = new Date(observed - 14 * 86_400_000);
const eventAt = new Date(start.getTime() + 3_600_000);

function grant(id = "A", activeCampusIds = ["A"]) {
  mocks.auth.mockResolvedValue({
    userId: "operator", accountActive: true, activeCampusIds,
    grants: [{ scope: "CAMPUS", campusId: id,
      roleKey: "OPS", permissionKeys: ["analytics.read"] }],
  });
}
function fact(type: "listing" | "conversation" | "order", id: string, options?: {
  occurredAt?: Date; campusId?: string; sourceType?: string;
}) {
  const eventType = type === "listing" ? LISTING
    : type === "conversation" ? CONVERSATION : ORDER;
  const payload = type === "listing" ?
    { listingId: "item-1", listingType: "PRODUCT" } :
    type === "conversation" ?
      { conversationId: "conv-1", listingId: "item-1", listingType: "PRODUCT" } :
      { orderId: "order-1", conversationId: "conv-1",
        listingId: "item-1", listingType: "PRODUCT" };
  const aggregateId = type === "listing" ? "item-1" :
    type === "conversation" ? "conv-1" : "order-1";
  const aggregateType = type === "listing" ? "LISTING" :
    type === "conversation" ? "CONVERSATION" : "ORDER_ATTRIBUTION";
  const intent = validateDomainEventIntent(eventType, 1, aggregateType, aggregateId, payload);
  if (!intent.ok) throw new Error("bad test fixture");
  return {
    id, eventType, schemaVersion: 1, aggregateType, aggregateId,
    occurrenceKey: intent.occurrenceKey, campusId: options?.campusId ?? "A",
    occurredAt: options?.occurredAt ?? eventAt, payload,
    sourceType: options?.sourceType ?? "DOMAIN_TX",
  };
}
const input = () => ({ actorId: "operator", campusId: "A",
  listingType: "PRODUCT" as const, periodDays: 7 as const, now });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ANALYTICS_FUNNEL_DIAGNOSTICS", "enabled");
  grant();
  mocks.campus.mockResolvedValue({ id: "A" });
  mocks.events.mockResolvedValue([]);
  mocks.receipts.mockResolvedValue([]);
  mocks.jobs.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("10K-R2d-02 fail-closed authorized PostgreSQL diagnostic read", () => {
  it("denies unauthorized and inactive campus before any scope-sensitive query", async () => {
    grant("A", []);
    await expect(loadAuthorizedUnreleasedFunnelDiagnostic(input()))
      .rejects.toThrow("FUNNEL_DIAGNOSTIC_SCOPE_DENIED");
    grant("B", ["A"]);
    await expect(loadAuthorizedUnreleasedFunnelDiagnostic(input()))
      .rejects.toThrow("FUNNEL_DIAGNOSTIC_SCOPE_DENIED");
    expect(mocks.campus).not.toHaveBeenCalled();
    expect(mocks.events).not.toHaveBeenCalled();
    expect(mocks.receipts).not.toHaveBeenCalled();
    expect(mocks.jobs).not.toHaveBeenCalled();
  });

  it("requires explicit opt-in even for authorized internal diagnostic reads", async () => {
    vi.stubEnv("ANALYTICS_FUNNEL_DIAGNOSTICS", "");
    expect(await loadAuthorizedUnreleasedFunnelDiagnostic(input()))
      .toEqual({ status: "DISABLED", candidate: null, evidence: null });
    expect(mocks.campus).not.toHaveBeenCalled();
  });

  it("rejects invalid scopes, types and periods before authentication/query", async () => {
    for (const request of [
      { ...input(), campusId: "" }, { ...input(), actorId: "" },
      { ...input(), periodDays: 60 as 7 },
      { ...input(), listingType: "ERRAND" as "PRODUCT" },
    ]) {
      await expect(loadAuthorizedUnreleasedFunnelDiagnostic(request))
        .rejects.toThrow("FUNNEL_DIAGNOSTIC_SCOPE_INVALID");
    }
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it("requires a real campus before any ledger read", async () => {
    mocks.campus.mockResolvedValue(null);
    await expect(loadAuthorizedUnreleasedFunnelDiagnostic(input()))
      .rejects.toThrow("FUNNEL_DIAGNOSTIC_CAMPUS_NOT_FOUND");
    expect(mocks.events).not.toHaveBeenCalled();
  });

  it("uses exact campus, fixed event allowlist, half-open mature window and LIMIT+1", async () => {
    const result = await loadAuthorizedUnreleasedFunnelDiagnostic(input());
    expect(mocks.auth).toHaveBeenCalledWith("operator");
    expect(mocks.events).toHaveBeenCalledWith({
      where: {
        campusId: "A", eventType: { in: [LISTING, CONVERSATION,
          "LISTING_CONVERSATION_FIRST_REPLY", ORDER] },
        occurredAt: { gte: start, lte: now },
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: FUNNEL_DIAGNOSTIC_EVENT_LIMIT + 1,
      select: {
        id: true, eventType: true, schemaVersion: true, aggregateType: true,
        aggregateId: true, occurrenceKey: true, campusId: true,
        occurredAt: true, sourceType: true, payload: true,
      },
    });
    expect(result).toMatchObject({
      status: "UNAVAILABLE_PENDING_CAPTURE_COVERAGE",
      candidate: { newListings: 0, eligibleConversations: 0 },
      evidence: { inspectedEvents: 0, captureContinuityProven: false,
        privacyApprovalProven: false, sourceInventoryComplete: false },
    });
    expect(mocks.receipts).not.toHaveBeenCalled();
    expect(mocks.jobs).not.toHaveBeenCalled();
  });

  it("refuses a truncated denominator and never invokes downstream joins", async () => {
    mocks.events.mockResolvedValue(Array(FUNNEL_DIAGNOSTIC_EVENT_LIMIT + 1).fill({}));
    expect(await loadAuthorizedUnreleasedFunnelDiagnostic(input()))
      .toEqual({
        status: "UNAVAILABLE_QUERY_BUDGET_EXCEEDED",
        candidate: null, evidence: null,
      });
    expect(mocks.receipts).not.toHaveBeenCalled();
    expect(mocks.jobs).not.toHaveBeenCalled();
  });

  it("records projection gaps as negative evidence without publishing a rate", async () => {
    mocks.events.mockResolvedValue([
      fact("listing", "event-1"), fact("conversation", "event-2"),
      fact("order", "event-3", { occurredAt: new Date(eventAt.getTime() + 1000) }),
    ]);
    mocks.receipts.mockResolvedValue([{ eventId: "event-1" }]);
    mocks.jobs.mockResolvedValue([
      { dedupeKey: "ANALYTICS_PROJECT_DOMAIN_EVENT:schema1:projection3:event-1", status: "COMPLETED" },
      { dedupeKey: "ANALYTICS_PROJECT_DOMAIN_EVENT:schema1:projection3:event-2", status: "RETRY" },
      { dedupeKey: "ANALYTICS_PROJECT_DOMAIN_EVENT:schema1:projection3:event-3", status: "DEAD_LETTER" },
    ]);
    const result = await loadAuthorizedUnreleasedFunnelDiagnostic(input());
    expect(result).toMatchObject({
      status: "UNAVAILABLE_PENDING_CAPTURE_COVERAGE",
      candidate: {
        newListings: 1, listingsWithConversations: 1,
        eligibleConversations: 1, conversationsWithOrders: 1,
      },
      evidence: {
        inspectedEvents: 3, missingProjectionReceipts: 2,
        missingProjectionIntents: 0, inFlightProjectionJobs: 1,
        deadLetterProjectionJobs: 1,
        captureContinuityProven: false,
      },
    });
    expect(mocks.receipts).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        eventId: { in: ["event-1", "event-2", "event-3"] },
        projectionKey: "ANALYTICS_METRIC_CONTRIBUTIONS",
        projectionVersion: 3,
      }),
    }));
    expect(mocks.jobs).toHaveBeenCalledWith({
      where: { dedupeKey: { in: [
        "ANALYTICS_PROJECT_DOMAIN_EVENT:schema1:projection3:event-1",
        "ANALYTICS_PROJECT_DOMAIN_EVENT:schema1:projection3:event-2",
        "ANALYTICS_PROJECT_DOMAIN_EVENT:schema1:projection3:event-3",
      ] } },
      select: { dedupeKey: true, status: true },
    });
  });

  it("does not mistake zero projection gaps for capture continuity", async () => {
    mocks.events.mockResolvedValue([fact("listing", "event-1")]);
    mocks.receipts.mockResolvedValue([{ eventId: "event-1" }]);
    mocks.jobs.mockResolvedValue([
      { dedupeKey: "ANALYTICS_PROJECT_DOMAIN_EVENT:schema1:projection3:event-1", status: "COMPLETED" },
    ]);
    const result = await loadAuthorizedUnreleasedFunnelDiagnostic(input());
    expect(result).toMatchObject({
      status: "UNAVAILABLE_PENDING_CAPTURE_COVERAGE",
      evidence: {
        missingProjectionReceipts: 0, missingProjectionIntents: 0,
        captureContinuityProven: false, privacyApprovalProven: false,
      },
    });
  });

  it("does not query other tenants from a campus-only grant", async () => {
    mocks.events.mockResolvedValue([fact("listing", "event-foreign", { campusId: "B" })]);
    const result = await loadAuthorizedUnreleasedFunnelDiagnostic(input());
    expect(result).toMatchObject({
      status: "UNAVAILABLE_PENDING_CAPTURE_COVERAGE",
      candidate: { newListings: 0 },
    });
    expect(mocks.events.mock.calls[0]?.[0]?.where?.campusId).toBe("A");
  });
});
