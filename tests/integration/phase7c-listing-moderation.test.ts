import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// 治理 action 链路（requireUser / next/cache）在本文件仅被 Moderation flow
// 的 service 层间接依赖；service 直接以 moderatorId 调用，不 mock session。
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

// FR-02/FR-03 route-level 回归：真实 server action / page 模块需要 session
// seam。actionSession 控制 requireUser；viewerSession 控制 getActiveViewerId
// （null = 匿名公开请求）。
const sessionSeam = vi.hoisted(() => ({
  actionUser: { current: null as null | { id: string; email: string; name: string } },
  viewerId: { current: null as null | string },
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser: async () => {
    if (!sessionSeam.actionUser.current) {
      throw new Error("NO_SESSION");
    }
    return sessionSeam.actionUser.current;
  },
  getActiveViewerId: async () => sessionSeam.viewerId.current,
  getVerifiedSession: async () => {
    if (!sessionSeam.actionUser.current) {
      return { ok: false as const };
    }
    return {
      ok: true as const,
      user: { id: sessionSeam.actionUser.current.id, email: "", name: "", role: "STUDENT" },
    };
  },
}));

import { waitForAdvisoryLockWaiter } from "./helpers/lock-barrier";

/**
 * Phase 7C Listing Moderation Operations Surface 集成测试（真实 PostgreSQL）。
 *
 * 覆盖（Planning Repair 1/2 + 实现指令冻结）：
 *  - M01..M07：migration 合同（type↔FK CHECK / partial unique / Restrict /
 *    data-only role migration 重放收敛）
 *  - I01..I06：canonical takedown/restore 全链（锁序、幂等、ABA、freshness、
 *    erasure 阻断、审计）与 PUBLIC/OWNER/OBLIGATION 读面分类
 *  - C02A/B：order ↔ moderation 双向（真实 blocking 证明）
 *  - C04/C05/C10：errand claim / rental machine gate / conversation gate
 *  - C12A/B：role revoke ↔ moderation（USER:moderator subject lock 序列化）
 *  - C15：stale price（锁内 fresh 行 = 义务权威）
 *  - 零 sleep：barrier = racePoint/domainRacePoint/moderationRacePoint +
 *    pg_locks/pg_stat_activity waiter 轮询（与 6B/7B 同约定）
 */

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p7c-${randomUUID().slice(0, 8)}`;
const FIXTURE_PASSWORD_HASH = ["$2a$10$", "itfixtureitfixtureitfixtureitfixtureitfix"].join("");

const createdUserIds: string[] = [];
const createdCampusIds: string[] = [];
const createdRoleIds: string[] = [];
const createdProductIds: string[] = [];
const createdErrandIds: string[] = [];
const createdRentalIds: string[] = [];

let campusA: { id: string; name: string };
let campusB: { id: string; name: string };
let moderator: { id: string };
let campusModerator: { id: string };
let seller: { id: string };
let buyer: { id: string };
let claimer: { id: string };
let productFixture: { id: string; updatedAt: Date };

async function createFixtureUser(
  name: string,
  options: {
    status?: "ACTIVE" | "SUSPENDED";
    membership?: boolean;
  } = {},
) {
  const user = await rawClient!.user.create({
    data: {
      email: `${RUN_TAG}-${createdUserIds.length}-${name}@it.local`,
      name,
      passwordHash: FIXTURE_PASSWORD_HASH,
      schoolName: "集成测试大学",
      campusId: campusA.id,
      role: "STUDENT",
      status: options.status ?? "ACTIVE",
    },
  });
  createdUserIds.push(user.id);
  if (options.membership ?? true) {
    await rawClient!.campusMembership.create({
      data: { userId: user.id, campusId: campusA.id, status: "ACTIVE" },
    });
  }
  return user;
}

async function createProductFixture(input: {
  sellerId: string;
  price?: string;
  status?: "ACTIVE" | "RESERVED";
}) {
  const product = await rawClient!.product.create({
    data: {
      title: `${RUN_TAG}-集成测试商品`,
      description: "7C 集成测试商品描述",
      price: input.price ?? "100",
      status: input.status ?? "ACTIVE",
      condition: "NORMAL_USED",
      locationText: "东门集市场地",
      sellerId: input.sellerId,
      campusId: campusA.id,
      categoryId: (await ensureProductCategory()).id,
    },
  });
  createdProductIds.push(product.id);
  return product;
}

let productCategoryId: string | null = null;
async function ensureProductCategory() {
  if (productCategoryId) {
    return { id: productCategoryId };
  }
  const category = await rawClient!.productCategory.create({
    data: {
      name: `${RUN_TAG}-图书`,
      slug: `${RUN_TAG}-books`,
      isActive: true,
    },
  });
  productCategoryId = category.id;
  return category;
}

let errandCategoryId: string | null = null;
async function ensureErrandCategory() {
  if (errandCategoryId) {
    return { id: errandCategoryId };
  }
  const category = await rawClient!.errandCategory.create({
    data: { name: `${RUN_TAG}-代取`, slug: `${RUN_TAG}-errand-cat`, isActive: true },
  });
  errandCategoryId = category.id;
  return category;
}

let serviceCategoryId: string | null = null;
async function ensureServiceCategory() {
  if (serviceCategoryId) {
    return { id: serviceCategoryId };
  }
  const category = await rawClient!.serviceCategory.create({
    data: { name: `${RUN_TAG}-服务类`, slug: `${RUN_TAG}-svc-cat`, isActive: true },
  });
  serviceCategoryId = category.id;
  return category;
}

async function createErrandFixture(publisherId: string) {
  const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const errand = await rawClient!.errandTask.create({
    data: {
      title: `${RUN_TAG}-集成测试跑腿`,
      description: "7C 集成测试跑腿描述",
      reward: "20",
      status: "OPEN",
      publisherId,
      campusId: campusA.id,
      categoryId: (await ensureErrandCategory()).id,
      deadline,
      pickupLocation: "东门",
      deliveryLocation: "南门",
    },
  });
  createdErrandIds.push(errand.id);
  return errand;
}

async function createRentalFixture(ownerId: string) {
  const listing = await rawClient!.rentalListing.create({
    data: {
      title: `${RUN_TAG}-集成测试租赁`,
      description: "7C 集成测试租赁描述",
      price: "30",
      pricingUnit: "PER_DAY",
      depositAmount: "50",
      condition: "NORMAL_USED",
      status: "AVAILABLE",
      ownerId,
      campusId: campusA.id,
      categoryId: (await ensureRentalCategory()).id,
      totalQuantity: 1,
      availableQuantity: 1,
      minimumDuration: 1,
      maximumDuration: 30,
      pickupLocation: "北门",
      returnLocation: "北门",
    },
  });
  createdRentalIds.push(listing.id);
  return listing;
}

let rentalCategoryId: string | null = null;
async function ensureRentalCategory() {
  if (rentalCategoryId) {
    return { id: rentalCategoryId };
  }
  const category = await rawClient!.rentalCategory.create({
    data: { name: `${RUN_TAG}-设备`, slug: `${RUN_TAG}-rental-cat`, isActive: true },
  });
  rentalCategoryId = category.id;
  return category;
}

/** 行锁等待者证明：目标事务的 FOR UPDATE 语句真实处于 Lock 等待。 */
async function waitForRowLockWaiter(
  client: PrismaClient,
  tableMarker: string,
  options: { timeoutMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await client.$queryRaw<{ pid: number }[]>`
      SELECT a.pid
      FROM pg_stat_activity a
      WHERE a.wait_event_type = 'Lock'
        AND a.query ILIKE ${`%${tableMarker}%`}
        AND a.query ILIKE '%FOR UPDATE%'
        AND a.pid <> pg_backend_pid()`;
    if (rows.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`row-lock barrier 超时：未观察到对 ${tableMarker} 的 FOR UPDATE 等待者`);
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T | void>((res) => {
    resolve = res as (value: T | PromiseLike<T>) => void;
  });
  return { promise, resolve };
}

const prismaModule = vi.hoisted(() => ({ __mocked: false }));

vi.mock("@/lib/prisma", async (importOriginal) => {
  // 集成环境：@/lib/prisma 的 DATABASE_URL 即测试库（CI 合同），保持真实实现
  return importOriginal<typeof import("@/lib/prisma")>();
});

import {
  moderateProductListing,
  moderateServiceListing,
  moderateErrandListing,
  moderateRentalListing,
  restoreListingByModerationIdentity,
} from "@/lib/moderation/listing-moderation-service";
import {
  browseListings,
  loadActiveModerations,
  loadReportFlaggedListings,
  rereadListingForConversation,
  hasActiveModerationForPublicSurface,
} from "@/lib/moderation/listing-moderation-query";
import {
  createProductOrderTx,
  claimErrandTx,
} from "@/lib/order-creation";
import { createServiceOrder, createProductOrder } from "@/actions/order";
import {
  decodeListingModerationCursor,
  encodeListingModerationCursor,
} from "@/validators/governance-listing";
import { createRentalOrderTx } from "@/lib/rental-order-machine";
import { eraseAccount } from "@/lib/privacy/account-erasure";

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 7C listing moderation 集成测试（真实 PostgreSQL）",
  () => {
    beforeAll(async () => {
      const contentModeratorRole = await rawClient!.role.findUnique({
        where: { key: "CAMPUS_CONTENT_MODERATOR" },
      });
      if (!contentModeratorRole) {
        throw new Error("CAMPUS_CONTENT_MODERATOR 缺失：请先执行 prisma migrate deploy");
      }

      campusA = await rawClient!.campus.create({
        data: {
          name: `${RUN_TAG}-主校区`,
          slug: `${RUN_TAG}-main`,
          schoolName: "集成测试大学",
        },
      });
      createdCampusIds.push(campusA.id);
      campusB = await rawClient!.campus.create({
        data: {
          name: `${RUN_TAG}-第二校区`,
          slug: `${RUN_TAG}-second`,
          schoolName: "集成测试大学",
        },
      });
      createdCampusIds.push(campusB.id);

      moderator = await createFixtureUser("全局内容审核员", { membership: false });
      campusModerator = await createFixtureUser("校区内容审核员");
      seller = await createFixtureUser("卖家");
      buyer = await createFixtureUser("买家");
      claimer = await createFixtureUser("接单者");

      // GLOBAL listing.moderate + rbac.role.assign（后者供 C12 revoke 用例）
      await (async () => {
        const role = await rawClient!.role.create({
          data: {
            key: `${RUN_TAG}-GLOBAL_MOD`,
            name: "GLOBAL_MOD",
            scope: "GLOBAL",
            isSystem: false,
            rolePermissions: {
              create: [
                { permission: { connect: { key: "listing.moderate" } } },
                { permission: { connect: { key: "rbac.role.assign" } } },
              ],
            },
          },
        });
        createdRoleIds.push(role.id);
        await rawClient!.userRoleAssignment.create({
          data: { userId: moderator.id, roleId: role.id, scopeKey: "GLOBAL" },
        });
      })();

      // CAMPUS listing.moderate（系统角色行 + assignment）
      await rawClient!.userRoleAssignment.create({
        data: {
          userId: campusModerator.id,
          roleId: contentModeratorRole.id,
          campusId: campusA.id,
          scopeKey: `CAMPUS:${campusA.id}`,
        },
      });

      productFixture = await createProductFixture({ sellerId: seller.id });
    }, 30_000);

    afterAll(async () => {
      // fixture 清理：治理行 → assignment → listing → user（Restraint FK 要求
      // 先删 provenance 再删 referent；软删/硬删皆可）
      if (!rawClient) return;
      await rawClient.listingModeration.deleteMany({
        where: { OR: createdProductIds.map((id) => ({ productId: id })) },
      });
      await rawClient.listingModeration.deleteMany({
        where: { OR: createdUserIds.map((id) => ({ moderatorId: id })) },
      });
      await rawClient.listingModeration.deleteMany({
        where: { OR: createdUserIds.map((id) => ({ resolvedById: id })) },
      });
      for (const id of createdErrandIds) {
        await rawClient.listingModeration.deleteMany({ where: { errandTaskId: id } });
      }
      await rawClient.serviceListing.deleteMany({
        where: { providerId: { in: createdUserIds } },
      });
      for (const id of createdRentalIds) {
        await rawClient.listingModeration.deleteMany({ where: { rentalListingId: id } });
      }
      await rawClient.userRoleAssignment.deleteMany({ where: { userId: { in: createdUserIds } } });
      await rawClient.role.deleteMany({ where: { id: { in: createdRoleIds } } });
      await rawClient.order.deleteMany({
        where: { OR: createdProductIds.map((id) => ({ productId: id })) },
      });
      await rawClient.order.deleteMany({
        where: {
          OR: [
            { buyerId: { in: createdUserIds } },
            { sellerId: { in: createdUserIds } },
          ],
        },
      });
      await rawClient.rentalOrder.deleteMany({
        where: {
          OR: [
            { renterId: { in: createdUserIds } },
            { ownerId: { in: createdUserIds } },
          ],
        },
      });
      await rawClient.product.deleteMany({ where: { id: { in: createdProductIds } } });
      await rawClient.errandTask.deleteMany({ where: { id: { in: createdErrandIds } } });
      await rawClient.rentalListing.deleteMany({ where: { id: { in: createdRentalIds } } });
      await rawClient.campusMembership.deleteMany({ where: { userId: { in: createdUserIds } } });
      await rawClient.report.deleteMany({ where: { reporterId: { in: createdUserIds } } });
      await rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } });
      await rawClient.campus.deleteMany({ where: { id: { in: createdCampusIds } } });
      if (productCategoryId) {
        await rawClient.productCategory.deleteMany({ where: { id: productCategoryId } });
      }
      if (errandCategoryId) {
        await rawClient.errandCategory.deleteMany({ where: { id: errandCategoryId } });
      }
      if (rentalCategoryId) {
        await rawClient.rentalCategory.deleteMany({ where: { id: rentalCategoryId } });
      }
      await rawClient.$disconnect();
    }, 30_000);

    // ── M：migration 合同 ────────────────────────────────────────────────

    it("M01：wrong targetType/FK 配对 → DB CHECK 拒绝（23514）", async () => {
      await expect(
        rawClient!.$executeRawUnsafe(
          `INSERT INTO "ListingModeration"
           ("id","targetType","productId","campusId","observedStatus","reasonCode","moderatorId")
           VALUES ('${RUN_TAG}-m01', 'PRODUCT', NULL, '${campusA.id}', 'ACTIVE', 'OTHER', '${moderator.id}')`,
        ),
      ).rejects.toMatchObject({ code: "P2010", message: expect.stringContaining("23514") });
    }, 15_000);

    it("M02/M03：零 target FK / 双 target FK → DB CHECK 拒绝", async () => {
      await expect(
        rawClient!.$executeRawUnsafe(
          `INSERT INTO "ListingModeration"
           ("id","targetType","campusId","observedStatus","reasonCode","moderatorId")
           VALUES ('${RUN_TAG}-m02', 'PRODUCT', '${campusA.id}', 'ACTIVE', 'OTHER', '${moderator.id}')`,
        ),
      ).rejects.toMatchObject({ code: "P2010" });

      await expect(
        rawClient!.$executeRawUnsafe(
          `INSERT INTO "ListingModeration"
           ("id","targetType","productId","serviceListingId","campusId","observedStatus","reasonCode","moderatorId")
           VALUES ('${RUN_TAG}-m03', 'PRODUCT', '${productFixture.id}', '${RUN_TAG}-m03-fake-service', '${campusA.id}', 'ACTIVE', 'OTHER', '${moderator.id}')`,
        ),
      ).rejects.toMatchObject({ code: "P2010", message: expect.stringContaining("23514") });
    }, 15_000);

    it("M04/M05：同一 listing 重复活跃行 → partial unique 拒绝；resolved 历史 + 新活跃行 → 允许", async () => {
      const m1 = await rawClient!.listingModeration.create({
        data: {
          targetType: "PRODUCT",
          productId: productFixture.id,
          campusId: campusA.id,
          observedStatus: "ACTIVE",
          reasonCode: "OTHER",
          moderatorId: moderator.id,
        },
      });

      await expect(
        rawClient!.listingModeration.create({
          data: {
            targetType: "PRODUCT",
            productId: productFixture.id,
            campusId: campusA.id,
            observedStatus: "ACTIVE",
            reasonCode: "OTHER",
            moderatorId: moderator.id,
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });

      // resolve m1 后允许新活跃行（历史保留、不阻断再次 takedown）
      await rawClient!.listingModeration.update({
        where: { id: m1.id },
        data: { resolvedAt: new Date(), resolvedById: moderator.id },
      });
      const m2 = await rawClient!.listingModeration.create({
        data: {
          targetType: "PRODUCT",
          productId: productFixture.id,
          campusId: campusA.id,
          observedStatus: "ACTIVE",
          reasonCode: "OTHER",
          moderatorId: moderator.id,
        },
      });
      expect(m2.id).not.toBe(m1.id);

      await rawClient!.listingModeration.delete({ where: { id: m2.id } });
      await rawClient!.listingModeration.delete({ where: { id: m1.id } });
    }, 15_000);

    it("M06：hard-delete referent → Restrict 拒绝（23503；governance provenance 不可静默消失）", async () => {
      const product = await createProductFixture({ sellerId: seller.id });
      await rawClient!.listingModeration.create({
        data: {
          targetType: "PRODUCT",
          productId: product.id,
          campusId: campusA.id,
          observedStatus: "ACTIVE",
          reasonCode: "OTHER",
          moderatorId: moderator.id,
        },
      });

      await expect(
        rawClient!.$executeRawUnsafe(`DELETE FROM "Product" WHERE id = '${product.id}'`),
      ).rejects.toMatchObject({ code: "P2010" });

      await rawClient!.listingModeration.deleteMany({ where: { productId: product.id } });
    }, 15_000);

    it("M07：data-only role migration 重放收敛（幂等 + 零 assignment 变更）", async () => {
      const migrationPath = path.join(
        process.cwd(),
        "prisma",
        "migrations",
        "20260913150000_phase7c_campus_content_moderator_role",
        "migration.sql",
      );
      const sql = readFileSync(migrationPath, "utf8");
      // 该文件是显式 BEGIN/COMMIT 包裹的简单语句序列：按语句边界拆分重放
      const statements = sql
        .split("BEGIN;")
        .join("")
        .split("COMMIT;")
        .join("")
        .split(";")
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);

      const assignmentsBefore = await rawClient!.userRoleAssignment.count({
        where: { role: { key: "CAMPUS_CONTENT_MODERATOR" } },
      });

      // 重放两次（幂等收敛合同）
      for (let round = 0; round < 2; round += 1) {
        for (const statement of statements) {
          await rawClient!.$executeRawUnsafe(statement);
        }
      }

      const role = await rawClient!.role.findUnique({
        where: { key: "CAMPUS_CONTENT_MODERATOR" },
        include: { rolePermissions: { include: { permission: true } } },
      });
      expect(role?.scope).toBe("CAMPUS");
      expect(role?.isSystem).toBe(true);
      expect(role?.rolePermissions.map((entry) => entry.permission.key)).toEqual([
        "listing.moderate",
      ]);
      const assignmentsAfter = await rawClient!.userRoleAssignment.count({
        where: { role: { key: "CAMPUS_CONTENT_MODERATOR" } },
      });
      expect(assignmentsAfter).toBe(assignmentsBefore);
    }, 30_000);

    // ── I：canonical 治理流 + 读面分类 ───────────────────────────────────

    it("I01：campus moderator takedown（真实锁链）→ 活跃行 + 审计；GLOBAL moderator 同链放行", async () => {
      const product = await createProductFixture({ sellerId: seller.id });

      const campusResult = await moderateProductListing({
        moderatorId: campusModerator.id,
        listingId: product.id,
        reasonCode: "PROHIBITED_ITEM",
        note: "集成测试处置",
      });
      expect(campusResult.outcome).toBe("TAKEDOWN");

      const audit = await rawClient!.adminLog.findFirst({
        where: { action: "LISTING_TAKEDOWN", targetId: product.id },
      });
      expect(audit?.campusId).toBe(campusA.id);
      expect(audit?.metadata).toMatchObject({
        listingType: "PRODUCT",
        moderationId: campusResult.moderationId,
      });

      // 活跃行 observedStatus/campus 固化
      const row = await rawClient!.listingModeration.findUnique({
        where: { id: campusResult.moderationId },
      });
      expect(row).toMatchObject({
        targetType: "PRODUCT",
        productId: product.id,
        campusId: campusA.id,
        observedStatus: "ACTIVE",
        resolvedAt: null,
      });

      // 重复 takedown 幂等（partial unique + 服务幂等收敛）
      const again = await moderateProductListing({
        moderatorId: moderator.id,
        listingId: product.id,
        reasonCode: "OTHER",
      });
      expect(again).toEqual({ outcome: "ALREADY_MODERATED", moderationId: campusResult.moderationId });
    }, 20_000);

    it("I02：PUBLIC 谓词排除被治理 listing；OWNER 面不过滤；restore 后恢复", async () => {
      const product = await createProductFixture({ sellerId: seller.id });
      const activeFilter = { moderations: { none: { resolvedAt: null } } };

      expect(
        await rawClient!.product.count({
          where: { id: product.id, deletedAt: null, ...activeFilter },
        }),
      ).toBe(1);

      await moderateProductListing({
        moderatorId: moderator.id,
        listingId: product.id,
        reasonCode: "OTHER",
      });

      expect(
        await rawClient!.product.count({
          where: { id: product.id, deletedAt: null, ...activeFilter },
        }),
      ).toBe(0);
      // OWNER 面不过滤（owner 仍能发现自己被治理的 listing）
      expect(
        await rawClient!.product.count({ where: { id: product.id, sellerId: seller.id } }),
      ).toBe(1);

      // restore（identity 合同入口）
      const history = await rawClient!.listingModeration.findFirst({
        where: { productId: product.id, resolvedAt: null },
      });
      const restored = await restoreListingByModerationIdentity({
        moderatorId: moderator.id,
        moderationId: history!.id,
        expectedListingUpdatedAt: product.updatedAt,
      });
      expect(restored.outcome).toBe("RESTORED");

      expect(
        await rawClient!.product.count({
          where: { id: product.id, deletedAt: null, ...activeFilter },
        }),
      ).toBe(1);
    }, 20_000);

    it("I03：治理队列读模型（reports tab 只读 / active tab / browse tab；campus 单列 IN）", async () => {
      const product = await createProductFixture({ sellerId: seller.id });
      const reporter = await createFixtureUser("举报人");
      await rawClient!.report.create({
        data: {
          targetType: "PRODUCT",
          reason: "BANNED_ITEM",
          status: "OPEN",
          reporterId: reporter.id,
          productId: product.id,
        },
      });

      const access = { global: false, campusIds: [campusA.id] };
      const flaggedPage = await loadReportFlaggedListings({
        access,
        targetType: "PRODUCT",
        cursor: null,
        limit: 25,
      });
      const flaggedRow = flaggedPage.items.find((item) => item.listingId === product.id);
      expect(flaggedRow).toBeDefined();
      expect(flaggedRow?.openReportReasons).toContain("BANNED_ITEM");

      await moderateProductListing({
        moderatorId: moderator.id,
        listingId: product.id,
        reasonCode: "SPAM_ADVERTISEMENT",
      });
      const activePage = await loadActiveModerations({ access, cursor: null, limit: 25 });
      const activeRow = activePage.items.find(
        (item) => item.listingId === product.id && item.targetType === "PRODUCT",
      );
      expect(activeRow?.activeModeration).toMatchObject({ reasonCode: "SPAM_ADVERTISEMENT" });

      const browsedPage = await browseListings({
        access,
        targetType: "PRODUCT",
        cursor: null,
        limit: 50,
      });
      // browse tab 不过滤治理态（GOVERNANCE 读面）
      expect(browsedPage.items.some((item) => item.listingId === product.id)).toBe(true);
    }, 20_000);

    // ── C：确定性并发（真 PG；零 sleep）──────────────────────────────────

    it("C02A：moderation 先提交 → order 行锁后复查观察到 moderation → 拒绝（无新义务）", async () => {
      const product = await createProductFixture({ sellerId: seller.id });

      // buyer 在 guard racePoint 暂停（行锁前）→ moderation 完整提交 → buyer 恢复
      const buyerPaused = deferred();
      let resumeBuyer!: () => void;
      const resumePromise = new Promise<void>((resolve) => {
        resumeBuyer = resolve;
      });

      const orderPromise = rawClient!
        .$transaction((tx: unknown) =>
          createProductOrderTx(
            tx as Parameters<typeof createProductOrderTx>[0],
            {
              buyerId: buyer.id,
              product: {
                id: product.id,
                price: product.price.toString(),
                sellerId: seller.id,
                campusId: campusA.id,
              },
              meetingLocation: "校门口",
              note: null,
            },
            async () => {
              await buyerPaused.resolve();
              await resumePromise;
            },
          ),
        )
        .then((result: unknown) => result);

      await buyerPaused.promise;
      const takedown = await moderateProductListing({
        moderatorId: moderator.id,
        listingId: product.id,
        reasonCode: "OTHER",
      });
      expect(takedown.outcome).toBe("TAKEDOWN");
      resumeBuyer();

      const order = (await orderPromise) as unknown;
      expect(order).toBeNull();
      const orders = await rawClient!.order.count({ where: { productId: product.id } });
      expect(orders).toBe(0);
    }, 25_000);

    it("C02B：order 先获行锁 → moderation 真实等待（waiter 证明）→ order 提交 → moderation 生效 → 既有义务保存", async () => {
      const product = await createProductFixture({ sellerId: seller.id });
      const orderHoldingRowLock = deferred();
      const releaseOrder = deferred();

      const orderPromise = rawClient!
        .$transaction((tx: unknown) =>
          createProductOrderTx(
            tx as Parameters<typeof createProductOrderTx>[0],
            {
              buyerId: buyer.id,
              product: {
                id: product.id,
                price: product.price.toString(),
                sellerId: seller.id,
                campusId: campusA.id,
              },
              meetingLocation: "校门口",
              note: null,
            },
            undefined,
            async () => {
              // domainRacePoint：已持 Product 行锁 + 复查通过，暂停
              orderHoldingRowLock.resolve();
              await releaseOrder.promise;
            },
          ),
        )
        .catch(() => "TX_ABORTED");

      await orderHoldingRowLock.promise;
      const moderationPromise = moderateProductListing({
        moderatorId: moderator.id,
        listingId: product.id,
        reasonCode: "OTHER",
      }).catch(() => "MODERATION_ABORTED");

      // 真实 blocking 证明：moderation 的 FOR UPDATE 在 Product 行上等待
      await waitForRowLockWaiter(rawClient!, "Product");

      // 放行 order → 提交义务 → moderation 获锁生效
      releaseOrder.resolve();
      const order = (await orderPromise) as unknown;
      expect(order).not.toBe("TX_ABORTED");
      expect(order).not.toBeNull();

      const takedown = (await moderationPromise) as {
        outcome: string;
        moderationId: string;
      };
      expect(takedown.outcome).toBe("TAKEDOWN");

      // 既有义务保存：订单存在、listing 业务状态保持 RESERVED（OPTION B）
      const orders = await rawClient!.order.count({ where: { productId: product.id } });
      expect(orders).toBe(1);
      const stored = await rawClient!.product.findUnique({ where: { id: product.id } });
      expect(stored?.status).toBe("RESERVED");
    }, 30_000);

    it("C04：errand claim 在活跃 moderation 下拒绝（gate）", async () => {
      const errand = await createErrandFixture(seller.id);
      await moderateErrandListing({
        moderatorId: moderator.id,
        listingId: errand.id,
        reasonCode: "OTHER",
      });

      const result = await rawClient!.$transaction((tx: unknown) =>
        claimErrandTx(
          tx as Parameters<typeof claimErrandTx>[0],
          {
            errandId: errand.id,
            publisherId: seller.id,
            claimerId: claimer.id,
            campusId: campusA.id,
            reward: errand.reward,
          },
        ),
      );
      expect(result).toBeNull();
      const stillOpen = await rawClient!.errandTask.findUnique({ where: { id: errand.id } });
      expect(stillOpen?.status).toBe("OPEN");
    }, 20_000);

    it("C04-sym：errand claim 提交后 moderation 执行 → CLAIMED 义务保存", async () => {
      const errand = await createErrandFixture(seller.id);
      const claim = await rawClient!.$transaction((tx: unknown) =>
        claimErrandTx(
          tx as Parameters<typeof claimErrandTx>[0],
          {
            errandId: errand.id,
            publisherId: seller.id,
            claimerId: claimer.id,
            campusId: campusA.id,
            reward: errand.reward,
          },
        ),
      );
      expect(claim).not.toBeNull();

      const takedown = await moderateErrandListing({
        moderatorId: moderator.id,
        listingId: errand.id,
        reasonCode: "OTHER",
      });
      expect(takedown.outcome).toBe("TAKEDOWN");

      const task = await rawClient!.errandTask.findUnique({ where: { id: errand.id } });
      expect(task?.status).toBe("CLAIMED");
      expect(task?.accepterId).toBe(claimer.id);
    }, 20_000);

    it("C05：rental machine 在活跃 moderation 下拒绝（gate；业务状态零变更）", async () => {
      const listing = await createRentalFixture(seller.id);
      await moderateRentalListing({
        moderatorId: moderator.id,
        listingId: listing.id,
        reasonCode: "OTHER",
      });

      const result = await rawClient!.$transaction((tx: unknown) =>
        createRentalOrderTx(
          tx as Parameters<typeof createRentalOrderTx>[0],
          {
            userId: buyer.id,
            rentalListingId: listing.id,
            startTime: new Date(Date.now() + 3600_000),
            endTime: new Date(Date.now() + 2 * 3600_000),
            quantity: 1,
          },
        ),
      );
      expect(result).toEqual({ error: "出租物品当前不可预约" });
      const stored = await rawClient!.rentalListing.findUnique({ where: { id: listing.id } });
      expect(stored?.status).toBe("AVAILABLE");
    }, 20_000);

    it("C10：conversation rereader 在活跃 moderation 下返回 null（新会话拒绝；既有会话路径不经此函数）", async () => {
      const product = await createProductFixture({ sellerId: seller.id });
      await rawClient!.$transaction((tx: unknown) =>
        rereadListingForConversation(
          tx as Parameters<typeof rereadListingForConversation>[0],
          "PRODUCT",
          product.id,
        ),
      ).then((snapshot: unknown) => expect(snapshot).not.toBeNull());

      await moderateProductListing({
        moderatorId: moderator.id,
        listingId: product.id,
        reasonCode: "OTHER",
      });

      await rawClient!
        .$transaction((tx: unknown) =>
          rereadListingForConversation(
            tx as Parameters<typeof rereadListingForConversation>[0],
            "PRODUCT",
            product.id,
          ),
        )
        .then((snapshot: unknown) => expect(snapshot).toBeNull());
    }, 20_000);

    it("C12A：role revoke 先提交 → moderation 锁内重载观察到撤销 → AUTH_PERMISSION_DENIED 零写", async () => {
      const tempModerator = await createFixtureUser("待撤销审核员", { membership: false });
      const role = await rawClient!.role.create({
        data: {
          key: `${RUN_TAG}-TEMP_MOD`,
          name: "TEMP_MOD",
          scope: "GLOBAL",
          isSystem: false,
          rolePermissions: {
            create: [{ permission: { connect: { key: "listing.moderate" } } }],
          },
        },
      });
      createdRoleIds.push(role.id);
      const assignment = await rawClient!.userRoleAssignment.create({
        data: { userId: tempModerator.id, roleId: role.id, scopeKey: "GLOBAL" },
      });

      // revoke 先提交（canonical revokeRole）
      const { revokeRole } = await import("@/lib/rbac/assignment-service");
      await revokeRole({
        actorId: moderator.id,
        targetUserId: tempModerator.id,
        roleKey: role.key,
        campusId: null,
        expectedAssignmentId: assignment.id,
      });

      await expect(
        moderateProductListing({
          moderatorId: tempModerator.id,
          listingId: productFixture.id,
          reasonCode: "OTHER",
        }),
      ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });

      const audits = await rawClient!.adminLog.count({
        where: { action: "LISTING_TAKEDOWN", adminId: tempModerator.id },
      });
      expect(audits).toBe(0);
    }, 20_000);

    it("C12B：moderation 持 USER:moderator 锁 → revoke 真实阻塞（advisory waiter 证明）→ moderation 合法提交", async () => {
      const tempModerator = await createFixtureUser("持锁审核员", { membership: false });
      const role = await rawClient!.role.create({
        data: {
          key: `${RUN_TAG}-LOCKHOLD_MOD`,
          name: "LOCKHOLD_MOD",
          scope: "GLOBAL",
          isSystem: false,
          rolePermissions: {
            create: [{ permission: { connect: { key: "listing.moderate" } } }],
          },
        },
      });
      createdRoleIds.push(role.id);
      const assignment = await rawClient!.userRoleAssignment.create({
        data: { userId: tempModerator.id, roleId: role.id, scopeKey: "GLOBAL" },
      });
      const product = await createProductFixture({ sellerId: seller.id });

      const moderationDone = deferred();
      const releaseModeration = deferred();
      const moderationPromise = moderateProductListing({
        moderatorId: tempModerator.id,
        listingId: product.id,
        reasonCode: "OTHER",
        racePoint: async () => {
          moderationDone.resolve();
          await releaseModeration.promise;
        },
      }).then((result) => result, () => "ABORTED");

      await moderationDone.promise;
      // moderation 持 USER:tempModerator 锁中；revoke 需要同一把锁 → 阻塞
      const { revokeRole } = await import("@/lib/rbac/assignment-service");
      const revokePromise = revokeRole({
        actorId: moderator.id,
        targetUserId: tempModerator.id,
        roleKey: role.key,
        campusId: null,
        expectedAssignmentId: assignment.id,
      }).then(() => "REVOKED" as const, () => "REVOKED_FAILED" as const);

      // 真实 blocking 证明：USER 键上存在未授予 advisory 等待
      await waitForAdvisoryLockWaiter(rawClient!, [`USER:${tempModerator.id}`]);

      releaseModeration.resolve();
      const moderationResult = await moderationPromise;
      expect(moderationResult).toMatchObject({ outcome: "TAKEDOWN" });
      expect(await revokePromise).toBe("REVOKED");
    }, 25_000);

    it("C15：stale price——锁内 fresh 行是 Order.amount 权威（outer snapshot 100 → fresh 80）", async () => {
      const product = await createProductFixture({ sellerId: seller.id, price: "100" });
      const buyerAtGuard = deferred();
      const releaseBuyer = deferred();

      const orderPromise = rawClient!
        .$transaction((tx: unknown) =>
          createProductOrderTx(
            tx as Parameters<typeof createProductOrderTx>[0],
            {
              buyerId: buyer.id,
              // outer snapshot：price=100（discovery only）
              product: {
                id: product.id,
                price: "100",
                sellerId: seller.id,
                campusId: campusA.id,
              },
              meetingLocation: "校门口",
              note: null,
            },
            async () => {
              // guard racePoint：participant 锁后、listing 行锁前
              buyerAtGuard.resolve();
              await releaseBuyer.promise;
            },
          ),
        )
        .catch(() => "TX_ABORTED");

      // buyer 停在 guard racePoint（尚未取行锁）→ owner 提交新价 80 → 放行
      await buyerAtGuard.promise;
      await rawClient!.product.update({ where: { id: product.id }, data: { price: "80" } });
      releaseBuyer.resolve();

      const order = (await orderPromise) as { amount: { toString(): string } } | null;
      expect(order).not.toBeNull();
      // 权威 = 锁内 fresh.price（80），非 outer snapshot（100）
      expect(order!.amount.toString()).toBe("80");
    }, 30_000);

    it("C15b：order amount = fresh.price（80），非 outer snapshot（100）", async () => {
      const product = await createProductFixture({ sellerId: seller.id, price: "100" });
      // owner 先改价 80（在 order 事务开始前提交）
      await rawClient!.product.update({ where: { id: product.id }, data: { price: "80" } });

      const order = await rawClient!.$transaction((tx: unknown) =>
        createProductOrderTx(
          tx as Parameters<typeof createProductOrderTx>[0],
          {
            buyerId: buyer.id,
            product: { id: product.id, price: "100", sellerId: seller.id, campusId: campusA.id },
            meetingLocation: "校门口",
            note: null,
          },
        ),
      );
      expect(order).not.toBeNull();
      expect((order as { amount: { toString(): string } }).amount.toString()).toBe("80");
    }, 20_000);

    it("C18+C19：restore ABA（M1 已 resolve → stale M1 提交 STALE）与 freshness（updatedAt 失配 STALE / 匹配成功）", async () => {
      const product = await createProductFixture({ sellerId: seller.id });

      // M1
      const m1 = await moderateProductListing({
        moderatorId: moderator.id,
        listingId: product.id,
        reasonCode: "OTHER",
      });
      const updatedAtBeforeEdit = (
        await rawClient!.product.findUnique({ where: { id: product.id } })
      )!.updatedAt;

      // owner 编辑隐藏 listing → updatedAt 推进（fail-closed token）
      await rawClient!.product.update({
        where: { id: product.id },
        data: { description: "owner 隐藏期编辑" },
      });
      const updatedAtAfterEdit = (
        await rawClient!.product.findUnique({ where: { id: product.id } })
      )!.updatedAt;

      // C19：M1 active + expected=编辑前 token → STALE
      await expect(
        restoreListingByModerationIdentity({
          moderatorId: moderator.id,
          moderationId: m1.moderationId,
          expectedListingUpdatedAt: updatedAtBeforeEdit,
        }),
      ).rejects.toMatchObject({ code: "STALE_MODERATION_REVIEW" });

      // 正常 restore M1（expected=编辑后 token）
      await restoreListingByModerationIdentity({
        moderatorId: moderator.id,
        moderationId: m1.moderationId,
        expectedListingUpdatedAt: updatedAtAfterEdit,
      });

      // M2：再次 takedown
      const m2 = await moderateProductListing({
        moderatorId: moderator.id,
        listingId: product.id,
        reasonCode: "OTHER",
      });
      expect(m2.moderationId).not.toBe(m1.moderationId);

      // C18：stale M1 提交（现行活跃行是 M2）→ STALE；M2 保持 unresolved
      await expect(
        restoreListingByModerationIdentity({
          moderatorId: moderator.id,
          moderationId: m1.moderationId,
          expectedListingUpdatedAt: updatedAtAfterEdit,
        }),
      ).rejects.toMatchObject({ code: "STALE_MODERATION_REVIEW" });

      const m2Row = await rawClient!.listingModeration.findUnique({
        where: { id: m2.moderationId },
      });
      expect(m2Row?.resolvedAt).toBeNull();
      const restoredAudits = await rawClient!.adminLog.count({
        where: { action: "LISTING_RESTORED", metadata: { path: ["moderationId"], equals: m1.moderationId } },
      });
      expect(restoredAudits).toBe(1); // 仅合法 restore 一次
    }, 25_000);

    it("I-ERASE-RESTORE：owner 注销后 exact M1 restore → NOT_RESTORABLE；M1 保持 active", async () => {
      const owner = await createFixtureUser("将注销卖家");
      const product = await createProductFixture({ sellerId: owner.id, price: "50" });
      const m1 = await moderateProductListing({
        moderatorId: moderator.id,
        listingId: product.id,
        reasonCode: "OTHER",
      });

      // SUSPENDED/RESTRICTED owner 不是 restore blocker（v1 政策保留）：
      // SUSPENDED 场景下 restore 成功——先验证
      await rawClient!.user.update({ where: { id: owner.id }, data: { status: "SUSPENDED" } });
      const suspendedRestore = await restoreListingByModerationIdentity({
        moderatorId: moderator.id,
        moderationId: m1.moderationId,
        expectedListingUpdatedAt: product.updatedAt,
      });
      expect(suspendedRestore.outcome).toBe("RESTORED");

      // 重新 takedown 后执行真实 erasure → restore 阻断
      // （erasure 的 status 翻转会推进 listing.updatedAt → 必须 erasure 后
      //   重新取 token，才能抵达 owner-state 检查——R2 冻结顺序：
      //   token 校验先于 owner 可恢复性）
      const m2 = await moderateProductListing({
        moderatorId: moderator.id,
        listingId: product.id,
        reasonCode: "OTHER",
      });
      await eraseAccount(owner.id);
      const updatedAtAfterErasure = (
        await rawClient!.product.findUnique({ where: { id: product.id } })
      )!.updatedAt;
      await expect(
        restoreListingByModerationIdentity({
          moderatorId: moderator.id,
          moderationId: m2.moderationId,
          expectedListingUpdatedAt: updatedAtAfterErasure,
        }),
      ).rejects.toMatchObject({ code: "RESTORE_NOT_RESTORABLE" });

      const stillActive = await rawClient!.listingModeration.findUnique({
        where: { id: m2.moderationId },
      });
      expect(stillActive?.resolvedAt).toBeNull();
      const restoredCount = await rawClient!.adminLog.count({
        where: {
          action: "LISTING_RESTORED",
          targetId: product.id,
          adminId: moderator.id,
        },
      });
      expect(restoredCount).toBe(1); // 仅 SUSPENDED 阶段一次合法 restore
    }, 30_000);

    // ── 7C-Q-PAGE：FR-01 真 keyset 分页（Final Review Repair 冻结）─────────

    /** 控时创建：显式 createdAt 便于 keyset/tie-break 断言。 */
    async function createTimedProduct(input: {
      sellerId: string;
      title: string;
      createdAt: Date;
      campusId?: string;
    }) {
      const product = await rawClient!.product.create({
        data: {
          title: input.title,
          description: "FR-01 keyset 分页集成商品",
          price: "10",
          status: "ACTIVE",
          condition: "NEW",
          locationText: "东门",
          sellerId: input.sellerId,
          campusId: input.campusId ?? campusA.id,
          categoryId: (await ensureProductCategory()).id,
          createdAt: input.createdAt,
        },
      });
      createdProductIds.push(product.id);
      return product;
    }

    it("7C-Q-PAGE-01/02/03：browse 三页 keyset——零重叠、并集恰等全量、同 createdAt 以 id DESC 决胜", async () => {
      const base = new Date("2026-09-01T00:00:00.000Z");
      await createTimedProduct({ sellerId: seller.id, title: `KEYSET${RUN_TAG}-K1`, createdAt: base });
      await createTimedProduct({ sellerId: seller.id, title: `KEYSET${RUN_TAG}-K2`, createdAt: new Date(base.getTime() + 1000) });
      await createTimedProduct({ sellerId: seller.id, title: `KEYSET${RUN_TAG}-K3`, createdAt: new Date(base.getTime() + 2000) });
      // 同 createdAt pair → id DESC 决胜
      const k4a = await createTimedProduct({ sellerId: seller.id, title: `KEYSET${RUN_TAG}-K4a`, createdAt: new Date(base.getTime() + 3000) });
      const k4b = await createTimedProduct({ sellerId: seller.id, title: `KEYSET${RUN_TAG}-K4b`, createdAt: new Date(base.getTime() + 3000) });

      const access = { global: false, campusIds: [campusA.id] };
      const allIds: string[] = [];
      let cursor: { createdAt: Date; id: string } | null = null;
      for (let page = 0; page < 5; page += 1) {
        const result = await browseListings({ access, targetType: "PRODUCT", q: `KEYSET${RUN_TAG}`, cursor, limit: 2 });
        for (const item of result.items) {
          // PAGE-01：页间零重叠
          expect(allIds).not.toContain(item.listingId);
          allIds.push(item.listingId);
        }
        if (!result.hasMore) break;
        const last = result.items[result.items.length - 1];
        cursor = { createdAt: last.cursorCreatedAt, id: last.cursorId };
      }

      // PAGE-02：并集恰等 canonical 排序（createdAt DESC, id DESC），无遗漏
      const canonical = await rawClient!.product.findMany({
        where: { campusId: campusA.id, deletedAt: null, title: { contains: `KEYSET${RUN_TAG}` } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      expect(allIds).toEqual(canonical.map((row) => row.id));

      // PAGE-03：同 createdAt pair 相邻且按 id DESC 决胜
      const idxA = allIds.indexOf(k4a.id);
      const idxB = allIds.indexOf(k4b.id);
      expect(Math.abs(idxA - idxB)).toBe(1);
      const [first, second] = idxA < idxB ? [k4a.id, k4b.id] : [k4b.id, k4a.id];
      expect(first > second).toBe(true);
    }, 30_000);

    it("7C-Q-PAGE-04：active moderation 队列 keyset（moderation 元组）→ 全队列分页零重叠且相对序正确", async () => {
      const base = new Date("2027-01-03T00:00:00.000Z");
      const targets = [];
      for (let i = 0; i < 3; i += 1) {
        const product = await createTimedProduct({ sellerId: seller.id, title: `AM${i}-${RUN_TAG}`, createdAt: base });
        targets.push(product);
      }
      const moderationIds: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const result = await moderateProductListing({
          moderatorId: moderator.id,
          listingId: targets[i].id,
          reasonCode: "OTHER",
        });
        moderationIds.push(result.moderationId);
        await rawClient!.listingModeration.update({
          where: { id: result.moderationId },
          data: { createdAt: new Date(base.getTime() + i * 1000) },
        });
      }
      // 本组三条 createdAt=2027（全队列最新）→ 必须占据 keyset 前 3 位，
      // 顺序 m2 → m1 → m0；limit=2 分页跨页零重叠。
      const access = { global: false, campusIds: [campusA.id] };
      const visitedIds: string[] = [];
      let cursor: { createdAt: Date; id: string } | null = null;
      for (let page = 0; page < 10; page += 1) {
        const result = await loadActiveModerations({ access, cursor, limit: 2 });
        for (const item of result.items) {
          expect(visitedIds).not.toContain(item.activeModeration!.id);
          visitedIds.push(item.activeModeration!.id);
        }
        if (!result.hasMore) break;
        const last = result.items[result.items.length - 1];
        cursor = { createdAt: last.cursorCreatedAt, id: last.cursorId };
      }
      const myPositions = moderationIds.map((id) => visitedIds.indexOf(id));
      expect(myPositions.every((position) => position >= 0)).toBe(true);
      // 相对序：createdAt desc → m2(2s) > m1(1s) > m0(0s)
      expect(myPositions[2]).toBeLessThan(myPositions[1]);
      expect(myPositions[1]).toBeLessThan(myPositions[0]);
      // 前三位恰为本组三条（2027 createdAt 在队列中最新的确定性窗口）
      expect(visitedIds.slice(0, 3)).toEqual([...moderationIds].reverse());
      for (const id of moderationIds) {
        await rawClient!.listingModeration.delete({ where: { id } });
      }
    }, 30_000);

    it("7C-Q-PAGE-05：scope + cursor——campus A actor 无法借 cursor 发现 campus B 行", async () => {
      const base = new Date("2026-09-02T00:00:00.000Z");
      const campusBProduct = await createTimedProduct({
        sellerId: seller.id,
        title: `XB-${RUN_TAG}`,
        createdAt: base,
        campusId: campusB.id,
      });
      const campusAProduct = await createTimedProduct({
        sellerId: seller.id,
        title: `XA-${RUN_TAG}`,
        createdAt: new Date(base.getTime() - 1000),
      });
      // campus A moderator，cursor 伪造为 campus B 行（越权窗口探测）
      const access = { global: false, campusIds: [campusA.id] };
      const forgedCursor = { createdAt: campusBProduct.createdAt, id: campusBProduct.id };
      const page = await browseListings({
        access,
        targetType: "PRODUCT",
        cursor: forgedCursor,
        limit: 10,
      });
      const ids = page.items.map((item) => item.listingId);
      expect(ids).not.toContain(campusBProduct.id);
      expect(ids).toContain(campusAProduct.id);
    }, 30_000);

    it("7C-Q-PAGE-06：q 检索进入查询——命中标题返回、未命中缺席", async () => {
      const base = new Date("2026-09-04T00:00:00.000Z");
      const hit = await createTimedProduct({ sellerId: seller.id, title: `QQ命中针${RUN_TAG}`, createdAt: base });
      const miss = await createTimedProduct({ sellerId: seller.id, title: `QQ其他${RUN_TAG}`, createdAt: new Date(base.getTime() + 1000) });
      const access = { global: false, campusIds: [campusA.id] };
      const page = await browseListings({ access, targetType: "PRODUCT", q: "命中针", cursor: null, limit: 25 });
      const ids = page.items.map((item) => item.listingId);
      expect(ids).toContain(hit.id);
      expect(ids).not.toContain(miss.id);
    }, 30_000);

    it("7C-Q-PAGE-cursor-codec：encode/decode 往返保持 (createdAt,id) 元组", async () => {
      const tuple = { createdAt: new Date("2026-09-13T08:00:00.000Z"), id: "product-x" };
      expect(decodeListingModerationCursor(encodeListingModerationCursor(tuple))).toEqual(tuple);
    }, 15_000);

    // ── FR-02：service/product tx-null → SAFE 失败（route-level 回归）─────

    async function createServiceFixture(title: string) {
      const service = await rawClient!.serviceListing.create({
        data: {
          title,
          description: "FR-02 集成服务",
          price: "40",
          pricingUnit: "PER_SESSION",
          locationText: "线上",
          status: "ACTIVE",
          providerId: seller.id,
          campusId: campusA.id,
          categoryId: (await ensureServiceCategory()).id,
        },
      });
      return service;
    }

    it("FR02-S01：moderated service → action success=false（SAFE 文案）+ 零 Order", async () => {
      const service = await createServiceFixture(`FR02S-${RUN_TAG}`);
      await moderateServiceListing({ moderatorId: moderator.id, listingId: service.id, reasonCode: "OTHER" });
      sessionSeam.actionUser.current = { id: buyer.id, email: "buyer@it.local", name: "买家" };

      const fd = new FormData();
      fd.set("serviceId", service.id);
      fd.set("meetingLocation", "北门");
      fd.set("note", "");
      const result = await createServiceOrder({ success: false, message: "" }, fd);

      expect(result.success).toBe(false);
      expect(result.message).toBe("服务不存在或当前不可预约");
      expect(await rawClient!.order.count({ where: { serviceListingId: service.id } })).toBe(0);
    }, 30_000);

    it("FR02-S03：normal service → success=true + 恰一条 Order（amount=fresh.price，回归）", async () => {
      const service = await createServiceFixture(`FR02S-ok-${RUN_TAG}`);
      sessionSeam.actionUser.current = { id: buyer.id, email: "buyer@it.local", name: "买家" };

      const fd = new FormData();
      fd.set("serviceId", service.id);
      fd.set("meetingLocation", "北门");
      fd.set("note", "");
      const result = await createServiceOrder({ success: false, message: "" }, fd);

      expect(result.success).toBe(true);
      const orders = await rawClient!.order.findMany({ where: { serviceListingId: service.id } });
      expect(orders).toHaveLength(1);
      expect(orders[0].amount.toString()).toBe("40");
    }, 30_000);

    it("FR02-P01/P02：moderated product → SAFE 文案（非误导已有订单）+ 正常路径回归", async () => {
      const hidden = await createTimedProduct({ sellerId: seller.id, title: `FR02P-${RUN_TAG}`, createdAt: new Date("2026-09-05T00:00:00.000Z") });
      await moderateProductListing({ moderatorId: moderator.id, listingId: hidden.id, reasonCode: "OTHER" });
      sessionSeam.actionUser.current = { id: buyer.id, email: "buyer@it.local", name: "买家" };

      const fd = new FormData();
      fd.set("productId", hidden.id);
      fd.set("meetingLocation", "北门");
      fd.set("note", "");
      const denied = await createProductOrder({ success: false, message: "" }, fd);

      expect(denied.success).toBe(false);
      expect(denied.message).toBe("商品不存在或当前不可购买");
      expect(denied.message).not.toContain("已有进行中的订单");
      expect(await rawClient!.order.count({ where: { productId: hidden.id } })).toBe(0);

      const okProduct = await createTimedProduct({ sellerId: seller.id, title: `FR02P-ok-${RUN_TAG}`, createdAt: new Date("2026-09-05T01:00:00.000Z") });
      const fd2 = new FormData();
      fd2.set("productId", okProduct.id);
      fd2.set("meetingLocation", "北门");
      fd2.set("note", "");
      const ok = await createProductOrder({ success: false, message: "" }, fd2);
      expect(ok.success).toBe(true);
      expect(await rawClient!.order.count({ where: { productId: okProduct.id } })).toBe(1);
    }, 30_000);

    // ── FR-03/03B：metadata 治理脱敏 + viewCount 门后计数（route-level）────

    it("FR03-M01/M05/V01/V02：product metadata 泛化 + hidden 公开请求零写入 + 正常路径保留", async () => {
      const { generateMetadata, default: ProductDetailPage } = await import(
        "@/app/products/[id]/page"
      );
      const visible = await createTimedProduct({ sellerId: seller.id, title: `MD-vis-${RUN_TAG}`, createdAt: new Date("2026-09-06T00:00:00.000Z") });
      const hidden = await createTimedProduct({ sellerId: seller.id, title: `MD-hide-${RUN_TAG}`, createdAt: new Date("2026-09-06T01:00:00.000Z") });
      await moderateProductListing({ moderatorId: moderator.id, listingId: hidden.id, reasonCode: "OTHER" });

      // M01：hidden → generic fallback metadata（title 不含商品标题/描述）
      const hiddenMeta = await generateMetadata({ params: Promise.resolve({ id: hidden.id }) });
      expect(String(hiddenMeta.title)).not.toContain("MD-hide");
      expect(String(hiddenMeta.title)).toContain("校园集市");
      if (hiddenMeta.description) {
        expect(hiddenMeta.description).not.toContain("FR-01 keyset 分页集成商品");
      }
      // M05：可见商品 metadata 保留
      const visibleMeta = await generateMetadata({ params: Promise.resolve({ id: visible.id }) });
      expect(String(visibleMeta.title)).toContain("MD-vis");

      // V01：hidden 公开请求（匿名 viewer）→ notFound + viewCount/updatedAt 不变
      const beforeHidden = await rawClient!.product.findUniqueOrThrow({ where: { id: hidden.id } });
      sessionSeam.viewerId.current = null;
      await expect(
        ProductDetailPage({ params: Promise.resolve({ id: hidden.id }) }).then(() => null),
      ).rejects.toThrow();
      const afterHidden = await rawClient!.product.findUniqueOrThrow({ where: { id: hidden.id } });
      expect(afterHidden.viewCount).toBe(beforeHidden.viewCount);
      expect(afterHidden.updatedAt.getTime()).toBe(beforeHidden.updatedAt.getTime());

      // V02：可见商品公开请求 → 既有计数行为保留
      const beforeVisible = await rawClient!.product.findUniqueOrThrow({ where: { id: visible.id } });
      await ProductDetailPage({ params: Promise.resolve({ id: visible.id }) });
      const afterVisible = await rawClient!.product.findUniqueOrThrow({ where: { id: visible.id } });
      expect(afterVisible.viewCount).toBe(beforeVisible.viewCount + 1);
    }, 45_000);

    it("FR03-M02/M03/M04：service/errand/rental hidden metadata 泛化", async () => {
      // SERVICE
      const { generateMetadata: serviceMetadata } = await import("@/app/services/[id]/page");
      const service = await createServiceFixture(`FR03S-${RUN_TAG}`);
      await moderateServiceListing({ moderatorId: moderator.id, listingId: service.id, reasonCode: "OTHER" });
      const serviceMeta = await serviceMetadata({ params: Promise.resolve({ id: service.id }) });
      expect(String(serviceMeta.title)).not.toContain(`FR03S-${RUN_TAG}`);

      // ERRAND
      const { generateMetadata: errandMetadata } = await import("@/app/errands/[id]/page");
      const errand = await createErrandFixture(seller.id);
      await moderateErrandListing({ moderatorId: moderator.id, listingId: errand.id, reasonCode: "OTHER" });
      const errandMeta = await errandMetadata({ params: Promise.resolve({ id: errand.id }) });
      expect(String(errandMeta.title)).not.toContain(errand.title);

      // RENTAL
      const { generateMetadata: rentalMetadata } = await import("@/app/rentals/[id]/page");
      const rental = await createRentalFixture(seller.id);
      await moderateRentalListing({ moderatorId: moderator.id, listingId: rental.id, reasonCode: "OTHER" });
      const rentalMeta = await rentalMetadata({ params: Promise.resolve({ id: rental.id }) });
      expect(String(rentalMeta.title)).not.toContain(rental.title);
    }, 45_000);

    it("FR05-COV：rereadListingForConversation SERVICE/RENTAL 分支 + restore ERRAND 域", async () => {
      const service = await createServiceFixture(`COVS-${RUN_TAG}`);
      const rental = await createRentalFixture(seller.id);

      // SERVICE 分支（无活跃 moderation → 快照；有 → null）
      await rawClient!.$transaction((tx: unknown) =>
        rereadListingForConversation(
          tx as Parameters<typeof rereadListingForConversation>[0],
          "SERVICE",
          service.id,
        ),
      ).then((snapshot: unknown) =>
        expect(snapshot).toMatchObject({ campusId: campusA.id, ownerId: seller.id }),
      );
      await moderateServiceListing({ moderatorId: moderator.id, listingId: service.id, reasonCode: "OTHER" });
      await rawClient!
        .$transaction((tx: unknown) =>
          rereadListingForConversation(
            tx as Parameters<typeof rereadListingForConversation>[0],
            "SERVICE",
            service.id,
          ),
        )
        .then((snapshot: unknown) => expect(snapshot).toBeNull());

      // RENTAL 分支
      await rawClient!.$transaction((tx: unknown) =>
        rereadListingForConversation(
          tx as Parameters<typeof rereadListingForConversation>[0],
          "RENTAL",
          rental.id,
        ),
      ).then((snapshot: unknown) =>
        expect(snapshot).toMatchObject({ campusId: campusA.id, ownerId: seller.id }),
      );

      // restore ERRAND 域（RESTORE_BY_TYPE 分支覆盖）
      const covErrand = await createErrandFixture(seller.id);
      await moderateErrandListing({ moderatorId: moderator.id, listingId: covErrand.id, reasonCode: "OTHER" });
      const errandMod = await rawClient!.listingModeration.findFirstOrThrow({
        where: { errandTaskId: covErrand.id, resolvedAt: null },
      });
      const restored = await restoreListingByModerationIdentity({
        moderatorId: moderator.id,
        moderationId: errandMod.id,
        expectedListingUpdatedAt: covErrand.updatedAt,
      });
      expect(restored.outcome).toBe("RESTORED");
    }, 30_000);

    it("FR05-COV：loadGovernanceListingDetail 四域 + loadListingModerationHistory", async () => {
      const { loadGovernanceListingDetail } = await import(
        "@/lib/moderation/listing-moderation-query"
      );
      const product = await createTimedProduct({ sellerId: seller.id, title: `GOV-P-${RUN_TAG}`, createdAt: new Date("2026-09-08T00:00:00.000Z") });
      const service = await createServiceFixture(`GOV-S-${RUN_TAG}`);
      const errand = await createErrandFixture(seller.id);
      const rental = await createRentalFixture(seller.id);

      const detailProduct = await loadGovernanceListingDetail("PRODUCT", product.id);
      expect(detailProduct).toMatchObject({ targetType: "PRODUCT", campusId: campusA.id });
      const detailService = await loadGovernanceListingDetail("SERVICE", service.id);
      expect(detailService).toMatchObject({ targetType: "SERVICE" });
      const detailErrand = await loadGovernanceListingDetail("ERRAND", errand.id);
      expect(detailErrand).toMatchObject({ targetType: "ERRAND", pricing: "¥20" });
      const detailRental = await loadGovernanceListingDetail("RENTAL", rental.id);
      expect(detailRental).toMatchObject({ targetType: "RENTAL", imageUrls: [] });
      expect(await loadGovernanceListingDetail("PRODUCT", "missing-id")).toBeNull();

      // history：写入两条（takedown + resolve + 再 takedown）后应返回两行
      await moderateProductListing({ moderatorId: moderator.id, listingId: product.id, reasonCode: "OTHER" });
      const active = await rawClient!.listingModeration.findFirstOrThrow({
        where: { productId: product.id, resolvedAt: null },
      });
      await restoreListingByModerationIdentity({
        moderatorId: moderator.id,
        moderationId: active.id,
        expectedListingUpdatedAt: product.updatedAt,
      });
      await moderateProductListing({ moderatorId: moderator.id, listingId: product.id, reasonCode: "OTHER" });
      const { loadListingModerationHistory: history } = await import(
        "@/lib/moderation/listing-moderation-query"
      );
      const rows = await history({ targetType: "PRODUCT", listingId: product.id });
      expect(rows).toHaveLength(2);
      expect(rows[0].resolvedAt).toBeNull();
      expect(rows[1].resolvedAt).not.toBeNull();
    }, 45_000);

    it("FR03-helper：hasActiveModerationForPublicSurface 判定（PUBLIC 面 owner exception 不适用）", async () => {
      const product = await createTimedProduct({ sellerId: seller.id, title: `PUB-${RUN_TAG}`, createdAt: new Date("2026-09-07T00:00:00.000Z") });
      expect(await hasActiveModerationForPublicSurface("PRODUCT", product.id)).toBe(false);
      await moderateProductListing({ moderatorId: moderator.id, listingId: product.id, reasonCode: "OTHER" });
      expect(await hasActiveModerationForPublicSurface("PRODUCT", product.id)).toBe(true);
    }, 20_000);
  },
);

void prismaModule;
