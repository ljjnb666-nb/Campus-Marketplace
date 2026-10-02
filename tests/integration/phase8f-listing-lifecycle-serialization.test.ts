import { randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Phase 8F（LISTING LIFECYCLE NORMALIZATION）status/delete serialization
// 集成测试（真实 PostgreSQL）。指令冻结矩阵 §47-§54 / §60：
//
//   LF-RACE-P01/P02  seller OFFLINE ↔ buyer createProductOrder（双向 winner；
//                    order active ⇒ Product MUST = RESERVED——8F 核心 invariant）
//   LF-RACE-P03      deleteProduct ↔ createProductOrder（delete wins → no order；
//                    order wins → delete DENY）
//   LF-RACE-S01      deleteService ↔ createServiceOrder
//   LF-RACE-R01      deleteRentalListing ↔ createRentalOrder
//   LF-RACE-S02      Service status wind-down ↔ createServiceOrder（row lock
//                    serialization，无 stale create）
//   LF-RACE-R02      Rental status wind-down ↔ createRentalOrder
//
//   DEL-xx           deleteProductListingTx / deleteServiceListingTx /
//                    deleteRentalListingTx outcome 矩阵（non-owner / missing /
//                    already-deleted 幂等 / active obligation / SOLD terminal /
//                    valid once）+ stale RESERVED → OFFLINE DENY
//
// 全部走 production 事务入口（createProductOrderTx / createServiceOrderTx /
// createRentalOrderTx / updateProductStatusTx / delete*ListingTx），不经
// fixture 直写投影。竞态确定性：seam 暂停点 + pg_locks advisory waiter
// barrier（waitForAdvisoryLockWaiter，SLEEP_ORDERING = 0）。

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
  requireAdmin: async () => {
    if (!sessionSeam.actionUser.current) {
      throw new Error("NO_SESSION");
    }
    return sessionSeam.actionUser.current;
  },
}));

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p8f-${randomUUID().slice(0, 8)}`;
const CAMPUS_SLUG = `p8f-${randomUUID().slice(0, 8)}`;

let campusId = "";
let productCategoryId = "";
let serviceCategoryId = "";
let rentalCategoryId = "";

const userIds: string[] = [];
const productIds: string[] = [];
const serviceIds: string[] = [];
const rentalIds: string[] = [];
const orderIds: string[] = [];
const rentalOrderIds: string[] = [];

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

async function createProductFixture(sellerId: string, status: "ACTIVE" | "RESERVED" | "SOLD" | "OFFLINE" = "ACTIVE") {
  const product = await rawClient!.product.create({
    data: {
      title: `8F 商品 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8F lifecycle fixture",
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

async function createServiceFixture(providerId: string, status: "ACTIVE" | "PAUSED" | "OFFLINE" = "ACTIVE") {
  const service = await rawClient!.serviceListing.create({
    data: {
      title: `8F 服务 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8F lifecycle fixture",
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

async function createRentalFixture(ownerId: string, status: "AVAILABLE" | "PAUSED" | "OFFLINE" = "AVAILABLE") {
  const listing = await rawClient!.rentalListing.create({
    data: {
      title: `8F 租赁 ${randomUUID().slice(0, 6)}`,
      description: "Phase 8F lifecycle fixture",
      condition: "NEW",
      price: 10,
      pricingUnit: "PER_DAY",
      depositAmount: 0,
      totalQuantity: 2,
      minimumDuration: 1,
      maximumDuration: 30,
      pickupLocation: "东门",
      returnLocation: "东门",
      categoryId: rentalCategoryId,
      campusId,
      ownerId,
      status,
      requiresApproval: true,
    },
  });
  rentalIds.push(listing.id);
  return listing;
}

function tomorrowNoon(): Date {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(12, 0, 0, 0);
  return date;
}

function dayAfterTomorrowNoon(): Date {
  const date = tomorrowNoon();
  date.setDate(date.getDate() + 1);
  return date;
}

/** 真实 buyer 下单（createProductOrderTx 完整事务链）。 */
async function placeRealProductOrder(
  buyerId: string,
  product: { id: string; price: string; sellerId: string; campusId: string },
  guardRacePoint?: (tx: Prisma.TransactionClient) => Promise<void>,
) {
  const { createProductOrderTx } = await import("@/lib/order-creation");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    createProductOrderTx(tx, {
      buyerId,
      product,
      meetingLocation: "东门",
      note: null,
    }, guardRacePoint),
  );
}

/** 真实服务预约（createServiceOrderTx 完整事务链）。 */
async function placeRealServiceOrder(
  buyerId: string,
  service: { id: string; price: string; providerId: string; campusId: string },
  guardRacePoint?: (tx: Prisma.TransactionClient) => Promise<void>,
) {
  const { createServiceOrderTx } = await import("@/lib/order-creation");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    createServiceOrderTx(tx, {
      buyerId,
      service,
      meetingLocation: "东门",
      note: null,
    }, guardRacePoint),
  );
}

/** 真实租赁申请（createRentalOrderTx 完整事务链）。 */
async function placeRealRentalOrder(
  renterId: string,
  rentalListingId: string,
  guardRacePoint?: (tx: Prisma.TransactionClient) => Promise<void>,
) {
  const { createRentalOrderTx } = await import("@/lib/rental-order-machine");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    createRentalOrderTx(tx, {
      userId: renterId,
      rentalListingId,
      startTime: tomorrowNoon(),
      endTime: dayAfterTomorrowNoon(),
      quantity: 1,
    }, guardRacePoint),
  );
}

/** 真实 seller status 变更（updateProductStatusTx）。 */
async function setProductStatus(
  sellerId: string,
  productId: string,
  target: "ACTIVE" | "OFFLINE",
  seams?: { afterCheck?: (tx: Prisma.TransactionClient) => Promise<void> },
) {
  const { updateProductStatusTx } = await import("@/lib/listing-status-service");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    updateProductStatusTx(tx, sellerId, productId, target, seams),
  );
}

async function setServiceStatus(
  providerId: string,
  serviceId: string,
  target: "ACTIVE" | "PAUSED" | "OFFLINE",
  seams?: { afterCheck?: (tx: Prisma.TransactionClient) => Promise<void> },
) {
  const { updateServiceStatusTx } = await import("@/lib/listing-status-service");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    updateServiceStatusTx(tx, providerId, serviceId, target, seams),
  );
}

async function setRentalStatus(
  ownerId: string,
  listingId: string,
  target: "AVAILABLE" | "PAUSED" | "OFFLINE",
  seams?: { afterCheck?: (tx: Prisma.TransactionClient) => Promise<void> },
) {
  const { updateRentalListingStatusTx } = await import("@/lib/listing-status-service");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    updateRentalListingStatusTx(tx, ownerId, listingId, target, seams),
  );
}

async function deleteProduct(
  actorId: string,
  productId: string,
  seams?: { afterCheck?: (tx: Prisma.TransactionClient) => Promise<void> },
) {
  const { deleteProductListingTx } = await import("@/lib/listings/listing-lifecycle-service");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    deleteProductListingTx(tx, actorId, productId, seams),
  );
}

async function deleteService(
  actorId: string,
  serviceId: string,
  seams?: { afterCheck?: (tx: Prisma.TransactionClient) => Promise<void> },
) {
  const { deleteServiceListingTx } = await import("@/lib/listings/listing-lifecycle-service");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    deleteServiceListingTx(tx, actorId, serviceId, seams),
  );
}

async function deleteRental(
  actorId: string,
  listingId: string,
  seams?: { afterCheck?: (tx: Prisma.TransactionClient) => Promise<void> },
) {
  const { deleteRentalListingTx } = await import("@/lib/listings/listing-lifecycle-service");
  const { withTransaction } = await import("@/lib/prisma");
  return withTransaction((tx: Prisma.TransactionClient) =>
    deleteRentalListingTx(tx, actorId, listingId, seams),
  );
}

/** 可控 gate：首次调用挂起（等待 release），用于构造确定性交错。 */
function makeGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    wait: () => promise,
    release,
  };
}

beforeAll(async () => {
  if (!rawClient) return;

  const campus = await rawClient.campus.upsert({
    where: { slug: CAMPUS_SLUG },
    create: { name: `8F 序列化校区 ${randomUUID().slice(0, 6)}`, slug: CAMPUS_SLUG, schoolName: "集成测试大学" },
    update: {},
  });
  campusId = campus.id;

  const productCategory = await rawClient.productCategory.create({
    data: { name: `8F商品类目-${RUN_TAG}`, slug: `p8f2-prod-${RUN_TAG}` },
  });
  productCategoryId = productCategory.id;

  const serviceCategory = await rawClient.serviceCategory.create({
    data: { name: `8F服务类目-${RUN_TAG}`, slug: `p8f2-svc-${RUN_TAG}` },
  });
  serviceCategoryId = serviceCategory.id;

  const rentalCategory = await rawClient.rentalCategory.create({
    data: { name: `8F租赁类目-${RUN_TAG}`, slug: `p8f2-rent-${RUN_TAG}` },
  });
  rentalCategoryId = rentalCategory.id;
});

afterAll(async () => {
  if (!rawClient) return;

  // 反向 FK 清理（精确 fixture ID 域；失败即抛——禁止吞错）
  await rawClient.notification.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.riskState.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.rentalOrderStatusLog.deleteMany({ where: { orderId: { in: rentalOrderIds } } });
  await rawClient.rentalOrder.deleteMany({ where: { id: { in: rentalOrderIds } } });
  await rawClient.order.deleteMany({ where: { id: { in: orderIds } } });
  await rawClient.rentalListing.deleteMany({ where: { id: { in: rentalIds } } });
  await rawClient.product.deleteMany({ where: { id: { in: productIds } } });
  await rawClient.serviceListing.deleteMany({ where: { id: { in: serviceIds } } });
  await rawClient.rentalCategory.deleteMany({ where: { id: rentalCategoryId } });
  await rawClient.serviceCategory.deleteMany({ where: { id: serviceCategoryId } });
  await rawClient.productCategory.deleteMany({ where: { id: productCategoryId } });
  await rawClient.campusMembership.deleteMany({ where: { userId: { in: userIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: userIds } } });
  await rawClient.campus.deleteMany({ where: { id: campusId } });

  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 8F listing lifecycle serialization（真实 PostgreSQL）",
  () => {
    it("DEL-P：deleteProductListingTx outcome 矩阵（missing/owner/already-deleted 幂等/active obligation/SOLD/valid once）", async () => {
      const seller = await createFixtureUser("DEL-P卖家");
      const buyer = await createFixtureUser("DEL-P买家");
      const stranger = await createFixtureUser("DEL-P路人");

      // non-owner → MISSING_OR_FORBIDDEN
      const foreignProduct = await createProductFixture(seller.id);
      expect(await deleteProduct(stranger.id, foreignProduct.id)).toBe("MISSING_OR_FORBIDDEN");
      // missing → MISSING_OR_FORBIDDEN
      expect(await deleteProduct(seller.id, "nonexistent-product")).toBe("MISSING_OR_FORBIDDEN");

      // active obligation（PENDING / ACCEPTED / IN_DISPUTE）→ ACTIVE_OBLIGATION
      const reservedProduct = await createProductFixture(seller.id, "ACTIVE");
      const order = await placeRealProductOrder(buyer.id, {
        id: reservedProduct.id,
        price: "10",
        sellerId: seller.id,
        campusId,
      });
      expect(order).not.toBeNull();
      orderIds.push(order!.id);
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: reservedProduct.id } })).status,
      ).toBe("RESERVED");
      expect(await deleteProduct(seller.id, reservedProduct.id)).toBe("ACTIVE_OBLIGATION");
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: reservedProduct.id } })).deletedAt,
      ).toBeNull();

      // SOLD → SOLD_TERMINAL（成交历史不经用户删除破坏）
      const soldProduct = await createProductFixture(seller.id, "SOLD");
      expect(await deleteProduct(seller.id, soldProduct.id)).toBe("SOLD_TERMINAL");
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: soldProduct.id } })).deletedAt,
      ).toBeNull();

      // valid no-obligation → DELETED once（OFFLINE + deletedAt），repeat → ALREADY_DELETED 零二次副作用
      const plainProduct = await createProductFixture(seller.id);
      expect(await deleteProduct(seller.id, plainProduct.id)).toBe("DELETED");
      const deletedRow = await rawClient!.product.findUniqueOrThrow({ where: { id: plainProduct.id } });
      expect(deletedRow.status).toBe("OFFLINE");
      expect(deletedRow.deletedAt).not.toBeNull();

      expect(await deleteProduct(seller.id, plainProduct.id)).toBe("ALREADY_DELETED");
      const repeatRow = await rawClient!.product.findUniqueOrThrow({ where: { id: plainProduct.id } });
      expect(repeatRow.status).toBe("OFFLINE");
      expect(repeatRow.deletedAt?.getTime()).toBe(deletedRow.deletedAt?.getTime());
    });

    it("DEL-S/R：Service / Rental delete outcome 矩阵（active obligation DENY / terminal 放行 / 幂等）", async () => {
      const provider = await createFixtureUser("DEL-S服务者");
      const buyer = await createFixtureUser("DEL-S买家");
      const owner = await createFixtureUser("DEL-R出租者");
      const renter = await createFixtureUser("DEL-R租客");

      // Service：active SERVICE order（PENDING）→ DENY；terminal 后 → DELETED
      const service = await createServiceFixture(provider.id);
      const serviceOrder = await placeRealServiceOrder(buyer.id, {
        id: service.id,
        price: "10",
        providerId: provider.id,
        campusId,
      });
      expect(serviceOrder).not.toBeNull();
      orderIds.push(serviceOrder!.id);
      expect(await deleteService(provider.id, service.id)).toBe("ACTIVE_OBLIGATION");
      expect(
        (await rawClient!.serviceListing.findUniqueOrThrow({ where: { id: service.id } })).deletedAt,
      ).toBeNull();

      await rawClient!.order.update({
        where: { id: serviceOrder!.id },
        data: { status: "CANCELLED" },
      });
      expect(await deleteService(provider.id, service.id)).toBe("DELETED");
      const deletedService = await rawClient!.serviceListing.findUniqueOrThrow({ where: { id: service.id } });
      expect(deletedService.status).toBe("OFFLINE");
      expect(deletedService.deletedAt).not.toBeNull();
      expect(await deleteService(provider.id, service.id)).toBe("ALREADY_DELETED");

      // Service：IN_DISPUTE 也属 active obligation（复用 central helper 集合）
      const disputedService = await createServiceFixture(provider.id);
      const disputedOrder = await placeRealServiceOrder(buyer.id, {
        id: disputedService.id,
        price: "10",
        providerId: provider.id,
        campusId,
      });
      expect(disputedOrder).not.toBeNull();
      orderIds.push(disputedOrder!.id);
      await rawClient!.order.update({
        where: { id: disputedOrder!.id },
        data: { status: "IN_DISPUTE" },
      });
      expect(await deleteService(provider.id, disputedService.id)).toBe("ACTIVE_OBLIGATION");

      // Rental：active RentalOrder（PENDING_APPROVAL）→ DENY；terminal（COMPLETED）→ DELETED
      const rental = await createRentalFixture(owner.id);
      const rentalOrder = await placeRealRentalOrder(renter.id, rental.id);
      expect(rentalOrder).toMatchObject({ orderId: expect.any(String) });
      const rentalOrderId =
        "orderId" in rentalOrder && rentalOrder.orderId ? rentalOrder.orderId : "";
      rentalOrderIds.push(rentalOrderId);
      expect(await deleteRental(owner.id, rental.id)).toBe("ACTIVE_OBLIGATION");
      expect(
        (await rawClient!.rentalListing.findUniqueOrThrow({ where: { id: rental.id } })).deletedAt,
      ).toBeNull();

      await rawClient!.rentalOrder.update({
        where: { id: rentalOrderId },
        data: { status: "COMPLETED" },
      });
      expect(await deleteRental(owner.id, rental.id)).toBe("DELETED");
      const deletedRental = await rawClient!.rentalListing.findUniqueOrThrow({ where: { id: rental.id } });
      expect(deletedRental.status).toBe("OFFLINE");
      expect(deletedRental.deletedAt).not.toBeNull();
      expect(await deleteRental(owner.id, rental.id)).toBe("ALREADY_DELETED");
    });

    it("DEL-P-stale：stale RESERVED（无 active order）→ seller OFFLINE DENY（唯一恢复路径 ACTIVE）", async () => {
      const seller = await createFixtureUser("stale卖家");
      const product = await createProductFixture(seller.id, "RESERVED");

      expect(await setProductStatus(seller.id, product.id, "OFFLINE")).toBe(false);
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("RESERVED");

      // 恢复路径唯一：RESERVED → ACTIVE（capability PASS）
      expect(await setProductStatus(seller.id, product.id, "ACTIVE")).toBe(true);
      expect(
        (await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status,
      ).toBe("ACTIVE");
    });

    it("LF-RACE-P01/P02 case B：OFFLINE wins → new order DENY + Product OFFLINE（禁止 Order PENDING + Product OFFLINE）", async () => {
      const { waitForAdvisoryLockWaiter } = await import("./helpers/lock-barrier");
      const seller = await createFixtureUser("P01B卖家");
      const buyer = await createFixtureUser("P01B买家");
      const product = await createProductFixture(seller.id);

      // seller 状态事务先取 USER:seller 锁，afterCheck 暂停
      const gate = makeGate();
      const sellerTx = setProductStatus(seller.id, product.id, "OFFLINE", {
        afterCheck: () => gate.wait(),
      }).catch((error) => error);

      // seller 事务已进入 afterCheck（持 USER:seller 锁）后，buyer 下单
      // 必须阻塞在 participant advisory 锁上
      await new Promise((resolve) => setTimeout(resolve, 150));
      const buyerTx = placeRealProductOrder(buyer.id, {
        id: product.id,
        price: "10",
        sellerId: seller.id,
        campusId,
      }).catch((error) => error);
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${seller.id}`]);

      gate.release();
      expect(await sellerTx).toBe(true);
      const orderResult = await buyerTx;
      // 锁内 fresh 复查：Product 已 OFFLINE → 新义务 DENY（null = 无真实写入）
      expect(orderResult).toBeNull();

      const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(finalProduct.status).toBe("OFFLINE");
      const orderCount = await rawClient!.order.count({
        where: { productId: product.id, type: "PRODUCT" },
      });
      expect(orderCount).toBe(0);
    });

    it("LF-RACE-P01/P02 case A：order wins → Product MUST = RESERVED + seller OFFLINE DENY（8F 核心 invariant）", async () => {
      const { waitForAdvisoryLockWaiter } = await import("./helpers/lock-barrier");
      const seller = await createFixtureUser("P01A卖家");
      const buyer = await createFixtureUser("P01A买家");
      const product = await createProductFixture(seller.id);

      // buyer 下单事务先取得 sorted {buyer, seller} participant 锁，
      // guard racePoint（Product 行锁之前）暂停
      const gate = makeGate();
      const buyerTx = placeRealProductOrder(buyer.id, {
        id: product.id,
        price: "10",
        sellerId: seller.id,
        campusId,
      }, () => gate.wait()).catch((error) => error);

      // seller OFFLINE 请求必须阻塞在 USER:seller advisory 锁上
      await new Promise((resolve) => setTimeout(resolve, 150));
      const sellerTx = setProductStatus(seller.id, product.id, "OFFLINE").catch((error) => error);
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${seller.id}`]);

      gate.release();
      const orderResult = await buyerTx;
      expect(orderResult).not.toBeNull();
      orderIds.push(orderResult!.id);

      // seller 事务在锁内 fresh 读到 RESERVED + active order → DENY
      expect(await sellerTx).toBe(false);

      const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(finalProduct.status).toBe("RESERVED");
      const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: orderResult!.id } });
      expect(finalOrder.status).toBe("PENDING");
    });

    it("LF-RACE-P03：deleteProduct ↔ createProductOrder 两个 winner 方向（绝不 active order + deleted Product）", async () => {
      const { waitForAdvisoryLockWaiter } = await import("./helpers/lock-barrier");
      const seller = await createFixtureUser("P03卖家");
      const buyer = await createFixtureUser("P03买家");

      // 方向 1：delete wins → deletedAt != null，no order
      {
        const product = await createProductFixture(seller.id);
        const gate = makeGate();
        // delete 事务持 USER:seller 锁后在 afterCheck（active-order 检查后、写前）暂停
        const deleteTx = deleteProduct(seller.id, product.id, {
          afterCheck: () => gate.wait(),
        }).catch((error) => error);

        await new Promise((resolve) => setTimeout(resolve, 150));
        const buyerTx = placeRealProductOrder(buyer.id, {
          id: product.id,
          price: "10",
          sellerId: seller.id,
          campusId,
        }).catch((error) => error);
        await waitForAdvisoryLockWaiter(rawClient!, [`USER:${seller.id}`]);

        gate.release();
        expect(await deleteTx).toBe("DELETED");
        expect(await buyerTx).toBeNull();

        const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
        expect(finalProduct.deletedAt).not.toBeNull();
        const orderCount = await rawClient!.order.count({
          where: { productId: product.id, type: "PRODUCT" },
        });
        expect(orderCount).toBe(0);
      }

      // 方向 2：order wins → active order，Product not deleted（delete DENY）
      {
        const product = await createProductFixture(seller.id);
        const gate = makeGate();
        const buyerTx = placeRealProductOrder(buyer.id, {
          id: product.id,
          price: "10",
          sellerId: seller.id,
          campusId,
        }, () => gate.wait()).catch((error) => error);

        await new Promise((resolve) => setTimeout(resolve, 150));
        const deleteTx = deleteProduct(seller.id, product.id).catch((error) => error);
        await waitForAdvisoryLockWaiter(rawClient!, [`USER:${seller.id}`]);

        gate.release();
        const orderResult = await buyerTx;
        expect(orderResult).not.toBeNull();
        orderIds.push(orderResult!.id);
        expect(await deleteTx).toBe("ACTIVE_OBLIGATION");

        const finalProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
        expect(finalProduct.deletedAt).toBeNull();
        expect(finalProduct.status).toBe("RESERVED");
      }
    });

    it("LF-RACE-S01：deleteService ↔ createServiceOrder 两个 winner 方向", async () => {
      const { waitForAdvisoryLockWaiter } = await import("./helpers/lock-barrier");
      const provider = await createFixtureUser("S01服务者");
      const buyer = await createFixtureUser("S01买家");

      // 方向 1：delete wins → no order
      {
        const service = await createServiceFixture(provider.id);
        const gate = makeGate();
        const deleteTx = deleteService(provider.id, service.id, {
          afterCheck: () => gate.wait(),
        }).catch((error) => error);

        await new Promise((resolve) => setTimeout(resolve, 150));
        const buyerTx = placeRealServiceOrder(buyer.id, {
          id: service.id,
          price: "10",
          providerId: provider.id,
          campusId,
        }).catch((error) => error);
        await waitForAdvisoryLockWaiter(rawClient!, [`USER:${provider.id}`]);

        gate.release();
        expect(await deleteTx).toBe("DELETED");
        expect(await buyerTx).toBeNull();

        const orderCount = await rawClient!.order.count({
          where: { serviceListingId: service.id, type: "SERVICE" },
        });
        expect(orderCount).toBe(0);
      }

      // 方向 2：order wins → delete DENY（fresh 锁内看到 PENDING order）
      {
        const service = await createServiceFixture(provider.id);
        const gate = makeGate();
        const buyerTx = placeRealServiceOrder(buyer.id, {
          id: service.id,
          price: "10",
          providerId: provider.id,
          campusId,
        }, () => gate.wait()).catch((error) => error);

        await new Promise((resolve) => setTimeout(resolve, 150));
        const deleteTx = deleteService(provider.id, service.id).catch((error) => error);
        await waitForAdvisoryLockWaiter(rawClient!, [`USER:${provider.id}`]);

        gate.release();
        const orderResult = await buyerTx;
        expect(orderResult).not.toBeNull();
        orderIds.push(orderResult!.id);
        expect(await deleteTx).toBe("ACTIVE_OBLIGATION");

        const finalService = await rawClient!.serviceListing.findUniqueOrThrow({ where: { id: service.id } });
        expect(finalService.deletedAt).toBeNull();
      }
    });

    it("LF-RACE-R01：deleteRentalListing ↔ createRentalOrder 两个 winner 方向", async () => {
      const { waitForAdvisoryLockWaiter } = await import("./helpers/lock-barrier");
      const owner = await createFixtureUser("R01出租者");
      const renter = await createFixtureUser("R01租客");

      // 方向 1：delete wins → request DENY
      {
        const listing = await createRentalFixture(owner.id);
        const gate = makeGate();
        const deleteTx = deleteRental(owner.id, listing.id, {
          afterCheck: () => gate.wait(),
        }).catch((error) => error);

        await new Promise((resolve) => setTimeout(resolve, 150));
        const renterTx = placeRealRentalOrder(renter.id, listing.id).catch((error) => error);
        await waitForAdvisoryLockWaiter(rawClient!, [`USER:${owner.id}`]);

        gate.release();
        expect(await deleteTx).toBe("DELETED");
        const rentResult = await renterTx;
        expect(rentResult).toMatchObject({ error: expect.stringContaining("不存在或已下架") });

        const orderCount = await rawClient!.rentalOrder.count({
          where: { rentalListingId: listing.id },
        });
        expect(orderCount).toBe(0);
      }

      // 方向 2：rental request wins → delete DENY
      {
        const listing = await createRentalFixture(owner.id);
        const gate = makeGate();
        const renterTx = placeRealRentalOrder(renter.id, listing.id, () => gate.wait()).catch(
          (error) => error,
        );

        await new Promise((resolve) => setTimeout(resolve, 150));
        const deleteTx = deleteRental(owner.id, listing.id).catch((error) => error);
        await waitForAdvisoryLockWaiter(rawClient!, [`USER:${owner.id}`]);

        gate.release();
        const rentResult = await renterTx;
        expect(rentResult).toMatchObject({ orderId: expect.any(String) });
        if ("orderId" in rentResult && rentResult.orderId) {
          rentalOrderIds.push(rentResult.orderId);
        }
        expect(await deleteTx).toBe("ACTIVE_OBLIGATION");

        const finalListing = await rawClient!.rentalListing.findUniqueOrThrow({ where: { id: listing.id } });
        expect(finalListing.deletedAt).toBeNull();
      }
    });

    it("LF-RACE-S02：Service status wind-down ↔ createServiceOrder（row lock serialization；status 先赢 → 无 stale create）", async () => {
      const { waitForAdvisoryLockWaiter } = await import("./helpers/lock-barrier");
      const provider = await createFixtureUser("S02服务者");
      const buyer = await createFixtureUser("S02买家");

      // status wins：order 创建在锁内 fresh 读到 PAUSED → DENY
      {
        const service = await createServiceFixture(provider.id);
        const gate = makeGate();
        const statusTx = setServiceStatus(provider.id, service.id, "PAUSED", {
          afterCheck: () => gate.wait(),
        }).catch((error) => error);

        await new Promise((resolve) => setTimeout(resolve, 150));
        const buyerTx = placeRealServiceOrder(buyer.id, {
          id: service.id,
          price: "10",
          providerId: provider.id,
          campusId,
        }).catch((error) => error);
        await waitForAdvisoryLockWaiter(rawClient!, [`USER:${provider.id}`]);

        gate.release();
        expect(await statusTx).toBe(true);
        expect(await buyerTx).toBeNull();

        expect(
          (await rawClient!.serviceListing.findUniqueOrThrow({ where: { id: service.id } })).status,
        ).toBe("PAUSED");
        const orderCount = await rawClient!.order.count({
          where: { serviceListingId: service.id, type: "SERVICE" },
        });
        expect(orderCount).toBe(0);
      }

      // order wins：order 先提交（Service ACTIVE 行锁释放），status 后写 PAUSED
      // ——严格串行 total order，order 的 fresh 锁内读到的价格/状态无 stale
      {
        const service = await createServiceFixture(provider.id);
        const gate = makeGate();
        const buyerTx = placeRealServiceOrder(buyer.id, {
          id: service.id,
          price: "10",
          providerId: provider.id,
          campusId,
        }, () => gate.wait()).catch((error) => error);

        await new Promise((resolve) => setTimeout(resolve, 150));
        const statusTx = setServiceStatus(provider.id, service.id, "PAUSED").catch((error) => error);
        await waitForAdvisoryLockWaiter(rawClient!, [`USER:${provider.id}`]);

        gate.release();
        const orderResult = await buyerTx;
        expect(orderResult).not.toBeNull();
        orderIds.push(orderResult!.id);
        expect(await statusTx).toBe(true);

        expect(
          (await rawClient!.serviceListing.findUniqueOrThrow({ where: { id: service.id } })).status,
        ).toBe("PAUSED");
        const finalOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: orderResult!.id } });
        expect(finalOrder.status).toBe("PENDING");
      }
    });

    it("LF-RACE-R02：Rental status wind-down ↔ createRentalOrder（AVAILABLE 先赢 → 无 stale create）", async () => {
      const { waitForAdvisoryLockWaiter } = await import("./helpers/lock-barrier");
      const owner = await createFixtureUser("R02出租者");
      const renter = await createFixtureUser("R02租客");

      // status wins：createRentalOrderTx 锁内 fresh 读到 PAUSED → DENY
      {
        const listing = await createRentalFixture(owner.id);
        const gate = makeGate();
        const statusTx = setRentalStatus(owner.id, listing.id, "PAUSED", {
          afterCheck: () => gate.wait(),
        }).catch((error) => error);

        await new Promise((resolve) => setTimeout(resolve, 150));
        const renterTx = placeRealRentalOrder(renter.id, listing.id).catch((error) => error);
        await waitForAdvisoryLockWaiter(rawClient!, [`USER:${owner.id}`]);

        gate.release();
        expect(await statusTx).toBe(true);
        const rentResult = await renterTx;
        expect(rentResult).toMatchObject({ error: expect.stringContaining("不存在或已下架") });

        const orderCount = await rawClient!.rentalOrder.count({
          where: { rentalListingId: listing.id },
        });
        expect(orderCount).toBe(0);
      }

      // order wins：request 先提交（AVAILABLE → PENDING_APPROVAL），status 后写 PAUSED
      {
        const listing = await createRentalFixture(owner.id);
        const gate = makeGate();
        const renterTx = placeRealRentalOrder(renter.id, listing.id, () => gate.wait()).catch(
          (error) => error,
        );

        await new Promise((resolve) => setTimeout(resolve, 150));
        const statusTx = setRentalStatus(owner.id, listing.id, "PAUSED").catch((error) => error);
        await waitForAdvisoryLockWaiter(rawClient!, [`USER:${owner.id}`]);

        gate.release();
        const rentResult = await renterTx;
        expect(rentResult).toMatchObject({ orderId: expect.any(String) });
        if ("orderId" in rentResult && rentResult.orderId) {
          rentalOrderIds.push(rentResult.orderId);
        }
        expect(await statusTx).toBe(true);

        expect(
          (await rawClient!.rentalListing.findUniqueOrThrow({ where: { id: listing.id } })).status,
        ).toBe("PAUSED");
      }
    });
  },
);
