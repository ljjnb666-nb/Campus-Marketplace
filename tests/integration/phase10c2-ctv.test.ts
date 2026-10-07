import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 10C-2 CTV canonical backfill / projection（真实 PostgreSQL）",
  () => {
    let prisma: PrismaClient;
    let campusId = "";
    let buyerId = "";
    let sellerId = "";
    let productCategoryId = "";
    let serviceCategoryId = "";
    let rentalCategoryId = "";
    let errandCategoryId = "";

    let backfillCanonicalTransactionValuesTx:
      typeof import("@/lib/analytics/transaction-value-backfill")["backfillCanonicalTransactionValuesTx"];
    let projectDomainEventTx:
      typeof import("@/lib/analytics/domain-event-projection")["projectDomainEventTx"];

    const projectionDedupeKey = (eventId: string) =>
      `ANALYTICS_PROJECT_DOMAIN_EVENT:schema1:projection3:${eventId}`;

    beforeAll(async () => {
      prisma = new PrismaClient({
        datasources: { db: { url: integrationDatabaseUrl } },
        log: ["error"],
      });
      await prisma.$connect();

      ({ backfillCanonicalTransactionValuesTx } = await import(
        "@/lib/analytics/transaction-value-backfill"
      ));
      ({ projectDomainEventTx } = await import(
        "@/lib/analytics/domain-event-projection"
      ));

      const suffix = randomUUID().slice(0, 8);
      const campus = await prisma.campus.create({
        data: {
          name: `10C2 CTV campus ${suffix}`,
          slug: `p10c2-${suffix}`,
          schoolName: "集成测试大学",
        },
      });
      campusId = campus.id;

      const [buyer, seller] = await Promise.all([
        prisma.user.create({
          data: {
            name: "p10c2-buyer",
            email: `p10c2-buyer-${suffix}@it.local`,
            passwordHash: "test-only",
            schoolName: "集成测试大学",
            campusId,
          },
        }),
        prisma.user.create({
          data: {
            name: "p10c2-seller",
            email: `p10c2-seller-${suffix}@it.local`,
            passwordHash: "test-only",
            schoolName: "集成测试大学",
            campusId,
          },
        }),
      ]);
      buyerId = buyer.id;
      sellerId = seller.id;

      const [productCategory, serviceCategory, rentalCategory, errandCategory] =
        await Promise.all([
          prisma.productCategory.create({
            data: { name: `P10C2 product ${suffix}`, slug: `p10c2-p-${suffix}` },
          }),
          prisma.serviceCategory.create({
            data: { name: `P10C2 service ${suffix}`, slug: `p10c2-s-${suffix}` },
          }),
          prisma.rentalCategory.create({
            data: { name: `P10C2 rental ${suffix}`, slug: `p10c2-r-${suffix}` },
          }),
          prisma.errandCategory.create({
            data: { name: `P10C2 errand ${suffix}`, slug: `p10c2-e-${suffix}` },
          }),
        ]);
      productCategoryId = productCategory.id;
      serviceCategoryId = serviceCategory.id;
      rentalCategoryId = rentalCategory.id;
      errandCategoryId = errandCategory.id;
    });

    afterAll(async () => {
      if (!prisma) return;
      const events = await prisma.domainEvent.findMany({
        where: { campusId },
        select: { id: true },
      });
      const eventIds = events.map((event) => event.id);

      if (eventIds.length > 0) {
        await prisma.metricContribution.deleteMany({
          where: { eventId: { in: eventIds } },
        });
        await prisma.projectionReceipt.deleteMany({
          where: { eventId: { in: eventIds } },
        });
        await prisma.asyncJob.deleteMany({
          where: { dedupeKey: { in: eventIds.map(projectionDedupeKey) } },
        });
      }
      await prisma.domainEvent.deleteMany({ where: { campusId } });

      const participants = [buyerId, sellerId];
      await prisma.rentalOrder.deleteMany({
        where: {
          OR: [
            { ownerId: { in: participants } },
            { renterId: { in: participants } },
          ],
        },
      });
      await prisma.order.deleteMany({
        where: {
          OR: [
            { buyerId: { in: participants } },
            { sellerId: { in: participants } },
          ],
        },
      });
      await prisma.errandTask.deleteMany({ where: { campusId } });
      await prisma.product.deleteMany({ where: { campusId } });
      await prisma.serviceListing.deleteMany({ where: { campusId } });
      await prisma.rentalListing.deleteMany({ where: { campusId } });
      await prisma.productCategory.deleteMany({ where: { id: productCategoryId } });
      await prisma.serviceCategory.deleteMany({ where: { id: serviceCategoryId } });
      await prisma.rentalCategory.deleteMany({ where: { id: rentalCategoryId } });
      await prisma.errandCategory.deleteMany({ where: { id: errandCategoryId } });
      await prisma.user.deleteMany({ where: { id: { in: participants } } });
      await prisma.campus.deleteMany({ where: { id: campusId } });
      await prisma.$disconnect();
    });

    it("P10C2-PG-01: completed canonical rows converge to 10/20/8/15 CTV, excluding rental deposit", async () => {
      const suffix = randomUUID().slice(0, 8);
      const t = (minute: number) => new Date(Date.UTC(2026, 9, 2, 9, minute, 0));

      const product = await prisma.product.create({
        data: {
          title: "P10C2 product",
          description: "fixture",
          price: "10.00",
          locationText: "A",
          condition: "LIKE_NEW",
          status: "SOLD",
          sellerId,
          campusId,
          categoryId: productCategoryId,
          createdAt: t(1),
        },
      });
      const service = await prisma.serviceListing.create({
        data: {
          title: "P10C2 service",
          description: "fixture",
          categoryId: serviceCategoryId,
          price: "20.00",
          pricingUnit: "PER_ORDER",
          locationText: "B",
          providerId: sellerId,
          campusId,
          createdAt: t(2),
        },
      });
      const rental = await prisma.rentalListing.create({
        data: {
          ownerId: sellerId,
          categoryId: rentalCategoryId,
          campusId,
          title: "P10C2 rental",
          description: "fixture",
          condition: "LIKE_NEW",
          price: "15.00",
          pricingUnit: "PER_DAY",
          depositAmount: "50.00",
          minimumDuration: 1,
          maximumDuration: 30,
          totalQuantity: 1,
          availableQuantity: 1,
          pickupLocation: "C",
          returnLocation: "C",
          createdAt: t(3),
        },
      });
      const errand = await prisma.errandTask.create({
        data: {
          title: "P10C2 errand",
          description: "fixture",
          categoryId: errandCategoryId,
          reward: "8.00",
          pickupLocation: "D",
          deliveryLocation: "E",
          deadline: new Date(Date.UTC(2026, 9, 3, 9, 0, 0)),
          status: "COMPLETED",
          publisherId: buyerId,
          accepterId: sellerId,
          campusId,
          createdAt: t(4),
        },
      });

      const productOrder = await prisma.order.create({
        data: {
          orderNo: `P10C2-P-${suffix}`,
          type: "PRODUCT",
          status: "COMPLETED",
          paymentStatus: "OFFLINE_PENDING",
          amount: "10.00",
          completedAt: t(9),
          buyerId,
          sellerId,
          productId: product.id,
          createdAt: t(5),
        },
      });
      const serviceOrder = await prisma.order.create({
        data: {
          orderNo: `P10C2-S-${suffix}`,
          type: "SERVICE",
          status: "COMPLETED",
          paymentStatus: "OFFLINE_PENDING",
          amount: "20.00",
          completedAt: t(10),
          buyerId,
          sellerId,
          serviceListingId: service.id,
          createdAt: t(6),
        },
      });
      const errandOrder = await prisma.order.create({
        data: {
          orderNo: `P10C2-E-${suffix}`,
          type: "ERRAND",
          status: "COMPLETED",
          paymentStatus: "OFFLINE_PENDING",
          amount: "8.00",
          completedAt: t(11),
          buyerId,
          sellerId,
          errandTaskId: errand.id,
          createdAt: t(7),
        },
      });
      const rentalOrder = await prisma.rentalOrder.create({
        data: {
          orderNumber: `P10C2-R-${suffix}`,
          rentalListingId: rental.id,
          ownerId: sellerId,
          renterId: buyerId,
          startTime: t(8),
          endTime: new Date(Date.UTC(2026, 9, 3, 9, 8, 0)),
          quantity: 1,
          unitPriceSnapshot: "15.00",
          pricingUnitSnapshot: "PER_DAY",
          rentalDuration: 1,
          rentalAmount: "15.00",
          depositAmount: "50.00",
          serviceFee: "7.00",
          overdueFee: "3.00",
          depositDeduction: "5.00",
          finalAmount: "65.00",
          cancellationFee: "4.00",
          pickupLocationSnapshot: "C",
          returnLocationSnapshot: "C",
          status: "COMPLETED",
          completedAt: t(12),
          createdAt: t(8),
        },
      });

      const first = await prisma.$transaction((tx) =>
        backfillCanonicalTransactionValuesTx(tx, {
          batchLimit: 100,
          campusId,
        }),
      );
      expect(first).toEqual({
        scanned: 4,
        backfilled: 4,
        racedWithExisting: 0,
      });

      const events = await prisma.domainEvent.findMany({
        where: {
          campusId,
          eventType: "LIQUIDITY_TRANSACTION_VALUE_RECORDED",
        },
        orderBy: { occurredAt: "asc" },
      });
      expect(events).toHaveLength(4);
      expect(events.every((event) => event.sourceType === "BACKFILL_CANONICAL")).toBe(true);

      const byKey = new Map(events.map((event) => [event.occurrenceKey, event]));
      expect(byKey.get(
        `LIQUIDITY_TRANSACTION_VALUE_RECORDED:PRODUCT:${productOrder.id}`,
      )?.payload).toMatchObject({ bookedValue: "10.00" });
      expect(byKey.get(
        `LIQUIDITY_TRANSACTION_VALUE_RECORDED:SERVICE:${serviceOrder.id}`,
      )?.payload).toMatchObject({ bookedValue: "20.00" });
      expect(byKey.get(
        `LIQUIDITY_TRANSACTION_VALUE_RECORDED:ERRAND:${errandOrder.id}`,
      )?.payload).toMatchObject({ bookedValue: "8.00" });
      expect(byKey.get(
        `LIQUIDITY_TRANSACTION_VALUE_RECORDED:RENTAL:${rentalOrder.id}`,
      )?.payload).toMatchObject({ bookedValue: "15.00" });

      for (const event of events) {
        await prisma.$transaction((tx) => projectDomainEventTx(tx, event.id));
      }

      const contributions = await prisma.metricContribution.findMany({
        where: {
          eventId: { in: events.map((event) => event.id) },
          projectionVersion: 2,
          metricKey: "COMPLETED_TRANSACTION_VALUE",
        },
        orderBy: { dimensionKey: "asc" },
      });
      expect(contributions).toHaveLength(4);
      expect(
        contributions.map((row) => [row.dimensionKey, row.value.toFixed(2)]),
      ).toEqual([
        ["TRANSACTION_TYPE:ERRAND", "8.00"],
        ["TRANSACTION_TYPE:PRODUCT", "10.00"],
        ["TRANSACTION_TYPE:RENTAL", "15.00"],
        ["TRANSACTION_TYPE:SERVICE", "20.00"],
      ]);

      // Strong negative proof: rental CTV is core rentalAmount only.
      expect(rentalOrder.finalAmount.toFixed(2)).toBe("65.00");
      expect(rentalOrder.depositAmount.toFixed(2)).toBe("50.00");
      expect(rentalOrder.depositDeduction.toFixed(2)).toBe("5.00");
      const rentalContribution = contributions.find(
        (row) => row.dimensionKey === "TRANSACTION_TYPE:RENTAL",
      );
      expect(rentalContribution?.value.toFixed(2)).toBe("15.00");

      const second = await prisma.$transaction((tx) =>
        backfillCanonicalTransactionValuesTx(tx, {
          batchLimit: 100,
          campusId,
        }),
      );
      expect(second).toEqual({
        scanned: 0,
        backfilled: 0,
        racedWithExisting: 0,
      });
    });
  },
);
