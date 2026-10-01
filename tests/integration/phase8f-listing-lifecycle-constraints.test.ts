import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Phase 8F（LISTING LIFECYCLE NORMALIZATION）DB structural constraint 集成
// 测试（真实 PostgreSQL，§59 / §86 冻结矩阵）。
//
// 证明（负例走 $executeRawUnsafe INSERT probe，与 Phase 7C M01/M03 同模式）：
//   - Product PAUSED → DB reject（status domain CHECK，23514）
//   - Service RESERVED / SOLD → DB reject（Product 专用状态）
//   - Rental FULLY_BOOKED / PENDING_REVIEW / BANNED → DB reject（legacy NEVER WRITE）
//   - 软删除一致性：deleted + 非 OFFLINE（Product/Service/Rental）、
//     deleted Errand + OPEN → DB reject（deletedAt 单调性 CHECK）
//   - canonical 写路径零阻力（各 domain 合法状态经 typed create/update 可写）
//
// 约束本体由 hand-written migration 20261002120000 添加（CI 在测试前
// migrate deploy；本地 INTEGRATION_DATABASE_URL 指向已迁移库）。

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p8f-${randomUUID().slice(0, 8)}`;
const CAMPUS_SLUG = `p8f-${randomUUID().slice(0, 8)}`;

let campusId = "";
let productCategoryId = "";
let serviceCategoryId = "";
let rentalCategoryId = "";
let errandCategoryId = "";
const userIds: string[] = [];
let sellerId = "";
const canonicalIds: string[] = [];
let canonicalErrandId = "";

async function createFixtureUser(name: string) {
  const user = await rawClient!.user.create({
    data: {
      email: `${RUN_TAG}-${userIds.length}-${name}@it.local`,
      name,
      passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
      schoolName: "集成测试大学",
      campusId,
      role: "STUDENT",
      status: "ACTIVE",
    },
  });
  userIds.push(user.id);
  return user;
}

/** 负例 probe：CHECK 命名约束必须以 23514 + 约束名拒绝（与 7C M01 断言同形）。 */
async function expectCheckRejected(sql: string, constraintName: string) {
  let message = "";
  try {
    await rawClient!.$executeRawUnsafe(sql);
  } catch (error) {
    expect((error as { code?: string }).code).toBe("P2010");
    message = String((error as { message?: string }).message ?? "");
  }
  expect(message).toContain("23514");
  expect(message).toContain(constraintName);
}

beforeAll(async () => {
  if (!rawClient) return;

  const campus = await rawClient.campus.upsert({
    where: { slug: CAMPUS_SLUG },
    create: { name: `8F 约束校区 ${randomUUID().slice(0, 6)}`, slug: CAMPUS_SLUG, schoolName: "集成测试大学" },
    update: {},
  });
  campusId = campus.id;

  const seller = await createFixtureUser("seller");
  sellerId = seller.id;

  const productCategory = await rawClient.productCategory.create({
    data: { name: `8F商品类目-${RUN_TAG}`, slug: `p8f-prod-${RUN_TAG}` },
  });
  productCategoryId = productCategory.id;

  const serviceCategory = await rawClient.serviceCategory.create({
    data: { name: `8F服务类目-${RUN_TAG}`, slug: `p8f-svc-${RUN_TAG}` },
  });
  serviceCategoryId = serviceCategory.id;

  const rentalCategory = await rawClient.rentalCategory.create({
    data: { name: `8F租赁类目-${RUN_TAG}`, slug: `p8f-rent-${RUN_TAG}` },
  });
  rentalCategoryId = rentalCategory.id;

  const errandCategory = await rawClient.errandCategory.create({
    data: { name: `8F跑腿类目-${RUN_TAG}`, slug: `p8f-err-${RUN_TAG}` },
  });
  errandCategoryId = errandCategory.id;
});

afterAll(async () => {
  if (!rawClient) return;

  // 反向 FK 清理（精确 fixture 域，不触碰共享数据；失败即抛——禁止吞错）
  if (canonicalErrandId) {
    await rawClient.errandTask.deleteMany({ where: { id: canonicalErrandId } });
  }
  if (canonicalIds.length > 0) {
    await rawClient.product.deleteMany({ where: { id: { in: canonicalIds } } });
    await rawClient.serviceListing.deleteMany({ where: { id: { in: canonicalIds } } });
    await rawClient.rentalListing.deleteMany({ where: { id: { in: canonicalIds } } });
  }
  await rawClient.productCategory.deleteMany({ where: { id: productCategoryId } });
  await rawClient.serviceCategory.deleteMany({ where: { id: serviceCategoryId } });
  await rawClient.rentalCategory.deleteMany({ where: { id: rentalCategoryId } });
  await rawClient.errandCategory.deleteMany({ where: { id: errandCategoryId } });
  await rawClient.campusMembership.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.riskState.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: userIds } } });
  await rawClient.campus.deleteMany({ where: { id: campusId } });

  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 8F listing lifecycle DB structural constraints (真实 PostgreSQL)",
  () => {
    it("LF-DB-01：Product PAUSED → DB reject（canonical 集合外）", async () => {
      await expectCheckRejected(
        `INSERT INTO "Product" ("id","title","description","price","condition","locationText","status","viewCount","favoriteCount","sellerId","campusId","categoryId","updatedAt")
         VALUES ('${RUN_TAG}-db01', '8F paused', 'probe', 10, 'NEW', '东门', 'PAUSED', 0, 0, '${sellerId}', '${campusId}', '${productCategoryId}', NOW())`,
        "product_lifecycle_status_domain_chk",
      );
    });

    it("LF-DB-02：ServiceListing RESERVED / SOLD → DB reject（Product 专用状态）", async () => {
      await expectCheckRejected(
        `INSERT INTO "ServiceListing" ("id","title","description","price","pricingUnit","locationText","status","completedOrderCount","averageRating","favoriteCount","providerId","campusId","categoryId","updatedAt")
         VALUES ('${RUN_TAG}-db02a', '8F reserved svc', 'probe', 10, 'PER_SESSION', '东门', 'RESERVED', 0, 0, 0, '${sellerId}', '${campusId}', '${serviceCategoryId}', NOW())`,
        "service_lifecycle_status_domain_chk",
      );

      await expectCheckRejected(
        `INSERT INTO "ServiceListing" ("id","title","description","price","pricingUnit","locationText","status","completedOrderCount","averageRating","favoriteCount","providerId","campusId","categoryId","updatedAt")
         VALUES ('${RUN_TAG}-db02b', '8F sold svc', 'probe', 10, 'PER_SESSION', '东门', 'SOLD', 0, 0, 0, '${sellerId}', '${campusId}', '${serviceCategoryId}', NOW())`,
        "service_lifecycle_status_domain_chk",
      );
    });

    it("LF-DB-03：Rental FULLY_BOOKED / PENDING_REVIEW / BANNED → DB reject（legacy NEVER WRITE）", async () => {
      for (const [suffix, legacyStatus] of [
        ["a", "FULLY_BOOKED"],
        ["b", "PENDING_REVIEW"],
        ["c", "BANNED"],
      ] as const) {
        await expectCheckRejected(
          `INSERT INTO "RentalListing" ("id","title","description","condition","price","pricingUnit","depositAmount","totalQuantity","minimumDuration","maximumDuration","pickupLocation","returnLocation","requiresApproval","status","viewCount","favoriteCount","ownerId","campusId","categoryId","updatedAt")
           VALUES ('${RUN_TAG}-db03${suffix}', '8F legacy rental', 'probe', 'NEW', 10, 'PER_DAY', 0, 1, 1, 7, '东门', '东门', false, '${legacyStatus}', 0, 0, '${sellerId}', '${campusId}', '${rentalCategoryId}', NOW())`,
          "rental_lifecycle_status_domain_chk",
        );
      }
    });

    it("LF-DB-04：软删除一致性——deleted Product/Service/Rental + 非 OFFLINE → DB reject", async () => {
      await expectCheckRejected(
        `INSERT INTO "Product" ("id","title","description","price","condition","locationText","status","viewCount","favoriteCount","sellerId","campusId","categoryId","deletedAt","updatedAt")
         VALUES ('${RUN_TAG}-db04a', '8F deleted product', 'probe', 10, 'NEW', '东门', 'ACTIVE', 0, 0, '${sellerId}', '${campusId}', '${productCategoryId}', NOW(), NOW())`,
        "product_deleted_status_consistency_chk",
      );

      await expectCheckRejected(
        `INSERT INTO "ServiceListing" ("id","title","description","price","pricingUnit","locationText","status","completedOrderCount","averageRating","favoriteCount","providerId","campusId","categoryId","deletedAt","updatedAt")
         VALUES ('${RUN_TAG}-db04b', '8F deleted service', 'probe', 10, 'PER_SESSION', '东门', 'ACTIVE', 0, 0, 0, '${sellerId}', '${campusId}', '${serviceCategoryId}', NOW(), NOW())`,
        "service_deleted_status_consistency_chk",
      );

      await expectCheckRejected(
        `INSERT INTO "RentalListing" ("id","title","description","condition","price","pricingUnit","depositAmount","totalQuantity","minimumDuration","maximumDuration","pickupLocation","returnLocation","requiresApproval","status","viewCount","favoriteCount","ownerId","campusId","categoryId","deletedAt","updatedAt")
         VALUES ('${RUN_TAG}-db04c', '8F deleted rental', 'probe', 'NEW', 10, 'PER_DAY', 0, 1, 1, 7, '东门', '东门', false, 'AVAILABLE', 0, 0, '${sellerId}', '${campusId}', '${rentalCategoryId}', NOW(), NOW())`,
        "rental_deleted_status_consistency_chk",
      );
    });

    it("LF-DB-05：软删除一致性——deleted Errand + OPEN → DB reject", async () => {
      await expectCheckRejected(
        `INSERT INTO "ErrandTask" ("id","title","description","reward","pickupLocation","deliveryLocation","status","favoriteCount","publisherId","campusId","categoryId","deadline","deletedAt","updatedAt")
         VALUES ('${RUN_TAG}-db05', '8F deleted errand', 'probe', 10, '东门', '西门', 'OPEN', 0, '${sellerId}', '${campusId}', '${errandCategoryId}', NOW() + INTERVAL '1 day', NOW(), NOW())`,
        "errand_deleted_status_consistency_chk",
      );
    });

    it("LF-DB-06：canonical 状态写路径零阻力（四域合法值经 typed 客户端全部可写）", async () => {
      const product = await rawClient!.product.create({
        data: {
          title: `8F canonical 商品 ${randomUUID().slice(0, 6)}`,
          description: "constraint probe",
          price: 10,
          condition: "NEW",
          locationText: "东门",
          categoryId: productCategoryId,
          campusId,
          sellerId,
          status: "RESERVED",
        },
      });
      canonicalIds.push(product.id);
      await rawClient!.product.update({ where: { id: product.id }, data: { status: "SOLD" } });
      await rawClient!.product.update({
        where: { id: product.id },
        data: { status: "OFFLINE", deletedAt: new Date() },
      });

      const service = await rawClient!.serviceListing.create({
        data: {
          title: `8F canonical 服务 ${randomUUID().slice(0, 6)}`,
          description: "constraint probe",
          price: 10,
          pricingUnit: "PER_SESSION",
          locationText: "东门",
          categoryId: serviceCategoryId,
          campusId,
          providerId: sellerId,
          status: "PAUSED",
        },
      });
      canonicalIds.push(service.id);

      const rental = await rawClient!.rentalListing.create({
        data: {
          title: `8F canonical 租赁 ${randomUUID().slice(0, 6)}`,
          description: "constraint probe",
          condition: "NEW",
          price: 10,
          pricingUnit: "PER_DAY",
          depositAmount: 0,
          totalQuantity: 1,
          minimumDuration: 1,
          maximumDuration: 7,
          pickupLocation: "东门",
          returnLocation: "东门",
          categoryId: rentalCategoryId,
          campusId,
          ownerId: sellerId,
          status: "PAUSED",
        },
      });
      canonicalIds.push(rental.id);

      const publisher = userIds[0]!;
      const errand = await rawClient!.errandTask.create({
        data: {
          title: `8F canonical 跑腿 ${randomUUID().slice(0, 6)}`,
          description: "constraint probe",
          reward: 10,
          pickupLocation: "东门",
          deliveryLocation: "西门",
          deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
          categoryId: errandCategoryId,
          campusId,
          publisherId: publisher,
          status: "CANCELLED",
          deletedAt: new Date(),
        },
      });
      canonicalErrandId = errand.id;
    });
  },
);
