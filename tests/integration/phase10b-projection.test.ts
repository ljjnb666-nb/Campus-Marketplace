import { randomUUID } from "node:crypto";

import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 10B projection / receipt / replay / backfill（真实 PostgreSQL）",
  () => {
    let prisma: PrismaClient;
    let campusId = "";
    let categoryId = "";
    let buyerId = "";
    let sellerId = "";
    let seq = 0;

    let recordDomainEventTx: typeof import("@/lib/domain-events/domain-event")["recordDomainEventTx"];
    let projectDomainEventTx: typeof import("@/lib/analytics/domain-event-projection")["projectDomainEventTx"];
    let scheduleUnprojectedDomainEventJobsTx: typeof import("@/lib/analytics/projection-scheduler")["scheduleUnprojectedDomainEventJobsTx"];
    let backfillCanonicalErrandCompletionEventsTx: typeof import("@/lib/analytics/errand-completion-backfill")["backfillCanonicalErrandCompletionEventsTx"];

    const projectionDedupeKey = (eventId: string) =>
      `ANALYTICS_PROJECT_DOMAIN_EVENT:schema1:projection2:${eventId}`;

    const TEST_ONLY_PARKED_RUN_AT = new Date("2099-01-01T00:00:00.000Z");

    async function parkProjectionJobTx(
      tx: Prisma.TransactionClient,
      eventId: string,
    ): Promise<void> {
      await tx.asyncJob.updateMany({
        where: { dedupeKey: projectionDedupeKey(eventId) },
        data: { runAt: TEST_ONLY_PARKED_RUN_AT },
      });
    }

    beforeAll(async () => {
      prisma = new PrismaClient({
        datasources: { db: { url: integrationDatabaseUrl } },
        log: ["error"],
      });
      await prisma.$connect();

      ({ recordDomainEventTx } = await import("@/lib/domain-events/domain-event"));
      ({ projectDomainEventTx } = await import("@/lib/analytics/domain-event-projection"));
      ({ scheduleUnprojectedDomainEventJobsTx } = await import(
        "@/lib/analytics/projection-scheduler"
      ));
      ({ backfillCanonicalErrandCompletionEventsTx } = await import(
        "@/lib/analytics/errand-completion-backfill"
      ));

      const suffix = randomUUID().slice(0, 8);
      const campus = await prisma.campus.create({
        data: {
          name: `10B projection campus ${suffix}`,
          slug: `p10b-${suffix}`,
          schoolName: "集成测试大学",
        },
      });
      campusId = campus.id;

      const category = await prisma.errandCategory.create({
        data: {
          name: `10B projection category ${suffix}`,
          slug: `p10b-cat-${suffix}`,
        },
      });
      categoryId = category.id;

      const [buyer, seller] = await Promise.all([
        prisma.user.create({
          data: {
            name: "p10b-buyer",
            email: `p10b-buyer-${suffix}@it.local`,
            passwordHash: "test-only",
            schoolName: "集成测试大学",
            campusId,
          },
        }),
        prisma.user.create({
          data: {
            name: "p10b-seller",
            email: `p10b-seller-${suffix}@it.local`,
            passwordHash: "test-only",
            schoolName: "集成测试大学",
            campusId,
          },
        }),
      ]);
      buyerId = buyer.id;
      sellerId = seller.id;
    });

    afterAll(async () => {
      if (!prisma) return;

      const eventIds = (
        await prisma.domainEvent.findMany({
          where: { campusId },
          select: { id: true },
        })
      ).map((event) => event.id);

      await prisma.metricContribution.deleteMany({
        where: { eventId: { in: eventIds } },
      });
      await prisma.projectionReceipt.deleteMany({
        where: { eventId: { in: eventIds } },
      });
      await prisma.asyncJob.deleteMany({
        where: { dedupeKey: { in: eventIds.map(projectionDedupeKey) } },
      });
      await prisma.domainEvent.deleteMany({ where: { campusId } });
      await prisma.order.deleteMany({
        where: {
          OR: [
            { buyerId: { in: [buyerId, sellerId] } },
            { sellerId: { in: [buyerId, sellerId] } },
          ],
        },
      });
      await prisma.errandTask.deleteMany({ where: { campusId } });
      await prisma.errandCategory.deleteMany({ where: { id: categoryId } });
      await prisma.user.deleteMany({ where: { id: { in: [buyerId, sellerId] } } });
      await prisma.campus.deleteMany({ where: { id: campusId } });
      await prisma.$disconnect();
    });

    async function createLegacyEvent(input: {
      aggregateId: string;
      errandTaskId: string;
      recordedAt: Date;
    }) {
      return prisma.domainEvent.create({
        data: {
          eventType: "ERRAND_ORDER_COMPLETED",
          schemaVersion: 1,
          aggregateType: "ORDER",
          aggregateId: input.aggregateId,
          campusId,
          occurrenceKey: `ERRAND_ORDER_COMPLETED:${input.aggregateId}`,
          payload: {
            orderId: input.aggregateId,
            errandTaskId: input.errandTaskId,
          },
          occurredAt: input.recordedAt,
          recordedAt: input.recordedAt,
          sourceType: "DOMAIN_TX",
        },
      });
    }

    async function createCompletedErrandOrder(
      validBinding: boolean,
      taskStatus: "COMPLETED" | "PENDING_CONFIRMATION" = "COMPLETED",
    ) {
      seq += 1;
      const completedAt = new Date(Date.UTC(2026, 9, 1, 8, seq, 0));
      const task = await prisma.errandTask.create({
        data: {
          title: `10B backfill task ${seq}`,
          description: "Phase 10B canonical backfill fixture",
          categoryId,
          reward: "8.00",
          pickupLocation: "A",
          deliveryLocation: "B",
          deadline: new Date(Date.UTC(2026, 9, 2, 8, seq, 0)),
          status: taskStatus,
          publisherId: buyerId,
          accepterId: sellerId,
          campusId,
        },
      });
      const order = await prisma.order.create({
        data: {
          orderNo: `P10B${Date.now()}${seq}`,
          type: "ERRAND",
          status: "COMPLETED",
          paymentStatus: "OFFLINE_PENDING",
          amount: "8.00",
          completedAt,
          buyerId: validBinding ? buyerId : sellerId,
          sellerId: validBinding ? sellerId : buyerId,
          errandTaskId: task.id,
        },
      });
      return { task, order, completedAt };
    }

    it("P10B-ATOMIC-01: DomainEvent + projection AsyncJob intent share one transaction", async () => {
      const aggregateId = `p10b-atomic-${randomUUID()}`;
      let eventId = "";

      await expect(
        prisma.$transaction(async (tx) => {
          await recordDomainEventTx(tx, {
            eventType: "ERRAND_ORDER_COMPLETED",
            schemaVersion: 1,
            aggregateType: "ORDER",
            aggregateId,
            campusId,
            occurredAt: new Date("2026-10-01T00:00:00.000Z"),
            payload: { orderId: aggregateId, errandTaskId: "atomic-task" },
          });
          const event = await tx.domainEvent.findUniqueOrThrow({
            where: { occurrenceKey: `ERRAND_ORDER_COMPLETED:${aggregateId}` },
            select: { id: true },
          });
          eventId = event.id;
          expect(
            await tx.asyncJob.count({
              where: { dedupeKey: projectionDedupeKey(event.id) },
            }),
          ).toBe(1);
          throw new Error("P10B_ATOMIC_ROLLBACK");
        }),
      ).rejects.toThrow("P10B_ATOMIC_ROLLBACK");

      expect(
        await prisma.domainEvent.count({
          where: { occurrenceKey: `ERRAND_ORDER_COMPLETED:${aggregateId}` },
        }),
      ).toBe(0);
      expect(
        await prisma.asyncJob.count({
          where: { dedupeKey: projectionDedupeKey(eventId) },
        }),
      ).toBe(0);
    });

    it("P10B-REPLAY-01: receipt makes crash-after-projection-commit replay effectively-once", async () => {
      const aggregateId = `p10b-replay-${randomUUID()}`;
      await prisma.$transaction(async (tx) => {
        await recordDomainEventTx(tx, {
          eventType: "LIQUIDITY_TRANSACTION_COMPLETED",
          schemaVersion: 1,
          aggregateType: "TRANSACTION",
          aggregateId,
          campusId,
          occurredAt: new Date("2026-10-01T01:00:00.000Z"),
          payload: { transactionId: aggregateId, transactionType: "ERRAND" },
        });
        const event = await tx.domainEvent.findUniqueOrThrow({
          where: {
            occurrenceKey: `LIQUIDITY_TRANSACTION_COMPLETED:ERRAND:${aggregateId}`,
          },
          select: { id: true },
        });
        await parkProjectionJobTx(tx, event.id);
      });

      const event = await prisma.domainEvent.findUniqueOrThrow({
        where: {
          occurrenceKey: `LIQUIDITY_TRANSACTION_COMPLETED:ERRAND:${aggregateId}`,
        },
      });
      const job = await prisma.asyncJob.findUniqueOrThrow({
        where: { dedupeKey: projectionDedupeKey(event.id) },
      });
      expect(job.status).toBe("PENDING");

      const first = await prisma.$transaction((tx) => projectDomainEventTx(tx, event.id));
      expect(first).toEqual({ projected: true, contributionCount: 1 });
      expect(await prisma.projectionReceipt.count({ where: { eventId: event.id } })).toBe(1);
      expect(await prisma.metricContribution.count({ where: { eventId: event.id } })).toBe(1);

      // Simulate worker crash after projection tx commit but before AsyncJob marker.
      expect(
        (await prisma.asyncJob.findUniqueOrThrow({ where: { id: job.id } })).status,
      ).toBe("PENDING");

      const replayed = await prisma.$transaction((tx) => projectDomainEventTx(tx, event.id));
      expect(replayed).toEqual({ projected: false, contributionCount: 1 });
      expect(await prisma.projectionReceipt.count({ where: { eventId: event.id } })).toBe(1);

      const contribution = await prisma.metricContribution.findMany({
        where: { eventId: event.id },
      });
      expect(contribution).toHaveLength(1);
      expect(contribution[0]).toMatchObject({
        metricKey: "COMPLETED_TRANSACTION_COUNT",
        metricVersion: 2,
        campusId,
        dimensionKey: "TRANSACTION_TYPE:ERRAND",
      });
      expect(contribution[0]!.occurredAt.getTime()).toBe(event.occurredAt.getTime());
      expect(contribution[0]!.value.toString()).toBe("1");
    });

    it("P10B-CONVERGENCE-01: terminal structural gap cannot starve a later repairable event", async () => {
      const older = await createLegacyEvent({
        aggregateId: `p10b-gap-${randomUUID()}`,
        errandTaskId: "gap-task",
        recordedAt: new Date("2026-09-01T00:00:00.000Z"),
      });
      const later = await createLegacyEvent({
        aggregateId: `p10b-repairable-${randomUUID()}`,
        errandTaskId: "repairable-task",
        recordedAt: new Date("2026-09-02T00:00:00.000Z"),
      });

      await prisma.asyncJob.create({
        data: {
          kind: "ANALYTICS_PROJECT_DOMAIN_EVENT",
          schemaVersion: 1,
          dedupeKey: projectionDedupeKey(older.id),
          payload: { eventId: older.id },
          status: "COMPLETED",
          completedAt: new Date(),
          runAt: new Date(),
        },
      });

      const summary = await prisma.$transaction(async (tx) => {
        const result = await scheduleUnprojectedDomainEventJobsTx(tx, {
          batchLimit: 1,
          campusId,
        });
        expect(
          await tx.asyncJob.count({
            where: { dedupeKey: projectionDedupeKey(later.id), status: "PENDING" },
          }),
        ).toBe(1);
        await parkProjectionJobTx(tx, later.id);
        return result;
      });

      expect(summary.enqueued).toBe(1);
      expect(summary.structuralGaps).toBe(1);
    });

    it("P10B-BACKFILL-01: only truthful canonical ERRAND completion is backfilled", async () => {
      const valid = await createCompletedErrandOrder(true);
      const invalid = await createCompletedErrandOrder(false);
      const inconsistentState = await createCompletedErrandOrder(
        true,
        "PENDING_CONFIRMATION",
      );

      const first = await prisma.$transaction(async (tx) => {
        const result = await backfillCanonicalErrandCompletionEventsTx(tx, {
          batchLimit: 10,
          campusId,
        });
        const event = await tx.domainEvent.findUnique({
          where: { occurrenceKey: `ERRAND_ORDER_COMPLETED:${valid.order.id}` },
          select: { id: true },
        });
        if (event) {
          await parkProjectionJobTx(tx, event.id);
        }
        return result;
      });
      expect(first.backfilled).toBe(1);

      const event = await prisma.domainEvent.findUniqueOrThrow({
        where: { occurrenceKey: `ERRAND_ORDER_COMPLETED:${valid.order.id}` },
      });
      expect(event).toMatchObject({
        eventType: "ERRAND_ORDER_COMPLETED",
        schemaVersion: 1,
        aggregateType: "ORDER",
        aggregateId: valid.order.id,
        campusId,
        sourceType: "BACKFILL_CANONICAL",
        sourceId: valid.order.id,
        payload: {
          orderId: valid.order.id,
          errandTaskId: valid.task.id,
        },
      });
      expect(event.occurredAt.getTime()).toBe(valid.completedAt.getTime());
      expect(
        await prisma.asyncJob.count({
          where: { dedupeKey: projectionDedupeKey(event.id) },
        }),
      ).toBe(1);

      expect(
        await prisma.domainEvent.count({
          where: { occurrenceKey: `ERRAND_ORDER_COMPLETED:${invalid.order.id}` },
        }),
      ).toBe(0);
      expect(
        await prisma.domainEvent.count({
          where: {
            occurrenceKey: `ERRAND_ORDER_COMPLETED:${inconsistentState.order.id}`,
          },
        }),
      ).toBe(0);

      const second = await prisma.$transaction((tx) =>
        backfillCanonicalErrandCompletionEventsTx(tx, {
          batchLimit: 10,
          campusId,
        }),
      );
      expect(second.backfilled).toBe(0);
    });
  },
);
