import { randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Phase 8F（LISTING LIFECYCLE NORMALIZATION）public exposure matrix 集成
// 测试（真实 PostgreSQL，§55/§56/§57 冻结矩阵 + §21 favorite gate）。
//
// 同一 fixture 证明 wind-down listing 不出现在：
//   - 公开 list（getProductList / getServiceList / getErrandList /
//     getRentalListings）
//   - global search（getSearchResults）
//   - homepage sections（home-repository 三域 + 计数）
//   - related / recommendation pool（getProductDetail.relatedProducts）
//   - 新 favorite（toggleXxxFavorite 对非曝光态 DENY；既有收藏移除放行）
// 以及 detail access：participant 判定 + moderation overlay 不被 lifecycle
// 特权绕过（§18）。

vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const sessionSeam = vi.hoisted(() => ({
  actionUser: { current: null as null | { id: string; email: string; name: string } },
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser: async () => {
    if (!sessionSeam.actionUser.current) {
      throw new Error("NO_SESSION");
    }
    return sessionSeam.actionUser.current;
  },
  getActiveViewerId: async () => sessionSeam.actionUser.current?.id ?? null,
  getVerifiedSession: async () => {
    const current = sessionSeam.actionUser.current;
    return current ? { ok: true as const, user: current } : { ok: false as const };
  },
}));

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p8fv-${randomUUID().slice(0, 8)}`;
const CAMPUS_SLUG = `p8fv-${randomUUID().slice(0, 8)}`;

let campusId = "";
let productCategoryId = "";
let serviceCategoryId = "";
let rentalCategoryId = "";
let errandCategoryId = "";

const userIds: string[] = [];
const productIds: string[] = [];
const serviceIds: string[] = [];
const rentalIds: string[] = [];
const errandIds: string[] = [];
const orderIds: string[] = [];
const favoriteIds: string[] = [];
const moderationIds: string[] = [];

let fixtureSeq = 0;

async function createFixtureUser(name: string) {
  const seq = fixtureSeq++;
  const user = await rawClient!.user.create({
    data: {
      email: `${RUN_TAG}-${seq}-${name}@it.local`,
      name,
      passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
      schoolName: "集成测试大学",
      campusId,
      role: "STUDENT",
      status: "ACTIVE",
    },
  });
  userIds.push(user.id);
  await rawClient!.campusMembership.create({
    data: { userId: user.id, campusId, status: "ACTIVE" },
  });
  return user;
}

async function createProductFixture(sellerId: string, title: string, status: "ACTIVE" | "RESERVED" | "SOLD" | "OFFLINE" = "ACTIVE") {
  const product = await rawClient!.product.create({
    data: {
      title,
      description: "Phase 8F visibility fixture",
      price: 10,
      condition: "NEW",
      locationText: "东门",
      categoryId: productCategoryId,
      campusId,
      sellerId,
      status,
    },
  });
  productIds.push(product.id);
  return product;
}

async function createServiceFixture(providerId: string, title: string, status: "ACTIVE" | "PAUSED" | "OFFLINE" = "ACTIVE") {
  const service = await rawClient!.serviceListing.create({
    data: {
      title,
      description: "Phase 8F visibility fixture",
      price: 10,
      pricingUnit: "PER_SESSION",
      locationText: "东门",
      categoryId: serviceCategoryId,
      campusId,
      providerId,
      status,
    },
  });
  serviceIds.push(service.id);
  return service;
}

async function createRentalFixture(ownerId: string, title: string, status: "AVAILABLE" | "PAUSED" | "OFFLINE" = "AVAILABLE") {
  const listing = await rawClient!.rentalListing.create({
    data: {
      title,
      description: "Phase 8F visibility fixture",
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
      ownerId,
      status,
    },
  });
  rentalIds.push(listing.id);
  return listing;
}

async function createErrandFixture(publisherId: string, title: string, status: "OPEN" | "CLAIMED" | "COMPLETED" = "OPEN", accepterId?: string) {
  const errand = await rawClient!.errandTask.create({
    data: {
      title,
      description: "Phase 8F visibility fixture",
      reward: 10,
      pickupLocation: "东门",
      deliveryLocation: "西门",
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      categoryId: errandCategoryId,
      campusId,
      publisherId,
      status,
      accepterId: accepterId ?? null,
    },
  });
  errandIds.push(errand.id);
  return errand;
}

beforeAll(async () => {
  if (!rawClient) return;

  const campus = await rawClient.campus.upsert({
    where: { slug: CAMPUS_SLUG },
    create: { name: `8F 曝光校区 ${randomUUID().slice(0, 6)}`, slug: CAMPUS_SLUG, schoolName: "集成测试大学" },
    update: {},
  });
  campusId = campus.id;

  const productCategory = await rawClient.productCategory.create({
    data: { name: `8F商品类目-${RUN_TAG}`, slug: `p8fv-prod-${RUN_TAG}` },
  });
  productCategoryId = productCategory.id;

  const serviceCategory = await rawClient.serviceCategory.create({
    data: { name: `8F服务类目-${RUN_TAG}`, slug: `p8fv-svc-${RUN_TAG}` },
  });
  serviceCategoryId = serviceCategory.id;

  const rentalCategory = await rawClient.rentalCategory.create({
    data: { name: `8F租赁类目-${RUN_TAG}`, slug: `p8fv-rent-${RUN_TAG}` },
  });
  rentalCategoryId = rentalCategory.id;

  const errandCategory = await rawClient.errandCategory.create({
    data: { name: `8F跑腿类目-${RUN_TAG}`, slug: `p8fv-err-${RUN_TAG}` },
  });
  errandCategoryId = errandCategory.id;
});

afterAll(async () => {
  if (!rawClient) return;

  // 反向 FK 清理（精确 fixture ID 域；失败即抛——禁止吞错）
  await rawClient.notification.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.riskState.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.favorite.deleteMany({ where: { id: { in: favoriteIds } } });
  await rawClient.serviceFavorite.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.errandFavorite.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.rentalFavorite.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.listingModeration.deleteMany({ where: { id: { in: moderationIds } } });
  await rawClient.order.deleteMany({ where: { id: { in: orderIds } } });
  await rawClient.errandTask.deleteMany({ where: { id: { in: errandIds } } });
  await rawClient.rentalListing.deleteMany({ where: { id: { in: rentalIds } } });
  await rawClient.product.deleteMany({ where: { id: { in: productIds } } });
  await rawClient.serviceListing.deleteMany({ where: { id: { in: serviceIds } } });
  await rawClient.errandCategory.deleteMany({ where: { id: errandCategoryId } });
  await rawClient.rentalCategory.deleteMany({ where: { id: rentalCategoryId } });
  await rawClient.serviceCategory.deleteMany({ where: { id: serviceCategoryId } });
  await rawClient.productCategory.deleteMany({ where: { id: productCategoryId } });
  await rawClient.campusMembership.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: userIds } } });
  await rawClient.campus.deleteMany({ where: { id: campusId } });

  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 8F public exposure matrix（真实 PostgreSQL）",
  () => {
    it("EXP-01：四域公开 list = exposure state only（§55 全状态矩阵）", async () => {
      const seller = await createFixtureUser("EXP01卖家");
      const provider = await createFixtureUser("EXP01服务者");
      const owner = await createFixtureUser("EXP01出租者");
      const publisher = await createFixtureUser("EXP01发布者");

      // Product：ACTIVE visible；RESERVED/SOLD/OFFLINE hidden
      const activeProduct = await createProductFixture(seller.id, `8F可见商品-${randomUUID().slice(0, 6)}`, "ACTIVE");
      await createProductFixture(seller.id, `8F预订商品-${randomUUID().slice(0, 6)}`, "RESERVED");
      await createProductFixture(seller.id, `8F售出商品-${randomUUID().slice(0, 6)}`, "SOLD");
      await createProductFixture(seller.id, `8F下架商品-${randomUUID().slice(0, 6)}`, "OFFLINE");

      const { getProductList } = await import("@/repositories/product-repository");
      const productList = await getProductList({ q: "8F" });
      const productTitles = productList.items.map((item) => item.title);
      expect(productTitles).toContain(activeProduct.title);
      expect(productTitles.filter((title) => title.includes("预订") || title.includes("售出") || title.includes("下架"))).toEqual([]);

      // Service：ACTIVE visible；PAUSED/OFFLINE hidden
      const activeService = await createServiceFixture(provider.id, `8F可见服务-${randomUUID().slice(0, 6)}`, "ACTIVE");
      await createServiceFixture(provider.id, `8F暂停服务-${randomUUID().slice(0, 6)}`, "PAUSED");
      await createServiceFixture(provider.id, `8F下架服务-${randomUUID().slice(0, 6)}`, "OFFLINE");

      const { getServiceList } = await import("@/repositories/service-repository");
      const serviceList = await getServiceList({ q: "8F" });
      const serviceTitles = serviceList.items.map((item) => item.title);
      expect(serviceTitles).toContain(activeService.title);
      expect(serviceTitles.filter((title) => title.includes("暂停") || title.includes("下架"))).toEqual([]);

      // Rental：AVAILABLE visible；PAUSED/OFFLINE hidden
      const availableRental = await createRentalFixture(owner.id, `8F可租物品-${randomUUID().slice(0, 6)}`, "AVAILABLE");
      await createRentalFixture(owner.id, `8F暂停出租-${randomUUID().slice(0, 6)}`, "PAUSED");
      await createRentalFixture(owner.id, `8F下架租赁-${randomUUID().slice(0, 6)}`, "OFFLINE");

      const { getRentalListings } = await import("@/repositories/rental-listing-repository");
      const rentalList = await getRentalListings({ q: "8F" });
      const rentalTitles = rentalList.items.map((item) => item.title);
      expect(rentalTitles).toContain(availableRental.title);
      expect(rentalTitles.filter((title) => title.includes("暂停") || title.includes("下架"))).toEqual([]);

      // Errand：OPEN visible；CLAIMED/COMPLETED hidden
      const openErrand = await createErrandFixture(publisher.id, `8F可接任务-${randomUUID().slice(0, 6)}`, "OPEN");
      const accepter = await createFixtureUser("EXP01接单者");
      await createErrandFixture(publisher.id, `8F已接任务-${randomUUID().slice(0, 6)}`, "CLAIMED", accepter.id);
      await createErrandFixture(publisher.id, `8F完单任务-${randomUUID().slice(0, 6)}`, "COMPLETED", accepter.id);

      const { getErrandList } = await import("@/repositories/errand-repository");
      const errandList = await getErrandList({ q: "8F" });
      const errandTitles = errandList.items.map((item) => item.title);
      expect(errandTitles).toContain(openErrand.title);
      expect(errandTitles.filter((title) => title.includes("已接") || title.includes("完单"))).toEqual([]);
    });

    it("EXP-02：global search 不含 wind-down（Product 非 ACTIVE / Errand 非 OPEN / Service 非 ACTIVE）", async () => {
      const { getSearchResults } = await import("@/repositories/search-repository");
      const result = await getSearchResults("8F");

      for (const product of result.products) {
        expect(product.status).toBe("ACTIVE");
      }
      for (const service of result.services) {
        expect(service.status).toBe("ACTIVE");
      }
      for (const errand of result.errands) {
        expect(errand.status).toBe("OPEN");
      }
    });

    it("EXP-03：homepage sections 只含曝光态 + 计数一致（§56）", async () => {
      const { getHomepageSummary } = await import("@/repositories/home-repository");
      const summary = await getHomepageSummary({ campusId });
      expect(summary.productCount).toBeGreaterThanOrEqual(0);
      expect(summary.errandCount).toBeGreaterThanOrEqual(0);
      expect(summary.serviceCount).toBeGreaterThanOrEqual(0);

      // 精确口径：本校区本 fixture 的 ACTIVE 商品数 = summary.productCount 下限一致性
      const activeProducts = await rawClient!.product.count({
        where: { campusId, deletedAt: null, status: "ACTIVE" },
      });
      expect(summary.productCount).toBe(activeProducts);
    });

    it("EXP-04：related/recommendation pool 不含 wind-down（§56）", async () => {
      const seller = await createFixtureUser("EXP04卖家");
      const activeTarget = await createProductFixture(seller.id, `8F推荐目标-${randomUUID().slice(0, 6)}`, "ACTIVE");
      await createProductFixture(seller.id, `8F推荐不可见-${randomUUID().slice(0, 6)}`, "SOLD");

      const { getProductDetail } = await import("@/repositories/product-repository");
      const detail = await getProductDetail(activeTarget.id, undefined, { countView: false });
      for (const related of detail.relatedProducts) {
        expect(related.status).toBe("ACTIVE");
        expect(related.title.includes("不可见")).toBe(false);
      }
    });

    it("EXP-05（§21）：new favorite 对非曝光态 DENY；曝光态 ALLOW；移除既有收藏不受限", async () => {
      const seller = await createFixtureUser("EXP05卖家");
      const fan = await createFixtureUser("EXP05收藏者");
      sessionSeam.actionUser.current = { id: fan.id, email: "", name: "" };

      const { toggleFavorite } = await import("@/actions/product");
      const activeProduct = await createProductFixture(seller.id, `8F收藏可见-${randomUUID().slice(0, 6)}`, "ACTIVE");
      const soldProduct = await createProductFixture(seller.id, `8F收藏不可见-${randomUUID().slice(0, 6)}`, "SOLD");

      // 曝光态 → 收藏成功 + 计数 +1
      const activeForm = new FormData();
      activeForm.set("productId", activeProduct.id);
      await toggleFavorite(activeForm);
      const activeFavorite = await rawClient!.favorite.findUnique({
        where: { userId_productId: { userId: fan.id, productId: activeProduct.id } },
      });
      expect(activeFavorite).not.toBeNull();
      if (activeFavorite) favoriteIds.push(activeFavorite.id);
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: activeProduct.id } })).favoriteCount,
      ).toBe(1);

      // SOLD（非曝光态）→ DENY：零收藏行、零计数漂移
      const soldForm = new FormData();
      soldForm.set("productId", soldProduct.id);
      await toggleFavorite(soldForm);
      const soldFavorite = await rawClient!.favorite.findUnique({
        where: { userId_productId: { userId: fan.id, productId: soldProduct.id } },
      });
      expect(soldFavorite).toBeNull();
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: soldProduct.id } })).favoriteCount,
      ).toBe(0);

      // 移除既有收藏（allowed wind-down）：曝光态变化后仍可移除 + 计数 -1
      await rawClient!.product.update({ where: { id: activeProduct.id }, data: { status: "OFFLINE" } });
      await toggleFavorite(activeForm);
      expect(
        await rawClient!.favorite.findUnique({
          where: { userId_productId: { userId: fan.id, productId: activeProduct.id } },
        }),
      ).toBeNull();
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: activeProduct.id } })).favoriteCount,
      ).toBe(0);

      sessionSeam.actionUser.current = null;
    });

    it("EXP-06（§17/§57）：participant 判定 + lifecycle access（真实订单参与方可见非公开 listing）", async () => {
      const seller = await createFixtureUser("EXP06卖家");
      const buyer = await createFixtureUser("EXP06买家");
      const stranger = await createFixtureUser("EXP06路人");

      const reservedProduct = await createProductFixture(seller.id, `8F参与方商品-${randomUUID().slice(0, 6)}`, "RESERVED");
      const order = await rawClient!.order.create({
        data: {
          orderNo: `${RUN_TAG}${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
          type: "PRODUCT",
          status: "PENDING",
          productReservationExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
          buyerId: buyer.id,
          sellerId: seller.id,
          productId: reservedProduct.id,
          amount: "10.00",
        },
      });
      orderIds.push(order.id);

      const { isListingTransactionParticipant, resolveListingLifecycleAccess } = await import(
        "@/lib/listings/listing-visibility"
      );

      // buyer/seller = participant；路人 = null（ strangers 404 语义）
      expect(await isListingTransactionParticipant("PRODUCT", reservedProduct.id, buyer.id)).toBe(true);
      expect(await isListingTransactionParticipant("PRODUCT", reservedProduct.id, seller.id)).toBe(true);
      expect(await isListingTransactionParticipant("PRODUCT", reservedProduct.id, stranger.id)).toBe(false);
      expect(await isListingTransactionParticipant("PRODUCT", reservedProduct.id, null)).toBe(false);

      expect(
        resolveListingLifecycleAccess({
          status: "RESERVED",
          viewerId: buyer.id,
          ownerId: seller.id,
          isParticipant: await isListingTransactionParticipant("PRODUCT", reservedProduct.id, buyer.id),
        }),
      ).toBe("PARTICIPANT");
      expect(
        resolveListingLifecycleAccess({
          status: "RESERVED",
          viewerId: seller.id,
          ownerId: seller.id,
          isParticipant: false,
        }),
      ).toBe("OWNER");
      expect(
        resolveListingLifecycleAccess({
          status: "RESERVED",
          viewerId: stranger.id,
          ownerId: seller.id,
          isParticipant: false,
        }),
      ).toBeNull();

      // §20：participant/owner 查看不增 viewCount（页面逻辑用 lifecycleRole 判定——
      // 此处验证 PARTICIPANT/OWNER 角色不是 PUBLIC）
      const ownerRole = resolveListingLifecycleAccess({
        status: "ACTIVE",
        viewerId: seller.id,
        ownerId: seller.id,
        isParticipant: false,
      });
      expect(ownerRole).toBe("OWNER");
    });

    it("EXP-07（§18）：moderation overlay 优先级不被 lifecycle 特权绕过", async () => {
      const moderator = await createFixtureUser("EXP07治理员");

      const seller = await createFixtureUser("EXP07卖家");
      const buyer = await createFixtureUser("EXP07买家");
      const product = await createProductFixture(seller.id, `8F治理商品-${randomUUID().slice(0, 6)}`, "ACTIVE");

      const moderation = await rawClient!.listingModeration.create({
        data: {
          targetType: "PRODUCT",
          productId: product.id,
          campusId,
          observedStatus: "ACTIVE",
          reasonCode: "OTHER",
          moderatorId: moderator.id,
        },
      });
      moderationIds.push(moderation.id);

      // 公开发现面：活跃 moderation → 隐藏（Phase 7C listingModerationPublicFilter）
      const { getProductList } = await import("@/repositories/product-repository");
      const list = await getProductList({ q: "8F治理商品" });
      expect(list.items.map((item) => item.id)).not.toContain(product.id);

      // 详情 gate：owner → OWNER_VIEW；participant（buyer）→ HIDDEN（不得绕过
      // 治理保密——既有义务走 Order private surfaces）
      const { resolvePublicDetailModerationGate } = await import(
        "@/lib/moderation/listing-moderation-query"
      );
      expect(
        await resolvePublicDetailModerationGate({
          viewerId: seller.id,
          ownerId: seller.id,
          targetType: "PRODUCT",
          listingId: product.id,
        }),
      ).toBe("OWNER_VIEW");
      expect(
        await resolvePublicDetailModerationGate({
          viewerId: buyer.id,
          ownerId: seller.id,
          targetType: "PRODUCT",
          listingId: product.id,
        }),
      ).toBe("HIDDEN");

      // metadata（PUBLIC surface）：active moderation → generic fallback 判定源
      const { hasActiveModerationForPublicSurface } = await import(
        "@/lib/moderation/listing-moderation-query"
      );
      expect(await hasActiveModerationForPublicSurface("PRODUCT", product.id)).toBe(true);

      // 新订单义务：active moderation → DENY（order-creation 权威保持）
      const { createProductOrderTx } = await import("@/lib/order-creation");
      const { withTransaction } = await import("@/lib/prisma");
      const denied = await withTransaction((tx: Prisma.TransactionClient) =>
        createProductOrderTx(tx, {
          buyerId: buyer.id,
          product: { id: product.id, price: "10", sellerId: seller.id, campusId },
          meetingLocation: "东门",
          note: null,
        }),
      );
      expect(denied).toBeNull();
    });
  },
);
