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
  moderateErrandListing,
  moderateRentalListing,
  restoreListingByModerationIdentity,
} from "@/lib/moderation/listing-moderation-service";
import {
  browseListings,
  loadActiveModerations,
  loadReportFlaggedListings,
  rereadListingForConversation,
} from "@/lib/moderation/listing-moderation-query";
import {
  createProductOrderTx,
  claimErrandTx,
} from "@/lib/order-creation";
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
      for (const id of createdErrandIds) {
        await rawClient.listingModeration.deleteMany({ where: { errandTaskId: id } });
      }
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
           SELECT '${RUN_TAG}-m03', 'PRODUCT', p.id, s.id, '${campusA.id}', 'ACTIVE', 'OTHER', '${moderator.id}'
           FROM "Product" p, "ServiceListing" s
           WHERE p.id = '${productFixture.id}' LIMIT 1`,
        ).then((rows) => rows),
      ).rejects.toThrow();
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
      const flagged = await loadReportFlaggedListings({
        access,
        targetType: "PRODUCT",
        cursor: null,
        limit: 25,
      });
      const flaggedRow = flagged.find((item) => item.listingId === product.id);
      expect(flaggedRow).toBeDefined();
      expect(flaggedRow?.openReportReasons).toContain("BANNED_ITEM");

      await moderateProductListing({
        moderatorId: moderator.id,
        listingId: product.id,
        reasonCode: "SPAM_ADVERTISEMENT",
      });
      const active = await loadActiveModerations({ access, cursor: null, limit: 25 });
      const activeRow = active.find(
        (item) => item.listingId === product.id && item.targetType === "PRODUCT",
      );
      expect(activeRow?.activeModeration).toMatchObject({ reasonCode: "SPAM_ADVERTISEMENT" });

      const browsed = await browseListings({
        access,
        targetType: "PRODUCT",
        cursor: null,
        limit: 50,
      });
      // browse tab 不过滤治理态（GOVERNANCE 读面）
      expect(browsed.some((item) => item.listingId === product.id)).toBe(true);
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
  },
);

void prismaModule;
