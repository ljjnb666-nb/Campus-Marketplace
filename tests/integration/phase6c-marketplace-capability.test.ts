import { randomUUID } from "node:crypto";
import { waitForAdvisoryLockWaiter } from "./helpers/lock-barrier";
import { PrismaClient, Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Phase 6C-3 Marketplace Capability Gate 集成测试（真实 PostgreSQL）。
 *
 * 覆盖（Planning Repair 1/2 冻结矩阵）：
 *  - CAP-01..12/29/42：actor 三门 / scope 隔离 / restore 即时生效 / no-oracle
 *  - CAP-33..36：受限对手方（seller/provider/publisher/owner）→ 新义务统一 409
 *  - CAP-13..21：listing 编辑 gate + 重上架 gate + wind-down 放行（真实 action）
 *  - CAP-22..25/39..41：listing 会话串行化（锁后重读 / duplicate 收敛 EXISTING /
 *    既有会话与 sendMessage 放行）
 *  - CAP-44..47：对手方四维统一同形 / actor 403 族 / erasure 不变量
 *  - RACE-1..9：真实 PG advisory lock 竞态（racePoint + waitForAdvisoryLockWaiter
 *    promise barrier，零 sleep、零随机重试；全部 NO_40P01）
 *
 * 锁序合同：sorted participant/subject 锁（namespace 730501）→ 锁内校验 →
 * racePoint → domain write；restrict/restore（sorted actor+target 锁）与
 * mutation 在同一锁上串行——"restriction 先提交而 post-restriction mutation
 * 仍提交"不可能出现。
 */

// 竞态 barrier + Prisma 交互事务（默认 10s）需要超过默认 5s 的测试预算
vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const prisma = integrationDatabaseUrl ? (await import("@/lib/prisma")).prisma : null;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p6c3it-${randomUUID().slice(0, 8)}`;
const createdUserIds: string[] = [];
const createdCampusIds: string[] = [];
const createdRoleIds: string[] = [];
const createdCategoryIds: string[] = [];

async function createFixtureCampus(name: string) {
  const campus = await rawClient!.campus.create({
    data: { name, slug: `${RUN_TAG}-${name}`, schoolName: "集成测试大学" },
  });
  createdCampusIds.push(campus.id);
  return campus;
}

async function createFixtureUser(
  name: string,
  campusId: string,
  options: { role?: "STUDENT" | "ADMIN"; status?: "ACTIVE" | "SUSPENDED" } = {},
) {
  const user = await rawClient!.user.create({
    data: {
      email: `${RUN_TAG}-${createdUserIds.length}@it.local`,
      name,
      passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
      schoolName: "集成测试大学",
      campusId,
      role: options.role ?? "STUDENT",
      status: options.status ?? "ACTIVE",
    },
  });
  createdUserIds.push(user.id);
  await rawClient!.campusMembership.create({
    data: { userId: user.id, campusId, status: "ACTIVE" },
  });
  return user;
}

async function grantRole(
  userId: string,
  roleKey: string,
  permissionKeys: string[],
  scope: "GLOBAL" | "CAMPUS",
  campusId?: string,
) {
  const role = await rawClient!.role.create({
    data: {
      key: `${RUN_TAG}-${roleKey}`,
      name: roleKey,
      scope,
      isSystem: false,
      rolePermissions: {
        create: permissionKeys.map((key) => ({ permission: { connect: { key } } })),
      },
    },
  });
  createdRoleIds.push(role.id);
  await rawClient!.userRoleAssignment.create({
    data: {
      userId,
      roleId: role.id,
      campusId: campusId ?? null,
      scopeKey: scope === "GLOBAL" ? "GLOBAL" : `CAMPUS:${campusId}`,
    },
  });
  return role;
}

// ---------------------------------------------------------------------------
// action 层 requireUser 注入（mutable 指针；每条用例自选 fixture 身份）
// ---------------------------------------------------------------------------
const { integrationRequireUser } = vi.hoisted(() => ({
  integrationRequireUser: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser: integrationRequireUser,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_noStore: vi.fn(),
}));

let currentUser: { id: string } | null = null;

function actAs(userId: string) {
  currentUser = { id: userId };
  integrationRequireUser.mockImplementation(async () => {
    if (!currentUser) throw new Error("integration: 当前无 fixture 身份");
    return { id: currentUser.id, role: "STUDENT", name: "IT fixture" };
  });
}

function asGateError(error: unknown): { code?: string; status?: number; message?: string } {
  return error as { code?: string; status?: number; message?: string };
}

function gateTriple(error: unknown) {
  const shaped = asGateError(error);
  return { code: shaped.code, status: shaped.status, message: shaped.message };
}

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 6C-3 marketplace capability gate 集成测试（真实 PostgreSQL）",
  () => {
    let campusA: { id: string };
    let campusB: { id: string };
    let enforcerGlobal: { id: string };
    let campusManagerA: { id: string };
    let reviewer: { id: string };
    let sellerA: { id: string };
    let buyerA: { id: string };
    let sellerB: { id: string };
    let providerA: { id: string };
    let publisherA: { id: string };
    let ownerA: { id: string };
    let productA: { id: string };
    let productB: { id: string };
    let serviceA: { id: string };
    let errandA: { id: string };
    let rentalA: { id: string };
    let productCategoryA: { id: string };
    let errandCategoryA: { id: string };
    let serviceCategoryA: { id: string };
    let rentalCategoryA: { id: string };

    const trackedProductIds: string[] = [];
    const trackedErrandIds: string[] = [];
    const trackedServiceIds: string[] = [];
    const trackedRentalIds: string[] = [];
    const trackedOrderIds: string[] = [];

    beforeAll(async () => {
      campusA = await createFixtureCampus("campus-a");
      campusB = await createFixtureCampus("campus-b");

      enforcerGlobal = await createFixtureUser("全局执法者", campusA.id, { role: "ADMIN" });
      await grantRole(enforcerGlobal.id, "ENFORCER-G", ["user.suspend"], "GLOBAL");
      campusManagerA = await createFixtureUser("校区经理A", campusA.id);
      await grantRole(campusManagerA.id, "CM-A", ["campus.manage"], "CAMPUS", campusA.id);
      reviewer = await createFixtureUser("申诉复核员", campusA.id);
      // Appeal GRANT 的恢复动作经 setRiskStateTxLocked 落地，其对 GLOBAL 作用域
      // risk 行的 actor 授权要求 user.suspend（与 6B 合同一致）
      await grantRole(reviewer.id, "REVIEWER-G", ["appeal.review", "user.suspend"], "GLOBAL");

      const { ensureRbacFoundation } = await import("@/lib/rbac/bootstrap");
      await ensureRbacFoundation(prisma!);

      sellerA = await createFixtureUser("卖家A", campusA.id);
      buyerA = await createFixtureUser("买家A", campusA.id);
      providerA = await createFixtureUser("服务者A", campusA.id);
      publisherA = await createFixtureUser("发布者A", campusA.id);
      ownerA = await createFixtureUser("出租者A", campusA.id);
      sellerB = await createFixtureUser("卖家B", campusB.id);

      // buyerA 拥有 A/B 双校区 ACTIVE membership（跨校区 no-false-blocking 证明）
      await rawClient!.campusMembership.create({
        data: { userId: buyerA.id, campusId: campusB.id, status: "ACTIVE" },
      });

      productCategoryA = await rawClient!.productCategory.create({
        data: { name: `IT商品 ${RUN_TAG}`, slug: `it-prod-${RUN_TAG}`, isActive: true },
      });
      createdCategoryIds.push(productCategoryA.id);
      errandCategoryA = await rawClient!.errandCategory.create({
        data: { name: `IT跑腿 ${RUN_TAG}`, slug: `it-errand-${RUN_TAG}`, isActive: true },
      });
      createdCategoryIds.push(errandCategoryA.id);
      serviceCategoryA = await rawClient!.serviceCategory.create({
        data: { name: `IT服务 ${RUN_TAG}`, slug: `it-svc-${RUN_TAG}`, isActive: true },
      });
      createdCategoryIds.push(serviceCategoryA.id);
      rentalCategoryA = await rawClient!.rentalCategory.create({
        data: { name: `IT租赁 ${RUN_TAG}`, slug: `it-rental-${RUN_TAG}`, isActive: true },
      });
      createdCategoryIds.push(rentalCategoryA.id);

      productA = await rawClient!.product.create({
        data: {
          title: `IT 商品A ${randomUUID().slice(0, 6)}`,
          description: "6C-3 集成测试商品A",
          price: "10.00",
          condition: "NORMAL_USED",
          locationText: "北门",
          categoryId: productCategoryA.id,
          campusId: campusA.id,
          sellerId: sellerA.id,
          status: "ACTIVE",
        },
      });
      trackedProductIds.push(productA.id);

      productB = await rawClient!.product.create({
        data: {
          title: `IT 商品B ${randomUUID().slice(0, 6)}`,
          description: "6C-3 集成测试商品B（campus B）",
          price: 12,
          condition: "NEW",
          locationText: "南门",
          categoryId: productCategoryA.id,
          campusId: campusB.id,
          sellerId: sellerB.id,
          status: "ACTIVE",
        },
      });
      trackedProductIds.push(productB.id);

      serviceA = await rawClient!.serviceListing.create({
        data: {
          title: `IT 服务A ${randomUUID().slice(0, 6)}`,
          description: "6C-3 集成测试服务A",
          categoryId: serviceCategoryA.id,
          price: 30,
          pricingUnit: "PER_SESSION",
          locationText: "图书馆",
          campusId: campusA.id,
          providerId: providerA.id,
        },
      });
      trackedServiceIds.push(serviceA.id);

      errandA = await rawClient!.errandTask.create({
        data: {
          title: `IT 任务A ${randomUUID().slice(0, 6)}`,
          description: "6C-3 集成测试跑腿A",
          categoryId: errandCategoryA.id,
          reward: new Prisma.Decimal(8),
          pickupLocation: "快递站",
          deliveryLocation: "宿舍",
          deadline: new Date(Date.now() + 3600_000),
          campusId: campusA.id,
          publisherId: publisherA.id,
          status: "OPEN",
        },
      });
      trackedErrandIds.push(errandA.id);

      rentalA = await rawClient!.rentalListing.create({
        data: {
          title: `IT 租赁A ${randomUUID().slice(0, 6)}`,
          description: "6C-3 集成测试租赁A",
          condition: "NEW",
          price: "20.00",
          pricingUnit: "PER_DAY",
          depositAmount: "50.00",
          minimumDuration: 1,
          maximumDuration: 30,
          totalQuantity: 2,
          availableQuantity: 2,
          pickupLocation: "南门",
          returnLocation: "南门",
          status: "AVAILABLE",
          ownerId: ownerA.id,
          campusId: campusA.id,
          categoryId: rentalCategoryA.id,
        },
      });
      trackedRentalIds.push(rentalA.id);
    });

    afterAll(async () => {
      const userIds = createdUserIds;
      await rawClient!.appeal.deleteMany({
        where: { enforcementAction: { targetId: { in: userIds } } },
      });
      await rawClient!.enforcementAction.deleteMany({ where: { targetId: { in: userIds } } });
      await rawClient!.adminLog.deleteMany({ where: { adminId: { in: userIds } } });
      await rawClient!.message.deleteMany({
        where: { conversation: { participants: { some: { userId: { in: userIds } } } } },
      });
      await rawClient!.conversation.deleteMany({
        where: { participants: { some: { userId: { in: userIds } } } },
      });
      await rawClient!.notification.deleteMany({ where: { userId: { in: userIds } } });
      await rawClient!.order.deleteMany({ where: { buyerId: { in: userIds } } });
      await rawClient!.order.deleteMany({ where: { sellerId: { in: userIds } } });
      await rawClient!.rentalOrder.deleteMany({ where: { renterId: { in: userIds } } });
      await rawClient!.rentalOrder.deleteMany({ where: { ownerId: { in: userIds } } });
      await rawClient!.rentalUnavailablePeriod.deleteMany({
        where: { rentalListing: { ownerId: { in: userIds } } },
      });
      await rawClient!.favorite.deleteMany({ where: { userId: { in: userIds } } });
      await rawClient!.blockedUser.deleteMany({ where: { blockerId: { in: userIds } } });
      await rawClient!.blockedUser.deleteMany({ where: { blockedUserId: { in: userIds } } });
      await rawClient!.productImage.deleteMany({
        where: { product: { sellerId: { in: userIds } } },
      });
      await rawClient!.product.deleteMany({ where: { sellerId: { in: userIds } } });
      await rawClient!.product.deleteMany({ where: { id: { in: trackedProductIds } } });
      await rawClient!.errandTask.deleteMany({ where: { publisherId: { in: userIds } } });
      await rawClient!.serviceListing.deleteMany({ where: { providerId: { in: userIds } } });
      await rawClient!.rentalListingImage.deleteMany({
        where: { rentalListing: { ownerId: { in: userIds } } },
      });
      await rawClient!.rentalListing.deleteMany({ where: { ownerId: { in: userIds } } });
      await rawClient!.riskFlag.deleteMany({ where: { userId: { in: userIds } } });
      await rawClient!.riskState.deleteMany({ where: { userId: { in: userIds } } });
      await rawClient!.campusMembership.deleteMany({ where: { userId: { in: userIds } } });
      await rawClient!.userRoleAssignment.deleteMany({ where: { userId: { in: userIds } } });
      await rawClient!.rolePermission.deleteMany({ where: { roleId: { in: createdRoleIds } } });
      await rawClient!.role.deleteMany({ where: { id: { in: createdRoleIds } } });
      await rawClient!.user.deleteMany({ where: { id: { in: userIds } } });
      await rawClient!.productCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
      await rawClient!.errandCategory.deleteMany({
        where: { id: { in: createdCategoryIds } },
      });
      await rawClient!.serviceCategory.deleteMany({
        where: { id: { in: createdCategoryIds } },
      });
      await rawClient!.rentalCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
      await rawClient!.campus.deleteMany({ where: { id: { in: createdCampusIds } } });
      await rawClient!.$disconnect();
      await prisma?.$disconnect();
    });

    /** GLOBAL RESTRICT / restore（enforcer 持 user.suspend GLOBAL）。 */
    async function restrict(targetId: string, campusId: string | null = null) {
      const { setRiskState } = await import("@/lib/enforcement/risk-service");
      return setRiskState({
        actorId: campusId ? campusManagerA.id : enforcerGlobal.id,
        targetUserId: targetId,
        campusId,
        state: "RESTRICTED",
        reasonCode: "FRAUD_CONFIRMED",
        sourceType: "MANUAL",
      });
    }

    async function restore(targetId: string, campusId: string | null = null, state: "NORMAL" | "WATCH" = "NORMAL") {
      const { setRiskState } = await import("@/lib/enforcement/risk-service");
      return setRiskState({
        actorId: campusId ? campusManagerA.id : enforcerGlobal.id,
        targetUserId: targetId,
        campusId,
        state,
        reasonCode: "FALSE_POSITIVE_CORRECTION",
        sourceType: "MANUAL",
      });
    }

    async function createProductOrder(options: {
      buyerId: string;
      productId: string;
      sellerId: string;
      campusId: string;
      racePoint?: (tx: Prisma.TransactionClient) => Promise<void>;
    }) {
      const { withTransaction } = await import("@/lib/prisma");
      const { createProductOrderTx } = await import("@/lib/order-creation");
      return withTransaction((tx: Prisma.TransactionClient) =>
        createProductOrderTx(
          tx,
          {
            buyerId: options.buyerId,
            product: {
              id: options.productId,
              price: "10.00",
              sellerId: options.sellerId,
              campusId: options.campusId,
            },
            meetingLocation: "北门",
            note: null,
          },
          options.racePoint,
        ),
      );
    }

    // ==================================================================
    // CAP 矩阵（义务维度）
    // ==================================================================
    it("CAP-33 restricted seller → 新商品订单 deny（统一 409，buyer 无感）", async () => {
      await restrict(sellerA.id);
      const error = await createProductOrder({
        buyerId: buyerA.id,
        productId: productA.id,
        sellerId: sellerA.id,
        campusId: campusA.id,
      }).catch((e: unknown) => e);
      expect(gateTriple(error)).toMatchObject({
        code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE",
        status: 409,
        message: "对方当前无法开始新的交易，请稍后再试",
      });
      const orders = await rawClient!.order.findMany({ where: { productId: productA.id } });
      expect(orders).toHaveLength(0);
      // CAP-29(rev)：受限对手方 listing 仍公开可读（无 bulk unpublish）
      const listing = await rawClient!.product.findUniqueOrThrow({ where: { id: productA.id } });
      expect(listing.status).toBe("ACTIVE");
      await restore(sellerA.id);
    });

    it("CAP-34 restricted provider → 新服务预约 deny", async () => {
      await restrict(providerA.id);
      const { withTransaction } = await import("@/lib/prisma");
      const { createServiceOrderTx } = await import("@/lib/order-creation");
      const error = await withTransaction((tx: Prisma.TransactionClient) =>
        createServiceOrderTx(tx, {
          buyerId: buyerA.id,
          service: {
            id: serviceA.id,
            price: "30.00",
            providerId: providerA.id,
            campusId: campusA.id,
          },
          meetingLocation: "图书馆",
          note: null,
        }),
      ).catch((e: unknown) => e);
      expect(gateTriple(error)).toMatchObject({
        code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE",
        status: 409,
      });
      await restore(providerA.id);
    });

    it("CAP-35 restricted publisher → 接跑腿 deny", async () => {
      await restrict(publisherA.id);
      const { withTransaction } = await import("@/lib/prisma");
      const { claimErrandTx } = await import("@/lib/order-creation");
      const error = await withTransaction((tx: Prisma.TransactionClient) =>
        claimErrandTx(tx, {
          errandId: errandA.id,
          publisherId: publisherA.id,
          claimerId: buyerA.id,
          campusId: campusA.id,
          reward: new Prisma.Decimal(8),
        }),
      ).catch((e: unknown) => e);
      expect(gateTriple(error)).toMatchObject({
        code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE",
        status: 409,
      });
      const task = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errandA.id } });
      expect(task.status).toBe("OPEN");
      expect(task.accepterId).toBeNull();
      await restore(publisherA.id);
    });

    it("CAP-36 restricted rental owner → 新租赁单 deny", async () => {
      await restrict(ownerA.id);
      const { withTransaction } = await import("@/lib/prisma");
      const { createRentalOrderTx } = await import("@/lib/rental-order-machine");
      const error = await withTransaction((tx: Prisma.TransactionClient) =>
        createRentalOrderTx(tx, {
          userId: buyerA.id,
          rentalListingId: rentalA.id,
          startTime: new Date(Date.now() + 24 * 3600_000),
          endTime: new Date(Date.now() + 48 * 3600_000),
          quantity: 1,
        }),
      ).catch((e: unknown) => e);
      expect(gateTriple(error)).toMatchObject({
        code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE",
        status: 409,
      });
      await restore(ownerA.id);
    });

    it("CAP-03/45 actor restricted → actor 专用 403 族（不被 409 吞掉）", async () => {
      // actor risk restricted
      await restrict(buyerA.id);
      const riskError = await createProductOrder({
        buyerId: buyerA.id,
        productId: productA.id,
        sellerId: sellerA.id,
        campusId: campusA.id,
      }).catch((e: unknown) => e);
      expect(gateTriple(riskError)).toMatchObject({
        code: "MARKETPLACE_RESTRICTED",
        status: 403,
      });
      await restore(buyerA.id);

      // actor account inactive
      await rawClient!.user.update({
        where: { id: buyerA.id },
        data: { status: "SUSPENDED" },
      });
      const accountError = await createProductOrder({
        buyerId: buyerA.id,
        productId: productA.id,
        sellerId: sellerA.id,
        campusId: campusA.id,
      }).catch((e: unknown) => e);
      expect(gateTriple(accountError)).toMatchObject({
        code: "AUTH_ACCOUNT_INACTIVE",
        status: 403,
      });
      await rawClient!.user.update({
        where: { id: buyerA.id },
        data: { status: "ACTIVE" },
      });

      // actor membership inactive
      await rawClient!.campusMembership.updateMany({
        where: { userId: buyerA.id, campusId: campusA.id },
        data: { status: "SUSPENDED" },
      });
      const membershipError = await createProductOrder({
        buyerId: buyerA.id,
        productId: productA.id,
        sellerId: sellerA.id,
        campusId: campusA.id,
      }).catch((e: unknown) => e);
      expect(gateTriple(membershipError)).toMatchObject({
        code: "MEMBERSHIP_NOT_ACTIVE",
        status: 403,
      });
      await rawClient!.campusMembership.updateMany({
        where: { userId: buyerA.id, campusId: campusA.id },
        data: { status: "ACTIVE" },
      });
    });

    it("CAP-04/05 CAMPUS:A RESTRICTED → campusA deny / campusB 不受影响（隔离）", async () => {
      await restrict(sellerA.id, campusA.id);

      const campusAError = await createProductOrder({
        buyerId: buyerA.id,
        productId: productA.id,
        sellerId: sellerA.id,
        campusId: campusA.id,
      }).catch((e: unknown) => e);
      expect(gateTriple(campusAError)).toMatchObject({
        code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE",
        status: 409,
      });

      // campusB 卖家（无限制）正常成交——campus 限制不外溢
      const order = await createProductOrder({
        buyerId: buyerA.id,
        productId: productB.id,
        sellerId: sellerB.id,
        campusId: campusB.id,
      });
      expect(order).not.toBeNull();
      trackedOrderIds.push((order as { id: string }).id);

      await restore(sellerA.id, campusA.id);
    });

    it("CAP-44/46 对手方四维失效 → 完全同形（code/status/message 三重相等）", async () => {
      // account inactive（SUSPENDED）
      await rawClient!.user.update({
        where: { id: sellerA.id },
        data: { status: "SUSPENDED" },
      });
      const suspendedError = await createProductOrder({
        buyerId: buyerA.id,
        productId: productA.id,
        sellerId: sellerA.id,
        campusId: campusA.id,
      }).catch((e: unknown) => e);
      await rawClient!.user.update({
        where: { id: sellerA.id },
        data: { status: "ACTIVE" },
      });

      // membership inactive
      await rawClient!.campusMembership.updateMany({
        where: { userId: sellerA.id, campusId: campusA.id },
        data: { status: "SUSPENDED" },
      });
      const membershipError = await createProductOrder({
        buyerId: buyerA.id,
        productId: productA.id,
        sellerId: sellerA.id,
        campusId: campusA.id,
      }).catch((e: unknown) => e);
      await rawClient!.campusMembership.updateMany({
        where: { userId: sellerA.id, campusId: campusA.id },
        data: { status: "ACTIVE" },
      });

      // risk RESTRICTED
      await restrict(sellerA.id);
      const restrictedError = await createProductOrder({
        buyerId: buyerA.id,
        productId: productA.id,
        sellerId: sellerA.id,
        campusId: campusA.id,
      }).catch((e: unknown) => e);
      await restore(sellerA.id);

      // erased（deletedAt/erasedAt 置位）
      await rawClient!.user.update({
        where: { id: sellerA.id },
        data: { erasedAt: new Date() },
      });
      const erasedError = await createProductOrder({
        buyerId: buyerA.id,
        productId: productA.id,
        sellerId: sellerA.id,
        campusId: campusA.id,
      }).catch((e: unknown) => e);
      await rawClient!.user.update({
        where: { id: sellerA.id },
        data: { erasedAt: null },
      });

      const t1 = gateTriple(suspendedError);
      const t2 = gateTriple(membershipError);
      const t3 = gateTriple(restrictedError);
      const t4 = gateTriple(erasedError);
      expect(t1).toMatchObject({
        code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE",
        status: 409,
      });
      expect(t2).toEqual(t1);
      expect(t3).toEqual(t1);
      expect(t4).toEqual(t1);
    });

    it("CAP-06 restore → 同一 gate 立即恢复放行（受影响会话即时解封）", async () => {
      await restrict(sellerA.id);
      const denied = await createProductOrder({
        buyerId: buyerA.id,
        productId: productA.id,
        sellerId: sellerA.id,
        campusId: campusA.id,
      }).catch((e: unknown) => e);
      expect(gateTriple(denied)).toMatchObject({ code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE" });

      await restore(sellerA.id);
      const allowed = await createProductOrder({
        buyerId: buyerA.id,
        productId: productA.id,
        sellerId: sellerA.id,
        campusId: campusA.id,
      });
      expect(allowed).not.toBeNull();
      trackedOrderIds.push((allowed as { id: string }).id);
    });

    // ==================================================================
    // CAP 矩阵（listing 编辑 / 重上架 / wind-down，真实 action）
    // ==================================================================
    it("CAP-13/17 restricted 卖家：编辑 deny、重新上架 deny、下架 allow（真实 action）", async () => {
      actAs(sellerA.id);
      const { updateProduct, updateProductStatus } = await import("@/actions/product");

      const editForm = new FormData();
      editForm.set("productId", productA.id);
      editForm.set("title", "IT 商品A 编辑标题");
      editForm.set("description", "6C-3 集成测试编辑后的描述内容");
      editForm.set("price", "11.00");
      editForm.set("originalPrice", "");
      editForm.set("categoryId", productCategoryA.id);
      editForm.set("condition", "NORMAL_USED");
      editForm.set("locationText", "北门");

      await restrict(sellerA.id);

      // 编辑 = MODIFY_PUBLIC_LISTING_CONTENT → MARKETPLACE_RESTRICTED（403 文案）
      const editResult = await updateProduct({ success: false, message: "" }, editForm);
      expect(editResult.success).toBe(false);
      expect(editResult.message).toBe("当前无法开始新的交易活动，如有疑问请联系平台管理员");

      // 重新上架（OFFLINE → ACTIVE）= START_NEW → deny
      await rawClient!.product.update({
        where: { id: productA.id },
        data: { status: "OFFLINE" },
      });
      const republishForm = new FormData();
      republishForm.set("productId", productA.id);
      republishForm.set("status", "ACTIVE");
      await updateProductStatus(republishForm);
      const afterRepublish = await rawClient!.product.findUniqueOrThrow({
        where: { id: productA.id },
      });
      expect(afterRepublish.status).toBe("OFFLINE");

      // wind-down（→RESERVED）放行
      const winddownForm = new FormData();
      winddownForm.set("productId", productA.id);
      winddownForm.set("status", "RESERVED");
      await updateProductStatus(winddownForm);
      const afterWinddown = await rawClient!.product.findUniqueOrThrow({
        where: { id: productA.id },
      });
      expect(afterWinddown.status).toBe("RESERVED");

      await restore(sellerA.id);

      // restore 后：编辑与重上架恢复
      const editAfterRestore = await updateProduct({ success: false, message: "" }, editForm);
      expect(editAfterRestore.success).toBe(true);

      const republishAfterRestore = new FormData();
      republishAfterRestore.set("productId", productA.id);
      republishAfterRestore.set("status", "ACTIVE");
      await updateProductStatus(republishAfterRestore);
      const finalRow = await rawClient!.product.findUniqueOrThrow({ where: { id: productA.id } });
      expect(finalRow.status).toBe("ACTIVE");
    });

    it("CAP-15/18/21 restricted 出租者：→AVAILABLE deny、→PAUSED allow、编辑 deny", async () => {
      actAs(ownerA.id);
      const { updateRentalListingStatus } = await import("@/actions/rental-listing");

      await restrict(ownerA.id);

      const statusForm = new FormData();
      statusForm.set("listingId", rentalA.id);
      statusForm.set("status", "PAUSED");
      await updateRentalListingStatus(statusForm);
      expect((await rawClient!.rentalListing.findUniqueOrThrow({ where: { id: rentalA.id } })).status).toBe("PAUSED");

      const republishForm = new FormData();
      republishForm.set("listingId", rentalA.id);
      republishForm.set("status", "AVAILABLE");
      await updateRentalListingStatus(republishForm);
      expect((await rawClient!.rentalListing.findUniqueOrThrow({ where: { id: rentalA.id } })).status).toBe("PAUSED");

      await restore(ownerA.id);
      await updateRentalListingStatus(republishForm);
      expect((await rawClient!.rentalListing.findUniqueOrThrow({ where: { id: rentalA.id } })).status).toBe("AVAILABLE");
    });

    it("CAP-14/19 restricted 服务者：→ACTIVE deny、→PAUSED allow", async () => {
      actAs(providerA.id);
      const { updateServiceStatus } = await import("@/actions/service");

      await restrict(providerA.id);

      const pauseForm = new FormData();
      pauseForm.set("serviceId", serviceA.id);
      pauseForm.set("status", "PAUSED");
      await updateServiceStatus(pauseForm);
      expect((await rawClient!.serviceListing.findUniqueOrThrow({ where: { id: serviceA.id } })).status).toBe("PAUSED");

      const republishForm = new FormData();
      republishForm.set("serviceId", serviceA.id);
      republishForm.set("status", "ACTIVE");
      await updateServiceStatus(republishForm);
      expect((await rawClient!.serviceListing.findUniqueOrThrow({ where: { id: serviceA.id } })).status).toBe("PAUSED");

      await restore(providerA.id);
      await updateServiceStatus(republishForm);
      expect((await rawClient!.serviceListing.findUniqueOrThrow({ where: { id: serviceA.id } })).status).toBe("ACTIVE");
    });

    it("CAP-16/20 restricted 发布者：撤销接单（→OPEN）deny、（→CANCELLED from OPEN）allow", async () => {
      const { updateErrandStatus } = await import("@/actions/errand");

      // OPEN → CANCELLED 是 wind-down：不受限
      actAs(publisherA.id);
      const cancelForm = new FormData();
      cancelForm.set("errandId", errandA.id);
      cancelForm.set("status", "CANCELLED");
      await updateErrandStatus(cancelForm);
      expect((await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errandA.id } })).status).toBe("CANCELLED");

      // 复位：CANCELLED → OPEN 不在状态机内，直接置回 OPEN 供下一段使用
      await rawClient!.errandTask.update({
        where: { id: errandA.id },
        data: { status: "OPEN", deletedAt: null },
      });

      // CLAIMED → OPEN（撤销接单）= 重新暴露：restricted publisher deny
      await rawClient!.errandTask.update({
        where: { id: errandA.id },
        data: { status: "CLAIMED", accepterId: buyerA.id },
      });
      await restrict(publisherA.id);

      const reopenForm = new FormData();
      reopenForm.set("errandId", errandA.id);
      reopenForm.set("status", "OPEN");
      await updateErrandStatus(reopenForm);
      const row = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errandA.id } });
      expect(row.status).toBe("CLAIMED");
      expect(row.accepterId).toBe(buyerA.id);

      await restore(publisherA.id);
      await updateErrandStatus(reopenForm);
      const reopened = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errandA.id } });
      expect(reopened.status).toBe("OPEN");
      expect(reopened.accepterId).toBeNull();
    });

    it("CAP-23/41 既有义务沟通：ORDER 会话发起 + sendMessage 在 restriction 下放行", async () => {
      // 既有订单（限制前成交）
      const order = await createProductOrder({
        buyerId: buyerA.id,
        productId: productA.id,
        sellerId: sellerA.id,
        campusId: campusA.id,
      });
      expect(order).not.toBeNull();
      trackedOrderIds.push((order as { id: string }).id);

      await restrict(buyerA.id);

      actAs(buyerA.id);
      const { createOrOpenOrderConversation, sendMessage } = await import(
        "@/actions/conversation"
      );
      const orderForm = new FormData();
      orderForm.set("orderId", (order as { id: string }).id);
      orderForm.set("orderType", "PRODUCT");
      await expect(createOrOpenOrderConversation(orderForm)).rejects.toThrow("NEXT_REDIRECT");

      // 既有会话回复放行
      const conversation = await rawClient!.conversation.findFirstOrThrow({
        where: { orderId: (order as { id: string }).id },
      });
      const sendResult = await sendMessage(
        { success: false, message: "" },
        (() => {
          const fd = new FormData();
          fd.set("conversationId", conversation.id);
          fd.set("content", "关于订单的交接说明");
          return fd;
        })(),
      );
      expect(sendResult).toEqual({ success: true, message: "发送成功" });

      await restore(buyerA.id);
    });

    it("CAP-22/25/39 listing 会话：受限 actor/对手方 deny、既有会话放行（真实 action）", async () => {
      const { createOrOpenProductConversation } = await import("@/actions/conversation");
      const productForm = () => {
        const fd = new FormData();
        fd.set("productId", productA.id);
        return fd;
      };

      // 受限 actor → 403 文案
      await restrict(buyerA.id);
      actAs(buyerA.id);
      const actorDenied = await createOrOpenProductConversation(null, productForm());
      expect(actorDenied).toEqual({
        success: false,
        message: "当前无法开始新的交易活动，如有疑问请联系平台管理员",
      });
      await restore(buyerA.id);

      // 受限对手方（owner）→ 409 文案
      await restrict(sellerA.id);
      actAs(buyerA.id);
      const counterpartyDenied = await createOrOpenProductConversation(null, productForm());
      expect(counterpartyDenied).toEqual({
        success: false,
        message: "对方当前无法开始新的交易，请稍后再试",
      });
      await restore(sellerA.id);

      // 正常创建成功（action 以 redirect 结束）
      await expect(createOrOpenProductConversation(null, productForm())).rejects.toThrow(
        "NEXT_REDIRECT",
      );
      const conversationRow = await rawClient!.conversation.findFirstOrThrow({
        where: { productId: productA.id },
      });

      // CAP-25/41：限制落地后再进入既有会话 → 放行（不做 new-activity 拒绝）
      await restrict(buyerA.id);
      await expect(createOrOpenProductConversation(null, productForm())).rejects.toThrow(
        "NEXT_REDIRECT",
      );
      expect(conversationRow.id).toBeTruthy();
      await restore(buyerA.id);
    });

    // ==================================================================
    // RACE 矩阵
    // ==================================================================
    function controllableGate() {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    }

    /**
     * 确定性 poll：等待给定 governance 键的 advisory lock 处于 GRANTED
     * （即某事务已持有该锁）。与 waitForAdvisoryLockWaiter 互补——前者
     * 观察"等待方"，本函数观察"持有方"，均无 sleep 定时猜测（20ms 轮询 +
     * 确定性出现条件 + 15s 超时上限）。
     */
    async function waitForGovernanceLockHolder(key: string) {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const rows = await rawClient!.$queryRaw<{ locked: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory'
              AND classid = ${730_501}::int
              AND granted
              -- hashtext 是有符号 int4，pg_locks.objid 是无符号 oid：
              -- 必须经 bit(32) 重解释到同一无符号域，负 hash 键才能匹配
              AND objid = hashtext(${key})::bit(32)::bigint
          ) AS locked`;
        if (rows[0]?.locked) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const activity = await rawClient!.$queryRaw<
        { state: string; wait_event: string | null; left: string }[]
      >`
        SELECT state, wait_event, left(query, 120) AS left
        FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`;
      const locks = await rawClient!.$queryRaw<{ objid: bigint; granted: boolean; pid: number }[]>`
        SELECT objid, granted, pid FROM pg_locks WHERE locktype = 'advisory' AND classid = ${730_501}::int`;
      throw new Error(
        `granted-lock poll 超时: ${key}\nactivity=${JSON.stringify(activity)}\nlocks=${JSON.stringify(locks.map((r) => ({ o: String(r.objid), g: r.granted, pid: r.pid })))}`,
      );
    }

    it(
      "RACE-1 listing 创建 vs actor restriction（双方向，无 40P01）",
      async () => {
      const { withTransaction } = await import("@/lib/prisma");
      const { enforceMarketplaceCapability } = await import("@/lib/enforcement/capability-gate");
      const seller = await createFixtureUser("R1 卖家", campusA.id);
      const category = productCategoryA;

      const createListing = (racePoint?: (tx: Prisma.TransactionClient) => Promise<void>) =>
        withTransaction(async (tx: Prisma.TransactionClient) => {
          await enforceMarketplaceCapability(tx, seller.id, campusA.id);
          if (racePoint) await racePoint(tx);
          return tx.product.create({
            data: {
              title: `R1 商品 ${randomUUID().slice(0, 6)}`,
              description: "RACE-1 集成商品",
              price: 10,
              condition: "NEW",
              locationText: "北门",
              categoryId: category.id,
              campusId: campusA.id,
              sellerId: seller.id,
            },
          });
        });

      // 方向 A：listing 事务持锁挂起（racePoint）→ restrict 等待 → 释放
      // → listing 先提交 → restriction 随后生效（绝无 post-restriction commit）
      {
        const gate = controllableGate();
        const listingPromise = createListing(async () => {
          await gate.promise;
        });
        const restrictPromise = restrict(seller.id);
        await waitForAdvisoryLockWaiter(rawClient!, [`USER:${seller.id}`]);
        gate.release();
        const [listing, restrictResult] = await Promise.all([listingPromise, restrictPromise]);
        expect(listing).not.toBeNull();
        expect(restrictResult.changed).toBe(true);
        const risk = await rawClient!.riskState.findFirst({
          where: { userId: seller.id, scopeKey: "GLOBAL" },
        });
        expect(risk?.state).toBe("RESTRICTED");
        await restore(seller.id);
      }

      // 方向 B：restriction 先提交 → listing 创建被拒
      {
        await restrict(seller.id);
        await expect(createListing()).rejects.toMatchObject({
          code: "MARKETPLACE_RESTRICTED",
        });
        await restore(seller.id);
      }
    });

    it(
      "RACE-2/7a 新商品订单 vs restriction（actor 与对手方维度，双方向）",
      async () => {
      const seller = await createFixtureUser("R2 卖家", campusA.id);
      const buyer = await createFixtureUser("R2 买家", campusA.id);
      const product = await rawClient!.product.create({
        data: {
          title: `R2 商品 ${randomUUID().slice(0, 6)}`,
          description: "RACE-2 集成商品",
          price: 10,
          condition: "NEW",
          locationText: "北门",
          categoryId: productCategoryA.id,
          campusId: campusA.id,
          sellerId: seller.id,
          status: "ACTIVE",
        },
      });
      trackedProductIds.push(product.id);

      // 方向 A（对手方维度）：order 持锁挂起 → seller restrict 等待 → release
      // → order 提交 → restrict 随后生效（绝无 post-restriction commit）
      {
        const gate = controllableGate();
        const orderPromise = createProductOrder({
          buyerId: buyer.id,
          productId: product.id,
          sellerId: seller.id,
          campusId: campusA.id,
          racePoint: async () => {
            await gate.promise;
          },
        });
        // restrict 需要 seller 锁（order tx 已持有）→ 进入等待队列
        const restrictPromise = restrict(seller.id);
        await waitForAdvisoryLockWaiter(rawClient!, [`USER:${seller.id}`]);
        gate.release();
        const order = await orderPromise;
        await restrictPromise;
        expect(order).not.toBeNull();
        const risk = await rawClient!.riskState.findFirst({
          where: { userId: seller.id, scopeKey: "GLOBAL" },
        });
        expect(risk?.state).toBe("RESTRICTED");
        // restriction 生效后：新订单被拒
        const denied = await createProductOrder({
          buyerId: buyer.id,
          productId: product.id,
          sellerId: seller.id,
          campusId: campusA.id,
        }).catch((e: unknown) => e);
        expect(gateTriple(denied)).toMatchObject({
          code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE",
        });
        await restore(seller.id);
      }

      // 方向 B：restrict 先提交 → order 被拒（对手方 409）
      {
        const gate = controllableGate();
        const restrictPromise = restrict(seller.id, null).then((r) => {
          gate.release();
          return r;
        });
        await restrictPromise;
        const denied = await createProductOrder({
          buyerId: buyer.id,
          productId: product.id,
          sellerId: seller.id,
          campusId: campusA.id,
        }).catch((e: unknown) => e);
        expect(gateTriple(denied)).toMatchObject({
          code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE",
        });
        await restore(seller.id);
      }

      // 方向 C（actor 维度）：buyer restrict 先提交 → order 抛 actor 专用 403
      {
        await restrict(buyer.id);
        const denied = await createProductOrder({
          buyerId: buyer.id,
          productId: product.id,
          sellerId: seller.id,
          campusId: campusA.id,
        }).catch((e: unknown) => e);
        expect(gateTriple(denied)).toMatchObject({ code: "MARKETPLACE_RESTRICTED" });
        await restore(buyer.id);
      }
    });

    it(
      "RACE-3/4 campus 作用域：campusA restrict vs campusA 重上架 deny；campusB mutation 不误伤",
      async () => {
      const seller = await createFixtureUser("R3 卖家", campusA.id);
      await rawClient!.campusMembership.create({
        data: { userId: seller.id, campusId: campusB.id, status: "ACTIVE" },
      });
      const listingA = await rawClient!.product.create({
        data: {
          title: `R3 商品A ${randomUUID().slice(0, 6)}`,
          description: "RACE-3 集成商品A",
          price: 10,
          condition: "NEW",
          locationText: "北门",
          categoryId: productCategoryA.id,
          campusId: campusA.id,
          sellerId: seller.id,
          status: "OFFLINE",
        },
      });
      trackedProductIds.push(listingA.id);
      const listingB = await rawClient!.product.create({
        data: {
          title: `R3 商品B ${randomUUID().slice(0, 6)}`,
          description: "RACE-3 集成商品B",
          price: 10,
          condition: "NEW",
          locationText: "南门",
          categoryId: productCategoryA.id,
          campusId: campusB.id,
          sellerId: seller.id,
          status: "OFFLINE",
        },
      });
      trackedProductIds.push(listingB.id);

      const { withTransaction } = await import("@/lib/prisma");
      const { enforceMarketplaceCapability } = await import("@/lib/enforcement/capability-gate");
      const republish = (productId: string, campusId: string) =>
        withTransaction(async (tx: Prisma.TransactionClient) => {
          await enforceMarketplaceCapability(tx, seller.id, campusId);
          return tx.product.update({
            where: { id: productId },
            data: { status: "ACTIVE" },
          });
        });

      await restrict(seller.id, campusA.id);

      // campusA 重上架被拒（CAMPUS:A RESTRICTED 命中）
      await expect(republish(listingA.id, campusA.id)).rejects.toMatchObject({
        code: "MARKETPLACE_RESTRICTED",
      });
      // campusB mutation 不误伤（RACE-4）
      const updatedB = await republish(listingB.id, campusB.id);
      expect(updatedB.status).toBe("ACTIVE");

      await restore(seller.id, campusA.id);
      await expect(republish(listingA.id, campusA.id)).resolves.toMatchObject({
        status: "ACTIVE",
      });
    });

    it(
      "RACE-5 mutation vs MARKETPLACE_RESTORE：双方向确定性（restore 先 → 放行；mutation 先 → 提交后 restore）",
      async () => {
      const seller = await createFixtureUser("R5 卖家", campusA.id);
      const buyer = await createFixtureUser("R5 买家", campusA.id);
      const product = await rawClient!.product.create({
        data: {
          title: `R5 商品 ${randomUUID().slice(0, 6)}`,
          description: "RACE-5 集成商品",
          price: 10,
          condition: "NEW",
          locationText: "北门",
          categoryId: productCategoryA.id,
          campusId: campusA.id,
          sellerId: seller.id,
          status: "ACTIVE",
        },
      });
      trackedProductIds.push(product.id);

      await restrict(seller.id);

      // 方向 A：restore 先 commit → order 放行
      await restore(seller.id, null, "WATCH");
      const order = await createProductOrder({
        buyerId: buyer.id,
        productId: product.id,
        sellerId: seller.id,
        campusId: campusA.id,
      });
      expect(order).not.toBeNull();
      trackedOrderIds.push((order as { id: string }).id);

      // 方向 B：restrict（持锁 racePoint）先持锁（granted-poll 确认）→ restore 后启动
      //（被 advisory lock 串行化，必然晚于 restrict no-op commit）→ 确定性最终态 NORMAL
      await restrict(seller.id);
      const gate = controllableGate();
      const restrictAgain = (async () => {
        const { setRiskState } = await import("@/lib/enforcement/risk-service");
        return setRiskState({
          actorId: enforcerGlobal.id,
          targetUserId: seller.id,
          campusId: null,
          state: "RESTRICTED",
          reasonCode: "MANUAL_REVIEW",
          racePoint: async () => {
            await gate.promise;
          },
        });
      })();
      await waitForGovernanceLockHolder(`USER:${seller.id}`);
      const restorePromise = restore(seller.id, null, "NORMAL");
      gate.release();
      const [restrictResult] = await Promise.all([restrictAgain, restorePromise]);
      expect(restrictResult.changed).toBe(false); // 同状态重复 set = 幂等 no-op
      const final = await rawClient!.riskState.findFirst({
        where: { userId: seller.id, scopeKey: "GLOBAL" },
      });
      // restore 串行在 restrict no-op commit 之后 → 确定性恢复 NORMAL
      expect(final?.state).toBe("NORMAL");
      await restore(seller.id);
    });

    it(
      "RACE-6 Appeal GRANT vs capability attempt：GRANT 提交后同 gate 立即放行",
      async () => {
      const seller = await createFixtureUser("R6 卖家", campusA.id);
      const buyer = await createFixtureUser("R6 买家", campusA.id);
      const product = await rawClient!.product.create({
        data: {
          title: `R6 商品 ${randomUUID().slice(0, 6)}`,
          description: "RACE-6 集成商品",
          price: 10,
          condition: "NEW",
          locationText: "北门",
          categoryId: productCategoryA.id,
          campusId: campusA.id,
          sellerId: seller.id,
          status: "ACTIVE",
        },
      });
      trackedProductIds.push(product.id);

      await restrict(seller.id);
      const ea = await rawClient!.enforcementAction.findFirstOrThrow({
        where: { targetId: seller.id, type: "MARKETPLACE_RESTRICT" },
        orderBy: { enforcementSeq: "desc" },
      });
      const appeal = await rawClient!.appeal.create({
        data: {
          enforcementActionId: ea.id,
          status: "SUBMITTED",
          statement: "RACE-6 集成测试申诉陈述",
        },
      });

      const attempt = () =>
        createProductOrder({
          buyerId: buyer.id,
          productId: product.id,
          sellerId: seller.id,
          campusId: campusA.id,
        });

      // GRANT 前attempt denied
      const denied = await attempt().catch((e: unknown) => e);
      expect(gateTriple(denied)).toMatchObject({
        code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE",
      });

      // GRANT（真实 decideAppeal）先取完整 sorted {reviewer, seller} 锁并在
      // racePoint 挂起；poll 到 seller 的治理锁已被 GRANT 持有（确定性条件，
      // 非 timing guess）后启动的 attempt 被 advisory lock 串行化——绝不可能
      // 先于 GRANT 提交
      const grantGate = controllableGate();
      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      const grantPromise = decideAppeal({
        reviewerId: reviewer.id,
        appealId: appeal.id,
        decision: "GRANTED",
        racePoint: async () => {
          await grantGate.promise;
        },
      });
      await waitForGovernanceLockHolder(`USER:${seller.id}`);
      const attemptPromise = attempt().catch((e: unknown) => e);
      grantGate.release();
      const [grantResult, attemptResult] = await Promise.all([
        grantPromise,
        attemptPromise,
      ]);
      expect(grantResult.outcome).toBe("GRANTED");
      // attempt 在 GRANT 已持锁之后才启动 → 必然串行在 GRANT commit 之后
      //（xact 锁随提交释放）→ 恢复即时生效
      expect(attemptResult).not.toBeNull();
    });

    it(
      "RACE-7b/c/d 对手方限制 vs 服务预约/接跑腿/租赁下单（双方向代表性证明）",
      async () => {
      const { withTransaction } = await import("@/lib/prisma");
      const { createServiceOrderTx, claimErrandTx } = await import("@/lib/order-creation");
      const { createRentalOrderTx } = await import("@/lib/rental-order-machine");
      const buyer = await createFixtureUser("R7 买家", campusA.id);
      const claimer = await createFixtureUser("R7 接单者", campusA.id);
      const renter = await createFixtureUser("R7 租客", campusA.id);

      // service：provider restrict → deny
      await restrict(providerA.id);
      const serviceError = await withTransaction((tx: Prisma.TransactionClient) =>
        createServiceOrderTx(tx, {
          buyerId: buyer.id,
          service: {
            id: serviceA.id,
            price: "30.00",
            providerId: providerA.id,
            campusId: campusA.id,
          },
          meetingLocation: "图书馆",
          note: null,
        }),
      ).catch((e: unknown) => e);
      expect(gateTriple(serviceError)).toMatchObject({
        code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE",
      });
      await restore(providerA.id);

      // errand：publisher restrict → deny；publisher restore → claim 成功
      await restrict(publisherA.id);
      const errandError = await withTransaction((tx: Prisma.TransactionClient) =>
        claimErrandTx(tx, {
          errandId: errandA.id,
          publisherId: publisherA.id,
          claimerId: claimer.id,
          campusId: campusA.id,
          reward: new Prisma.Decimal(8),
        }),
      ).catch((e: unknown) => e);
      expect(gateTriple(errandError)).toMatchObject({
        code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE",
      });
      await restore(publisherA.id);
      const claimed = await withTransaction((tx: Prisma.TransactionClient) =>
        claimErrandTx(tx, {
          errandId: errandA.id,
          publisherId: publisherA.id,
          claimerId: claimer.id,
          campusId: campusA.id,
          reward: new Prisma.Decimal(8),
        }),
      );
      expect(claimed).not.toBeNull();
      // 复位任务供其它用例
      await rawClient!.order.deleteMany({ where: { errandTaskId: errandA.id } });
      await rawClient!.errandTask.update({
        where: { id: errandA.id },
        data: { status: "OPEN", accepterId: null },
      });

      // rental：owner restrict → deny；restore → 成功
      await restrict(ownerA.id);
      const rentalError = await withTransaction((tx: Prisma.TransactionClient) =>
        createRentalOrderTx(tx, {
          userId: renter.id,
          rentalListingId: rentalA.id,
          startTime: new Date(Date.now() + 72 * 3600_000),
          endTime: new Date(Date.now() + 96 * 3600_000),
          quantity: 1,
        }),
      ).catch((e: unknown) => e);
      expect(gateTriple(rentalError)).toMatchObject({
        code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE",
      });
      await restore(ownerA.id);
      const rentalOrder = await withTransaction((tx: Prisma.TransactionClient) =>
        createRentalOrderTx(tx, {
          userId: renter.id,
          rentalListingId: rentalA.id,
          startTime: new Date(Date.now() + 72 * 3600_000),
          endTime: new Date(Date.now() + 96 * 3600_000),
          quantity: 1,
        }),
      );
      expect(rentalOrder).toMatchObject({ orderId: expect.any(String) });
    });

    it(
      "RACE-8a/b/c/d listing 会话串行化（锁后重读、双方向、duplicate 收敛 EXISTING）",
      async () => {
      const { getOrCreateConversationSafe } = await import("@/lib/conversation-creation");
      const seller = await createFixtureUser("R8 卖家", campusA.id);
      const buyer = await createFixtureUser("R8 买家", campusA.id);
      const product = await rawClient!.product.create({
        data: {
          title: `R8 商品 ${randomUUID().slice(0, 6)}`,
          description: "RACE-8 集成商品",
          price: 10,
          condition: "NEW",
          locationText: "北门",
          categoryId: productCategoryA.id,
          campusId: campusA.id,
          sellerId: seller.id,
          status: "ACTIVE",
        },
      });
      trackedProductIds.push(product.id);

      const openConversation = (racePoint?: Prisma.TransactionClient extends never ? never : (tx: Prisma.TransactionClient) => Promise<void>) =>
        getOrCreateConversationSafe({
          bizType: "PRODUCT",
          bizKeyField: "productId",
          bizId: product.id,
          participantIds: [buyer.id, seller.id],
          initialData: {
            title: "R8 会话",
            initialMessageContent: "你好",
            notificationTitle: "通知",
            notificationContent: "内容",
            counterpartId: seller.id,
            currentUserId: buyer.id,
          },
          gate: {
            kind: "MARKETPLACE_LISTING",
            rereadResource: async (tx) => {
              const fresh = await tx.product.findFirst({
                where: { id: product.id, deletedAt: null },
                select: { campusId: true, sellerId: true },
              });
              if (!fresh) return null;
              return { campusId: fresh.campusId, participantIds: [buyer.id, fresh.sellerId] };
            },
            racePoint,
          },
        });

      // 方向 A：会话先持锁（racePoint 挂起；poll granted 锁为确定性条件）→
      // restriction 后启动（被串行化，必然晚于会话提交）→ 会话成立，restriction 随后生效
      {
        await restore(seller.id);
        const gate = controllableGate();
        const convPromise = openConversation(async () => {
          await gate.promise;
        });
        await waitForGovernanceLockHolder(`USER:${seller.id}`);
        const restrictPromise = restrict(seller.id);
        gate.release();
        const [conversation, restrictResult] = await Promise.all([
          convPromise,
          restrictPromise,
        ]);
        expect(conversation).not.toBeNull();
        expect(restrictResult.changed).toBe(true);
        await restore(seller.id);
        // 清理 dir A 产生的会话，使 dir B/C 回到"无既有会话"状态
        await rawClient!.message.deleteMany({
          where: { conversation: { productId: product.id } },
        });
        await rawClient!.conversation.deleteMany({
          where: { productId: product.id },
        });
      }

      // 方向 B：restriction 先提交 → 新会话以对手方 409 拒绝
      {
        await restrict(seller.id);
        const denied = await openConversation().catch((e: unknown) => e);
        expect(gateTriple(denied)).toMatchObject({
          code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE",
          status: 409,
        });
        await restore(seller.id);
      }

      // 方向 C：actor restriction 先提交 → 新会话以 actor 403 拒绝
      {
        await restrict(buyer.id);
        const denied = await openConversation().catch((e: unknown) => e);
        expect(gateTriple(denied)).toMatchObject({ code: "MARKETPLACE_RESTRICTED", status: 403 });
        await restore(buyer.id);
      }

      // RACE-8d：duplicate first-conversation：先到者持锁挂起（granted-poll）→
      // 后到者启动后被串行化 → 先到者提交 → 后到者锁后重读收敛为 EXISTING（不被误拒）
      {
        const gate = controllableGate();
        const first = openConversation(async () => {
          await gate.promise;
        });
        await waitForGovernanceLockHolder(`USER:${seller.id}`);
        const second = openConversation();
        gate.release();
        const [a, b] = await Promise.all([first, second]);
        expect(a).not.toBeNull();
        expect(b).not.toBeNull();
        expect((a as { id: string }).id).toBe((b as { id: string }).id);
        const rows = await rawClient!.conversation.findMany({
          where: { productId: product.id },
        });
        expect(rows).toHaveLength(1);
      }
    });

    it(
      "RACE-9a 对手方 erasure vs 新义务（obligation 先 = 提交 + erasure BLOCKED；erasure 先 = 统一拒绝）",
      async () => {
      const seller = await createFixtureUser("R9a 卖家", campusA.id);
      const buyer = await createFixtureUser("R9a 买家", campusA.id);
      const product = await rawClient!.product.create({
        data: {
          title: `R9a 商品 ${randomUUID().slice(0, 6)}`,
          description: "RACE-9a 集成商品",
          price: "10.00",
          condition: "NEW",
          locationText: "北门",
          categoryId: productCategoryA.id,
          campusId: campusA.id,
          sellerId: seller.id,
          status: "ACTIVE",
        },
      });
      trackedProductIds.push(product.id);

      const { eraseAccount } = await import("@/lib/privacy/account-erasure");

      // 方向 A：order 先持锁（racePoint 挂起；poll 确认 holder 后 erasure 才启动，
      // 故 erasure 必然串行在 order commit 之后）→ erasure 见 active obligation → BLOCKED
      {
        const gate = controllableGate();
        const orderPromise = createProductOrder({
          buyerId: buyer.id,
          productId: product.id,
          sellerId: seller.id,
          campusId: campusA.id,
          racePoint: async () => {
            await gate.promise;
          },
        });
        await waitForGovernanceLockHolder(`USER:${seller.id}`);
        const erasePromise = eraseAccount(seller.id).then(
          () => ({ blocked: false }),
          (error: unknown) => ({ blocked: true, error }),
        );
        gate.release();
        const order = await orderPromise;
        expect(order).not.toBeNull();
        const eraseOutcome = (await erasePromise) as unknown as { blocked: boolean };
        expect(eraseOutcome.blocked).toBe(true);
        // erasure 抛 ACTIVE_TRANSACTION_BLOCK 后自身事务整体回滚
      }

      // 方向 B（顺序确定性）：erasure 先完整提交（无 active obligation，成功注销）
      // → 之后的 order 在锁内校验看到已注销对手方 → 统一 409（与 CAP-46 同形）
      {
        const seller2 = await createFixtureUser("R9a 卖家B", campusA.id);
        const product2 = await rawClient!.product.create({
          data: {
            title: `R9a 商品B ${randomUUID().slice(0, 6)}`,
            description: "RACE-9a 集成商品B",
            price: "10.00",
            condition: "NEW",
            locationText: "北门",
            categoryId: productCategoryA.id,
            campusId: campusA.id,
            sellerId: seller2.id,
            status: "ACTIVE",
          },
        });
        trackedProductIds.push(product2.id);

        await eraseAccount(seller2.id);
        const denied = await createProductOrder({
          buyerId: buyer.id,
          productId: product2.id,
          sellerId: seller2.id,
          campusId: campusA.id,
        }).catch((e: unknown) => e);
        expect(gateTriple(denied)).toMatchObject({
          code: "MARKETPLACE_COUNTERPARTY_UNAVAILABLE",
          status: 409,
        });
      }
    });

    it(
      "RACE-9b actor suspension vs 新义务（双方向）",
      async () => {
      const seller = await createFixtureUser("R9b 卖家", campusA.id);
      const buyer = await createFixtureUser("R9b 买家", campusA.id);
      const product = await rawClient!.product.create({
        data: {
          title: `R9b 商品 ${randomUUID().slice(0, 6)}`,
          description: "RACE-9b 集成商品",
          price: "10.00",
          condition: "NEW",
          locationText: "北门",
          categoryId: productCategoryA.id,
          campusId: campusA.id,
          sellerId: seller.id,
          status: "ACTIVE",
        },
      });
      trackedProductIds.push(product.id);

      const { suspendAccount, reinstateAccount } = await import(
        "@/lib/enforcement/account-enforcement-service"
      );
      const reinstate = async () => {
        await reinstateAccount({
          actorId: enforcerGlobal.id,
          targetUserId: buyer.id,
          reasonCode: "FALSE_POSITIVE_CORRECTION",
        });
        await rawClient!.enforcementAction.deleteMany({ where: { targetId: buyer.id } });
      };

      // 方向 A：suspension 先持锁（racePoint 挂起；poll 确认 holder 后 order 才启动）
      // → suspension 先提交 → obligation actor 专用 403
      {
        const gate = controllableGate();
        const suspendPromise = suspendAccount({
          actorId: enforcerGlobal.id,
          targetUserId: buyer.id,
          reasonCode: "ACCOUNT_SECURITY",
          racePoint: async () => {
            await gate.promise;
          },
        });
        await waitForGovernanceLockHolder(`USER:${buyer.id}`);
        const deniedPromise = createProductOrder({
          buyerId: buyer.id,
          productId: product.id,
          sellerId: seller.id,
          campusId: campusA.id,
        }).catch((e: unknown) => e);
        gate.release();
        const [, denied] = await Promise.all([suspendPromise, deniedPromise]);
        expect(gateTriple(denied)).toMatchObject({
          code: "AUTH_ACCOUNT_INACTIVE",
          status: 403,
        });
        await reinstate();
      }

      // 方向 B：obligation 先持锁（racePoint 挂起；poll 确认 holder 后 suspension 才启动）
      // → obligation 先提交 → suspension 随后生效（合法 serialization）
      {
        const gate = controllableGate();
        const orderPromise = createProductOrder({
          buyerId: buyer.id,
          productId: product.id,
          sellerId: seller.id,
          campusId: campusA.id,
          racePoint: async () => {
            await gate.promise;
          },
        });
        await waitForGovernanceLockHolder(`USER:${buyer.id}`);
        const suspendPromise = suspendAccount({
          actorId: enforcerGlobal.id,
          targetUserId: buyer.id,
          reasonCode: "ACCOUNT_SECURITY",
        });
        gate.release();
        const order = await orderPromise;
        expect(order).not.toBeNull();
        await suspendPromise;
        const buyerRow = await rawClient!.user.findUniqueOrThrow({ where: { id: buyer.id } });
        expect(buyerRow.status).toBe("SUSPENDED");
        await reinstate();
      }
    });
  },
);
