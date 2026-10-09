import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadAuthorizationContext: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/rbac/service", () => ({
  loadAuthorizationContext: mocks.loadAuthorizationContext,
}));

import { recordDomainEventTx } from "@/lib/domain-events/domain-event";
import { projectDomainEventTx } from "@/lib/analytics/domain-event-projection";
import { loadAuthorizedFunnelDiagnostic } from "@/lib/analytics/funnel-diagnostic-read";
import { buildLiveDomainEventProjectionDedupeKey } from "@/lib/analytics/projection-contract";

const url = process.env.INTEGRATION_DATABASE_URL;
const DAY = 86_400_000;
const end = new Date("2026-10-01T00:00:00.000Z");
const now = new Date("2026-10-09T00:00:00.000Z");
const start = new Date(end.getTime() - 7 * DAY);

describe.skipIf(!url)("10K-R2d-02 real PostgreSQL exact-campus MVCC diagnostic", () => {
  let db: PrismaClient;
  const campusId = "diag-campus-" + randomUUID();
  const foreignCampus = "diag-foreign-" + randomUUID();
  const listingId = "diag-listing-" + randomUUID();
  const foreignListing = "diag-listing-foreign-" + randomUUID();
  const conversationId = "diag-conv-" + randomUUID();

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
    await db.$connect();
    mocks.transaction.mockImplementation(
      (cb: (tx: Prisma.TransactionClient) => Promise<unknown>, opts: { isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number }) =>
        db.$transaction(cb, opts),
    );
    mocks.loadAuthorizationContext.mockResolvedValue({
      userId: "diag-operator", accountActive: true, activeCampusIds: [campusId],
      grants: [{ scope: "CAMPUS", roleKey: "ANALYTICS",
        campusId, permissionKeys: ["analytics.read"] }],
    });
    await db.$transaction(async tx => {
      const listing = await recordDomainEventTx(tx, {
        eventType: "LIQUIDITY_LISTING_CREATED", schemaVersion: 1,
        aggregateType: "LISTING", aggregateId: listingId, campusId,
        occurredAt: new Date(start.getTime() + DAY),
        payload: { listingId, listingType: "PRODUCT" },
      });
      const created = await tx.domainEvent.findUniqueOrThrow({
        where: { occurrenceKey: listing.occurrenceKey }, select: { id: true },
      });
      // Proven receipt for listing; the new conversation intentionally lacks one.
      await projectDomainEventTx(tx, created.id);
      await recordDomainEventTx(tx, {
        eventType: "LISTING_CONVERSATION_CREATED", schemaVersion: 1,
        aggregateType: "CONVERSATION", aggregateId: conversationId, campusId,
        occurredAt: new Date(start.getTime() + 2 * DAY),
        payload: { conversationId, listingId, listingType: "PRODUCT" },
      });
      await recordDomainEventTx(tx, {
        eventType: "LIQUIDITY_LISTING_CREATED", schemaVersion: 1,
        aggregateType: "LISTING", aggregateId: foreignListing,
        campusId: foreignCampus, occurredAt: new Date(start.getTime() + DAY),
        payload: { listingId: foreignListing, listingType: "PRODUCT" },
      });
    });
  });

  afterAll(async () => {
    if (!db) return;
    const events = await db.domainEvent.findMany({
      where: { campusId: { in: [campusId, foreignCampus] } }, select: { id: true },
    });
    const ids = events.map(event => event.id);
    await db.metricContribution.deleteMany({ where: { eventId: { in: ids } } });
    await db.projectionReceipt.deleteMany({ where: { eventId: { in: ids } } });
    await db.asyncJob.deleteMany({ where: {
      dedupeKey: { in: ids.map(buildLiveDomainEventProjectionDedupeKey) },
    } });
    await db.domainEvent.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  it("counts only same-campus events and missing projection receipts without publishing a rate", async () => {
    vi.stubEnv("ANALYTICS_CONVERSATION_EVENT_EMISSION", "enabled");
    vi.stubEnv("ANALYTICS_FIRST_REPLY_EVENT_EMISSION", "enabled");
    vi.stubEnv("ANALYTICS_ORDER_ATTRIBUTION_EMISSION", "enabled");
    vi.stubEnv("ANALYTICS_ORDER_ATTRIBUTION_SECRET", "diag-strong-fixture-secret-for-Postgres-tests");
    try {
      const result = await loadAuthorizedFunnelDiagnostic({
        actorId: "diag-operator", campusId, listingType: "PRODUCT",
        periodDays: 7, cohortEnd: end, now,
      });
      expect(result).toMatchObject({
        status: "UNAVAILABLE_INCOMPLETE_PROJECTION",
        eventRows: 2, unprojectedRows: 1,
        captureSnapshotReady: true, captureContinuityProven: false,
        candidate: {
          newListings: 1, listingsWithConversations: 1,
          eligibleConversations: 1, conversationsWithOrders: 0,
        },
      });
      expect(JSON.stringify(result)).not.toMatch(/foreignListing|percent|rate/i);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses cross-campus reads before querying the event ledger", async () => {
    const before = mocks.transaction.mock.calls.length;
    await expect(loadAuthorizedFunnelDiagnostic({
      actorId: "diag-operator", campusId: foreignCampus,
      listingType: "PRODUCT", periodDays: 7, cohortEnd: end, now,
    })).rejects.toThrow("ANALYTICS_SCOPE_DENIED");
    expect(mocks.transaction).toHaveBeenCalledTimes(before);
  });
});
