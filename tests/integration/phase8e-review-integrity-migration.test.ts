import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  computeReviewDeadline,
  isCanonicallyVisibleReview,
  isPublicationConditionMet,
} from "@/lib/reviews/review-integrity";

// Phase 8E Commit 1：Review Integrity publication model 迁移合同（真实 PG）。
//
// 覆盖（§7/§30/§41）：
//   - 历史回填语义：backfill 产生的 historical 形状行
//     （blindUntil = publishedAt = createdAt）在 canonical visibility
//     下保持可见——历史评价绝不因迁移消失。
//   - CHECK（§30）：rating/overallRating ∈ [1,5]；authorId <> targetUserId；
//     RentalReview optional 维度 IS NULL OR ∈ [1,5]；blindUntil NOT NULL。
//   - 迁移 SQL 静态断言：backfill + assert + NOT NULL 步骤真实存在
//     （真实顺序由 fresh migrate deploy 在 CI/e2e-setup 执行验证）。

vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p8e01-${randomUUID().slice(0, 8)}`;
const FIXTURE_PASSWORD_HASH = ["$2a$10$", "itfixtureitfixtureitfixtureitfixtureitfix"].join("");

const createdUserIds: string[] = [];
const createdCampusIds: string[] = [];
const createdMembershipIds: string[] = [];
const createdOrderIds: string[] = [];
const createdRentalOrderIds: string[] = [];
const createdListingIds: string[] = [];
const createdRentalListingIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdReviewIds: string[] = [];
const createdRentalReviewIds: string[] = [];

let campusA: { id: string };

async function createFixtureUser(name: string) {
  const user = await rawClient!.user.create({
    data: {
      email: `${RUN_TAG}-${createdUserIds.length}-${name}@it.local`,
      name,
      passwordHash: FIXTURE_PASSWORD_HASH,
      schoolName: "集成测试大学",
      campusId: campusA.id,
      role: "STUDENT",
      status: "ACTIVE",
    },
  });
  createdUserIds.push(user.id);
  const membership = await rawClient!.campusMembership.create({
    data: { userId: user.id, campusId: campusA.id, status: "ACTIVE" },
  });
  createdMembershipIds.push(membership.id);
  return user;
}

async function createCompletedOrderFixture(options: { buyerId: string; sellerId: string }) {
  const order = await rawClient!.order.create({
    data: {
      orderNo: `P8E-${RUN_TAG}-${createdOrderIds.length}`,
      type: "PRODUCT",
      status: "COMPLETED",
      completedAt: new Date(),
      buyerId: options.buyerId,
      sellerId: options.sellerId,
      amount: "10.00",
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

async function createCompletedRentalOrderFixture(options: { ownerId: string; renterId: string }) {
  let category = await rawClient!.rentalCategory.findFirst({
    where: { slug: `it-${RUN_TAG}` },
  });
  if (!category) {
    category = await rawClient!.rentalCategory.create({
      data: { name: `IT 8E 夹具分类 ${RUN_TAG}`, slug: `it-${RUN_TAG}`, isActive: true },
    });
    createdCategoryIds.push(category.id);
  }
  const listing = await rawClient!.rentalListing.create({
    data: {
      ownerId: options.ownerId,
      categoryId: category.id,
      campusId: campusA.id,
      title: `IT 8E 夹具 ${RUN_TAG}-${createdRentalListingIds.length}`,
      description: "集成测试租赁物品",
      condition: "NORMAL_USED",
      price: 100,
      pricingUnit: "PER_DAY",
      depositAmount: 0,
      minimumDuration: 1,
      maximumDuration: 30,
      pickupLocation: "门口",
      returnLocation: "门口",
      status: "AVAILABLE",
    },
  });
  createdRentalListingIds.push(listing.id);

  const now = new Date();
  const order = await rawClient!.rentalOrder.create({
    data: {
      orderNumber: `IT-${RUN_TAG}-${createdRentalOrderIds.length}`,
      rentalListingId: listing.id,
      ownerId: options.ownerId,
      renterId: options.renterId,
      startTime: now,
      endTime: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      quantity: 1,
      unitPriceSnapshot: 100,
      pricingUnitSnapshot: "PER_DAY",
      rentalDuration: 1,
      rentalAmount: 100,
      depositAmount: 0,
      finalAmount: 100,
      paymentStatus: "OFFLINE_PENDING",
      depositStatus: "NOT_REQUIRED",
      status: "COMPLETED",
      completedAt: now,
      pickupLocationSnapshot: "门口",
      returnLocationSnapshot: "门口",
    },
  });
  createdRentalOrderIds.push(order.id);
  return order;
}

/** 迁移 backfill 产生的历史形状行：blindUntil = publishedAt = createdAt */
async function createHistoricalShapedReview(options: {
  orderId: string;
  authorId: string;
  targetUserId: string;
}) {
  const createdAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const review = await rawClient!.review.create({
    data: {
      orderId: options.orderId,
      authorId: options.authorId,
      targetUserId: options.targetUserId,
      rating: 5,
      tags: [],
      blindUntil: createdAt,
      publishedAt: createdAt,
      createdAt,
    },
  });
  createdReviewIds.push(review.id);
  return review;
}

async function createHistoricalShapedRentalReview(options: {
  orderId: string;
  authorId: string;
  targetUserId: string;
}) {
  const createdAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const review = await rawClient!.rentalReview.create({
    data: {
      orderId: options.orderId,
      authorId: options.authorId,
      targetUserId: options.targetUserId,
      overallRating: 4,
      tags: [],
      blindUntil: createdAt,
      publishedAt: createdAt,
      createdAt,
    },
  });
  createdRentalReviewIds.push(review.id);
  return review;
}

beforeAll(async () => {
  if (!integrationDatabaseUrl || !rawClient) {
    return;
  }
  campusA = await rawClient.campus.create({
    data: { name: `P8E01-A-${RUN_TAG}`, slug: `p8e01-a-${RUN_TAG}`, schoolName: "集成测试大学" },
  });
  createdCampusIds.push(campusA.id);
});

afterAll(async () => {
  if (!rawClient) {
    return;
  }

  await rawClient.review.deleteMany({ where: { id: { in: createdReviewIds } } });
  await rawClient.rentalReview.deleteMany({ where: { id: { in: createdRentalReviewIds } } });
  await rawClient.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await rawClient.rentalOrder.deleteMany({ where: { id: { in: createdRentalOrderIds } } });
  await rawClient.product.deleteMany({
    where: { sellerId: { in: createdUserIds }, title: { startsWith: `P8E- ${RUN_TAG}` } },
  });
  await rawClient.rentalListing.deleteMany({ where: { id: { in: createdRentalListingIds } } });
  await rawClient.rentalCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await rawClient.campusMembership.deleteMany({ where: { id: { in: createdMembershipIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await rawClient.campus.deleteMany({ where: { id: { in: createdCampusIds } } });

  const remainingCampus = await rawClient.campus.count({
    where: { id: { in: createdCampusIds } },
  });
  expect(remainingCampus).toBe(0);

  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl)("Phase 8E publication model migration（真实 PG）", () => {
  it("HIST-01 general：historical 形状行（publishedAt = createdAt）保持 canonical 可见（§41）", async () => {
    const buyer = await createFixtureUser("HIST01buyer");
    const seller = await createFixtureUser("HIST01seller");
    const order = await createCompletedOrderFixture({ buyerId: buyer.id, sellerId: seller.id });
    const review = await createHistoricalShapedReview({
      orderId: order.id,
      authorId: buyer.id,
      targetUserId: seller.id,
    });

    // 迁移前可见 → 迁移后仍可见：publication 条件满足 + 完整公开条件满足
    expect(isPublicationConditionMet(review, new Date())).toBe(true);
    expect(
      isCanonicallyVisibleReview(review, {
        now: new Date(),
        orderStatus: "COMPLETED",
        hasActiveDispute: false,
      }),
    ).toBe(true);
  });

  it("HIST-02 rental：historical 形状 RentalReview 同样保持可见（§41）", async () => {
    const owner = await createFixtureUser("HIST02owner");
    const renter = await createFixtureUser("HIST02renter");
    const order = await createCompletedRentalOrderFixture({ ownerId: owner.id, renterId: renter.id });
    const review = await createHistoricalShapedRentalReview({
      orderId: order.id,
      authorId: renter.id,
      targetUserId: owner.id,
    });

    expect(isPublicationConditionMet(review, new Date())).toBe(true);
    expect(
      isCanonicallyVisibleReview(review, {
        now: new Date(),
        orderStatus: "COMPLETED",
        hasActiveDispute: false,
      }),
    ).toBe(true);
  });

  it("CHECK-01 general rating 越界 / 自评 → DB 拒绝（§30）", async () => {
    const buyer = await createFixtureUser("CHK01buyer");
    const seller = await createFixtureUser("CHK01seller");
    const order = await createCompletedOrderFixture({ buyerId: buyer.id, sellerId: seller.id });

    await expect(
      rawClient!.review.create({
        data: {
          orderId: order.id,
          authorId: buyer.id,
          targetUserId: seller.id,
          rating: 6,
          tags: [],
          blindUntil: computeReviewDeadline(order.completedAt!),
        },
      }),
    ).rejects.toThrow();

    await expect(
      rawClient!.review.create({
        data: {
          orderId: order.id,
          authorId: buyer.id,
          targetUserId: buyer.id,
          rating: 5,
          tags: [],
          blindUntil: computeReviewDeadline(order.completedAt!),
        },
      }),
    ).rejects.toThrow();
  });

  it("CHECK-02 rental overallRating 越界 / optional 维度越界 / 自评 → DB 拒绝（§30）", async () => {
    const owner = await createFixtureUser("CHK02owner");
    const renter = await createFixtureUser("CHK02renter");
    const order = await createCompletedRentalOrderFixture({ ownerId: owner.id, renterId: renter.id });

    await expect(
      rawClient!.rentalReview.create({
        data: {
          orderId: order.id,
          authorId: renter.id,
          targetUserId: owner.id,
          overallRating: 0,
          tags: [],
          blindUntil: computeReviewDeadline(order.completedAt!),
        },
      }),
    ).rejects.toThrow();

    await expect(
      rawClient!.rentalReview.create({
        data: {
          orderId: order.id,
          authorId: renter.id,
          targetUserId: owner.id,
          overallRating: 5,
          itemMatchDesc: 7,
          tags: [],
          blindUntil: computeReviewDeadline(order.completedAt!),
        },
      }),
    ).rejects.toThrow();

    await expect(
      rawClient!.rentalReview.create({
        data: {
          orderId: order.id,
          authorId: renter.id,
          targetUserId: renter.id,
          overallRating: 5,
          tags: [],
          blindUntil: computeReviewDeadline(order.completedAt!),
        },
      }),
    ).rejects.toThrow();
  });

  it("CHECK-03 blindUntil NOT NULL → DB 拒绝缺失", async () => {
    const buyer = await createFixtureUser("CHK03buyer");
    const seller = await createFixtureUser("CHK03seller");
    const order = await createCompletedOrderFixture({ buyerId: buyer.id, sellerId: seller.id });

    await expect(
      rawClient!.$executeRaw`
        INSERT INTO "Review" ("id", "orderId", "authorId", "targetUserId", "rating", "tags", "createdAt")
        VALUES (${`chk03-${RUN_TAG}`}, ${order.id}, ${buyer.id}, ${seller.id}, 5, ARRAY[]::text[], NOW())`,
    ).rejects.toThrow();
  });

  it("MIGRATION-SQL：backfill → assert → NOT NULL 步骤真实存在（静态断言）", async () => {
    const { readFileSync } = await import("node:fs");
    const { readdirSync } = await import("node:fs");
    const migrationsRoot = "prisma/migrations";
    const dir = readdirSync(migrationsRoot).find((name) => name.includes("phase8e_review_integrity"));
    expect(dir).toBeDefined();
    const sql = readFileSync(`${migrationsRoot}/${dir}/migration.sql`, "utf8");

    // nullable add → backfill → assert no null → NOT NULL（§7 顺序）
    expect(sql).toMatch(/ADD COLUMN "blindUntil" TIMESTAMP\(3\)/);
    expect(sql).toMatch(/UPDATE "Review" SET "blindUntil" = "createdAt", "publishedAt" = "createdAt"/);
    expect(sql).toMatch(/UPDATE "RentalReview" SET "blindUntil" = "createdAt", "publishedAt" = "createdAt"/);
    expect(sql).toMatch(/RAISE EXCEPTION 'phase8e backfill check failed/);
    expect(sql).toMatch(/ALTER COLUMN "blindUntil" SET NOT NULL/);

    // 禁止给历史表直接加 non-null 无默认列（必须先 backfill）
    const notNullIndex = sql.indexOf('ALTER COLUMN "blindUntil" SET NOT NULL');
    const backfillIndex = sql.indexOf('UPDATE "Review" SET');
    expect(backfillIndex).toBeGreaterThan(-1);
    expect(notNullIndex).toBeGreaterThan(backfillIndex);
  });
});
