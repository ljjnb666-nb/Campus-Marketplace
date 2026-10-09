import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildLiveDomainEventProjectionDedupeKey } from "@/lib/analytics/projection-contract";

const url = process.env.INTEGRATION_DATABASE_URL;
const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/rbac/service", () => ({ loadAuthorizationContext: mocks.auth }));
vi.mock("@/lib/prisma", () => ({
  prisma: new PrismaClient({
    datasources: { db: { url: process.env.INTEGRATION_DATABASE_URL } },
    log: ["error"],
  }),
}));

import { prisma } from "@/lib/prisma";
import { recordDomainEventTx } from "@/lib/domain-events/domain-event";
import { loadAuthorizedUnreleasedFunnelDiagnostic } from "@/lib/analytics/funnel-diagnostic-query";

const db = prisma as PrismaClient;
const DAY = 86_400_000;
const now = new Date("2026-10-09T08:00:00.000Z");
const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY);

describe.skipIf(!url)("Phase 10K-R2d-02 exact-campus PG diagnostic read", () => {
  const tag = randomUUID().slice(0, 8);
  let campusId = "", otherId = "";
  const eventIds: string[] = [];
  const listingId = "r2d02-listing-" + tag;
  const conversationId = "r2d02-conv-" + tag;
  const orderId = "r2d02-order-" + tag;

  beforeAll(async () => {
    await db.$connect();
    campusId = (await db.campus.create({
      data: { slug: "r2d02-main-" + tag, name: "R2d02", schoolName: "Test school" },
    })).id;
    otherId = (await db.campus.create({
      data: { slug: "r2d02-other-" + tag, name: "R2d02 other", schoolName: "Test school" },
    })).id;
    mocks.auth.mockResolvedValue({
      userId: "audit-operator", accountActive: true,
      activeCampusIds: [campusId],
      grants: [{
        roleKey: "ANALYTICS", scope: "CAMPUS", campusId,
        permissionKeys: ["analytics.read"],
      }],
    });
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    if (!campusId) return;
    const rows = await db.domainEvent.findMany({
      where: { campusId: { in: [campusId, otherId] } },
      select: { id: true },
    });
    const ids = rows.map(r => r.id);
    await db.metricContribution.deleteMany({ where: { eventId: { in: ids } } });
    await db.projectionReceipt.deleteMany({ where: { eventId: { in: ids } } });
    await db.asyncJob.deleteMany({
      where: { dedupeKey: { in: ids.map(buildLiveDomainEventProjectionDedupeKey) } },
    });
    await db.domainEvent.deleteMany({ where: { id: { in: ids } } });
    await db.campus.deleteMany({ where: { id: { in: [campusId, otherId] } } });
    await db.$disconnect();
  });

  it("reads verified domain facts within tenant scope; receipt gaps cannot assert completeness", async () => {
    vi.stubEnv("ANALYTICS_FUNNEL_DIAGNOSTICS", "enabled");
    const otherListingId = "r2d02-foreign-" + tag;
    await db.$transaction(async tx => {
      const events = [
        { eventType: "LIQUIDITY_LISTING_CREATED",
          aggregateType: "LISTING", aggregateId: listingId, campusId,
          occurredAt: at(12),
          payload: { listingId, listingType: "PRODUCT" } },
        { eventType: "LISTING_CONVERSATION_CREATED",
          aggregateType: "CONVERSATION", aggregateId: conversationId, campusId,
          occurredAt: at(11),
          payload: { conversationId, listingId, listingType: "PRODUCT" } },
        { eventType: "LISTING_CONVERSATION_ORDER_ATTRIBUTED",
          aggregateType: "ORDER_ATTRIBUTION", aggregateId: orderId, campusId,
          occurredAt: at(10),
          payload: { conversationId, listingId, orderId, listingType: "PRODUCT" } },
        { eventType: "LIQUIDITY_LISTING_CREATED",
          aggregateType: "LISTING", aggregateId: otherListingId, campusId: otherId,
          occurredAt: at(12),
          payload: { listingId: otherListingId, listingType: "PRODUCT" } },
      ];
      for (const fact of events) {
        await recordDomainEventTx(tx, { ...fact, schemaVersion: 1 });
      }
    });
    const created = await db.domainEvent.findMany({
      where: { campusId: { in: [campusId, otherId] } },
      select: { id: true },
    });
    eventIds.push(...created.map(r => r.id));
    const result = await loadAuthorizedUnreleasedFunnelDiagnostic({
      actorId: "audit-operator", campusId, listingType: "PRODUCT",
      periodDays: 7, now,
    });
    expect(result).toMatchObject({
      status: "UNAVAILABLE_PENDING_CAPTURE_COVERAGE",
      candidate: {
        newListings: 1, listingsWithConversations: 1,
        eligibleConversations: 1, conversationsWithOrders: 1,
      },
      evidence: {
        inspectedEvents: 3,
        missingProjectionReceipts: 3,
        missingProjectionIntents: 0,
        captureContinuityProven: false,
        privacyApprovalProven: false,
        sourceInventoryComplete: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain(otherListingId);
    expect(JSON.stringify(result)).not.toContain(conversationId);
  });

  it("rejects cross-campus analytics.read despite existing foreign facts", async () => {
    vi.stubEnv("ANALYTICS_FUNNEL_DIAGNOSTICS", "enabled");
    await expect(loadAuthorizedUnreleasedFunnelDiagnostic({
      actorId: "audit-operator", campusId: otherId,
      listingType: "PRODUCT", periodDays: 7, now,
    })).rejects.toThrow("FUNNEL_DIAGNOSTIC_SCOPE_DENIED");
  });
});
