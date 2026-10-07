import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

import { projectDomainEventTx } from "@/lib/analytics/domain-event-projection";
import { analyticsProjectDomainEventHandler } from "@/lib/async/handlers/analytics-project-domain-event";
import {
  ANALYTICS_METRIC_PROJECTION_KEY,
  ANALYTICS_METRIC_PROJECTION_VERSION,
  buildLiveDomainEventProjectionDedupeKey,
  classifyProjectionIntentVersion,
  parseDomainEventProjectionVersion,
} from "@/lib/analytics/projection-contract";
import { PermanentJobFailure } from "@/lib/async/job-types";

const occurredAt = new Date("2026-10-07T01:02:03.000Z");

function buildTx() {
  return {
    domainEvent: {
      findUnique: vi.fn().mockResolvedValue({
        id: "event-1",
        eventType: "LIQUIDITY_TRANSACTION_COMPLETED",
        schemaVersion: 1,
        aggregateType: "TRANSACTION",
        aggregateId: "order-1",
        campusId: "campus-1",
        payload: { transactionId: "order-1", transactionType: "ERRAND" },
        occurredAt,
      }),
    },
    projectionReceipt: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    metricContribution: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([
        {
          metricKey: "COMPLETED_TRANSACTION_COUNT",
          metricVersion: 2,
          dimensionKey: "TRANSACTION_TYPE:ERRAND",
          campusId: "campus-1",
          occurredAt,
          value: { toString: () => "1" },
        },
      ]),
    },
  };
}

function asTx(tx: ReturnType<typeof buildTx>): Prisma.TransactionClient {
  return tx as unknown as Prisma.TransactionClient;
}

describe("Phase 10B receipt-backed projection", () => {
  it("PROJECTION-01: first execution writes receipt + one event-level metric effect", async () => {
    const tx = buildTx();
    await expect(projectDomainEventTx(asTx(tx), "event-1")).resolves.toEqual({
      projected: true,
      contributionCount: 1,
    });
    expect(tx.projectionReceipt.createMany).toHaveBeenCalledWith({
      data: [
        {
          projectionKey: ANALYTICS_METRIC_PROJECTION_KEY,
          projectionVersion: ANALYTICS_METRIC_PROJECTION_VERSION,
          eventId: "event-1",
        },
      ],
      skipDuplicates: true,
    });
    expect(tx.metricContribution.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          eventId: "event-1",
          campusId: "campus-1",
          occurredAt,
          metricKey: "COMPLETED_TRANSACTION_COUNT",
          dimensionKey: "TRANSACTION_TYPE:ERRAND",
          value: "1",
        }),
      ],
      skipDuplicates: true,
    });
  });

  it("PROJECTION-02: duplicate receipt is idempotent only when materialized effect still matches", async () => {
    const tx = buildTx();
    tx.projectionReceipt.createMany.mockResolvedValue({ count: 0 });

    await expect(projectDomainEventTx(asTx(tx), "event-1")).resolves.toEqual({
      projected: false,
      contributionCount: 1,
    });
    expect(tx.metricContribution.createMany).not.toHaveBeenCalled();
  });

  it("PROJECTION-03: receipt without matching effect is structural corruption, not silent success", async () => {
    const tx = buildTx();
    tx.projectionReceipt.createMany.mockResolvedValue({ count: 0 });
    tx.metricContribution.findMany.mockResolvedValue([]);

    await expect(projectDomainEventTx(asTx(tx), "event-1")).rejects.toMatchObject({
      code: "ANALYTICS_PROJECTION_EFFECT_CORRUPT",
    });
  });

  it("PROJECTION-04: missing/invalid authoritative event fails permanently", async () => {
    const tx = buildTx();
    tx.domainEvent.findUnique.mockResolvedValue(null);
    await expect(projectDomainEventTx(asTx(tx), "missing")).rejects.toBeInstanceOf(
      PermanentJobFailure,
    );
  });

  it("PROJECTION-05: live dedupe identity is projection-versioned, not watermark-based", () => {
    expect(buildLiveDomainEventProjectionDedupeKey("event-1")).toBe(
      "ANALYTICS_PROJECT_DOMAIN_EVENT:schema1:projection3:event-1",
    );
  });

  it("PROJECTION-06: rolling versions are fenced in both directions", () => {
    // Current v3 runtime treats old v2 durable intent as stale.
    expect(classifyProjectionIntentVersion(2, 3)).toBe("STALE");
    expect(classifyProjectionIntentVersion(3, 3)).toBe("CURRENT");
    expect(classifyProjectionIntentVersion(4, 3)).toBe("FUTURE");

    // Critical 10C-2 rolling-deploy proof: an old v2 worker must not acknowledge
    // a new v3 value-event intent as current/zero-contribution.
    expect(classifyProjectionIntentVersion(3, 2)).toBe("FUTURE");

    expect(() => classifyProjectionIntentVersion(0, 1)).toThrow(
      "ANALYTICS_PROJECTION_VERSION_INVALID",
    );
  });

  it("PROJECTION-07: old runtime reschedules a future-version intent instead of poisoning it", async () => {
    const tx = buildTx();
    const before = Date.now();
    const result = await analyticsProjectDomainEventHandler(asTx(tx), {
      id: "job-v4",
      kind: "ANALYTICS_PROJECT_DOMAIN_EVENT",
      schemaVersion: 1,
      dedupeKey: "ANALYTICS_PROJECT_DOMAIN_EVENT:schema1:projection4:event-1",
      payload: { eventId: "event-1" },
      attempts: 1,
      maxAttempts: 5,
      leaseToken: "lease-4",
      previousStatus: "PENDING",
    });
    expect(result.kind).toBe("RESCHEDULE");
    if (result.kind === "RESCHEDULE") {
      expect(result.runAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    }
    expect(tx.domainEvent.findUnique).not.toHaveBeenCalled();
    expect(tx.projectionReceipt.createMany).not.toHaveBeenCalled();
  });

  it("PROJECTION-08: projection dedupe parser is strict and event-bound", () => {
    expect(
      parseDomainEventProjectionVersion(
        "ANALYTICS_PROJECT_DOMAIN_EVENT:schema1:projection12:event-1",
        "event-1",
      ),
    ).toBe(12);
    expect(
      parseDomainEventProjectionVersion(
        "ANALYTICS_PROJECT_DOMAIN_EVENT:schema1:projection12:other-event",
        "event-1",
      ),
    ).toBeNull();
    expect(parseDomainEventProjectionVersion(undefined, "event-1")).toBeNull();
  });
});
