import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 10C-1 liquidity canonical backfill / projection（真实 PostgreSQL）",
  () => {
    let prisma: PrismaClient;
    let campusId = "";
    let buyerId = "";
    let sellerId = "";
    let productCategoryId = "";
    let serviceCategoryId = "";
    let rentalCategoryId = "";
    let errandCategoryId = "";

    let backfillCanonicalLiquidityFactsTx:
      typeof import("@/lib/analytics/liquidity-backfill")["backfillCanonicalLiquidityFactsTx"];
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

      ({ backfillCanonicalLiquidityFactsTx } = await import(
        "@/lib/analytics/liquidity-backfill"
      ));
      ({ projectDomainEventTx } = await import(
        "@/lib/analytics/domain-event-projection"
      ));

      const suffix = randomUUID().slice(0, 8);
      const campus = await prisma.campus.create({
        data: {
          name: `10C1 liquidity campus ${suffix}`,
          slug: `p10c1-${suffix}`,
          schoolName: "集成测试大学",
        },
      });
      campusId = campus.id;

      const [buyer, seller] = await Promise.all([
        prisma.user.create({
          data: {
            name: "p10c1-buyer",
            email: `p10c1-buyer-${suffix}@it.local`,
            passwordHash: "test-only",
            schoolName: "集成测试大学",
            campusId,
          },
        }),
        prisma.user.create({
          data: {
            name: "p10c1-seller",
            email: `p10c1-seller-${suffix}@it.local`,
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
            data: { name: `P10C1 product ${suffix}`, slug: `p10c1-p-${suffix}` },
          }),
          prisma.serviceCategory.create({
            data: { name: `P10C1 service ${suffix}`, slug: `p10c1-s-${suffix}` },
          }),
          prisma.rentalCategory.create({
            data: { name: `P10C1 rental ${suffix}`, slug: `p10c1-r-${suffix}` },
          }),
          prisma.errandCategory.create({
            data: { name: `P10C1 errand ${suffix}`, slug: `p10c1-e-${suffix}` },
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
      await prisma.rentalOrder.deleteMany({
        where: {
          OR: [
            { ownerId: { in: [buyerId, sellerId] } },
            { renterId: { in: [buyerId, sellerId] } },
          ],
        },
      });
      await prisma.order.deleteMany({
        where: {
          OR: [
            { buyerId: { in: [buyerId, sellerId] } },
            { sellerId: { in: [buyerId, sellerId] } },
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
      await prisma.user.deleteMany({ where: { id: { in: [buyerId, sellerId] } } });
      await prisma.campus.deleteMany({ where: { id: campusId } });
      await prisma.$disconnect();
    });

    it("P10C1-PG-01: 11 truthful historical facts converge to 3/4/4 v3 contributions", async () => {
      const suffix = randomUUID().slice(0, 8);
      const t = (minute: number) => new Date(Date.UTC(2026, 9, 1, 9, minute, 0));

      const product = await prisma.product.create({
        data: {
          title: "P10C1 product",
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
          title: "P10C1 service",
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
          title: "P10C1 rental",
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
          title: "P10C1 errand",
          description: "fixture",
          categoryId: errandCategoryId,
          reward: "8.00",
          pickupLocation: "D",
          deliveryLocation: "E",
          deadline: new Date(Date.UTC(2026, 9, 2, 9, 0, 0)),
          status: "COMPLETED",
          publisherId: buyerId,
          accepterId: sellerId,
          campusId,
          createdAt: t(4),
        },
      });

      const productOrder = await prisma.order.create({
        data: {
          orderNo: `P10C1-P-${suffix}`,
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
          orderNo: `P10C1-S-${suffix}`,
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
      const rentalOrder = await prisma.rentalOrder.create({
        data: {
          orderNumber: `P10C1-R-${suffix}`,
          rentalListingId: rental.id,
          ownerId: sellerId,
          renterId: buyerId,
          startTime: t(7),
          endTime: new Date(Date.UTC(2026, 9, 2, 9, 7, 0)),
          quantity: 1,
          unitPriceSnapshot: "15.00",
          pricingUnitSnapshot: "PER_DAY",
          rentalDuration: 1,
          rentalAmount: "15.00",
          depositAmount: "50.00",
          finalAmount: "65.00",
          pickupLocationSnapshot: "C",
          returnLocationSnapshot: "C",
          status: "COMPLETED",
          completedAt: t(11),
          createdAt: t(7),
        },
      });
      const errandOrder = await prisma.order.create({
        data: {
          orderNo: `P10C1-E-${suffix}`,
          type: "ERRAND",
          status: "COMPLETED",
          paymentStatus: "OFFLINE_PENDING",
          amount: "8.00",
          completedAt: t(12),
          buyerId,
          sellerId,
          errandTaskId: errand.id,
          createdAt: t(8),
        },
      });

      // Corrupt historical participant bindings must fail closed instead of
      // becoming permanent analytics facts.
      const corruptProductOrder = await prisma.order.create({
        data: {
          orderNo: `P10C1-CP-${suffix}`,
          type: "PRODUCT",
          status: "COMPLETED",
          paymentStatus: "OFFLINE_PENDING",
          amount: "10.00",
          completedAt: t(13),
          buyerId: sellerId,
          sellerId: buyerId,
          productId: product.id,
          createdAt: t(13),
        },
      });
      const corruptServiceOrder = await prisma.order.create({
        data: {
          orderNo: `P10C1-CS-${suffix}`,
          type: "SERVICE",
          status: "COMPLETED",
          paymentStatus: "OFFLINE_PENDING",
          amount: "20.00",
          completedAt: t(14),
          buyerId: sellerId,
          sellerId: buyerId,
          serviceListingId: service.id,
          createdAt: t(14),
        },
      });
      const corruptRentalOrder = await prisma.rentalOrder.create({
        data: {
          orderNumber: `P10C1-CR-${suffix}`,
          rentalListingId: rental.id,
          ownerId: buyerId,
          renterId: sellerId,
          startTime: t(15),
          endTime: new Date(Date.UTC(2026, 9, 2, 9, 15, 0)),
          quantity: 1,
          unitPriceSnapshot: "15.00",
          pricingUnitSnapshot: "PER_DAY",
          rentalDuration: 1,
          rentalAmount: "15.00",
          depositAmount: "50.00",
          finalAmount: "65.00",
          pickupLocationSnapshot: "C",
          returnLocationSnapshot: "C",
          status: "COMPLETED",
          completedAt: t(16),
          createdAt: t(15),
        },
      });

      // Historical creation/completion facts survive later soft deletion.
      await prisma.product.update({
        where: { id: product.id },
        data: { status: "OFFLINE", deletedAt: t(20) },
      });

      const first = await prisma.$transaction((tx) =>
        backfillCanonicalLiquidityFactsTx(tx, {
          batchLimit: 100,
          campusId,
        }),
      );
      expect(first).toEqual({
        scanned: 11,
        backfilled: 11,
        racedWithExisting: 0,
      });

      const events = await prisma.domainEvent.findMany({
        where: {
          campusId,
          eventType: {
            in: [
              "LIQUIDITY_LISTING_CREATED",
              "LIQUIDITY_DEMAND_CREATED",
              "LIQUIDITY_TRANSACTION_COMPLETED",
            ],
          },
        },
        orderBy: { occurredAt: "asc" },
      });
      expect(events).toHaveLength(11);
      expect(events.every((event) => event.sourceType === "BACKFILL_CANONICAL")).toBe(true);

      const productListingEvent = events.find(
        (event) => event.occurrenceKey === `LIQUIDITY_LISTING_CREATED:PRODUCT:${product.id}`,
      );
      expect(productListingEvent?.occurredAt.getTime()).toBe(t(1).getTime());
      expect(productListingEvent?.campusId).toBe(campusId);

      expect(
        events.some(
          (event) =>
            event.occurrenceKey ===
            `LIQUIDITY_DEMAND_CREATED:ERRAND_ORDER:${errandOrder.id}`,
        ),
      ).toBe(false);

      for (const corrupt of [
        { id: corruptProductOrder.id, demand: "PRODUCT_ORDER", tx: "PRODUCT" },
        { id: corruptServiceOrder.id, demand: "SERVICE_ORDER", tx: "SERVICE" },
        { id: corruptRentalOrder.id, demand: "RENTAL_ORDER", tx: "RENTAL" },
      ]) {
        expect(
          events.some(
            (event) =>
              event.occurrenceKey ===
                `LIQUIDITY_DEMAND_CREATED:${corrupt.demand}:${corrupt.id}` ||
              event.occurrenceKey ===
                `LIQUIDITY_TRANSACTION_COMPLETED:${corrupt.tx}:${corrupt.id}`,
          ),
        ).toBe(false);
      }

      for (const event of events) {
        await prisma.$transaction((tx) => projectDomainEventTx(tx, event.id));
      }

      const contributions = await prisma.metricContribution.findMany({
        where: {
          eventId: { in: events.map((event) => event.id) },
          projectionVersion: 3,
        },
      });
      expect(contributions).toHaveLength(11);
      expect(
        contributions.filter((row) => row.metricKey === "NEW_LISTING_COUNT"),
      ).toHaveLength(3);
      expect(
        contributions.filter((row) => row.metricKey === "DEMAND_CREATED_COUNT"),
      ).toHaveLength(4);
      expect(
        contributions.filter(
          (row) => row.metricKey === "COMPLETED_TRANSACTION_COUNT",
        ),
      ).toHaveLength(4);

      expect(
        contributions
          .filter((row) => row.metricKey === "COMPLETED_TRANSACTION_COUNT")
          .map((row) => row.dimensionKey)
          .sort(),
      ).toEqual([
        "TRANSACTION_TYPE:ERRAND",
        "TRANSACTION_TYPE:PRODUCT",
        "TRANSACTION_TYPE:RENTAL",
        "TRANSACTION_TYPE:SERVICE",
      ]);

      expect(
        events.find(
          (event) =>
            event.occurrenceKey ===
            `LIQUIDITY_TRANSACTION_COMPLETED:PRODUCT:${productOrder.id}`,
        )?.occurredAt.getTime(),
      ).toBe(t(9).getTime());
      expect(
        events.find(
          (event) =>
            event.occurrenceKey ===
            `LIQUIDITY_TRANSACTION_COMPLETED:SERVICE:${serviceOrder.id}`,
        )?.occurredAt.getTime(),
      ).toBe(t(10).getTime());
      expect(
        events.find(
          (event) =>
            event.occurrenceKey ===
            `LIQUIDITY_TRANSACTION_COMPLETED:RENTAL:${rentalOrder.id}`,
        )?.occurredAt.getTime(),
      ).toBe(t(11).getTime());

      const second = await prisma.$transaction((tx) =>
        backfillCanonicalLiquidityFactsTx(tx, {
          batchLimit: 100,
          campusId,
        }),
      );
      expect(second.backfilled).toBe(0);
      expect(second.scanned).toBe(0);
    });
  },
);
