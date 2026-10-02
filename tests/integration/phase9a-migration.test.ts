import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Phase 9A migration 测试（真实 PostgreSQL，§41/§42/§73）。
//
// 合同：
//   - fresh `prisma migrate deploy` PASS × 2（幂等重跑，CI 同款序列）
//   - 存量 PRODUCT PENDING reservation backfill：每行恰一条
//     PRODUCT_RESERVATION_EXPIRE intent（runAt = 历史 deadline，含过去值——
//     worker 上线后立即发现；禁止 migration 直接 expire Order）
//   - 历史 terminal order（CANCELLED 等）→ 零 job（§10/§43：migration 只建
//     async intent，绝不做 user event replay）
//   - dedupeKey 幂等：backfill 语句重放不产生重复行
//
// §42 守卫（PRODUCT PENDING 缺 deadline → RAISE EXCEPTION）不在此测试：
// 该状态被 Phase 8B CHECK（Order_product_pending_deadline_check）在 DB 层
// 禁止，守卫是迁移的纵深防御（fail closed，不可达即证明约束生效）。
//
// backfill 断言通过执行【真实 migration.sql 文件中的 backfill 语句】完成
// （运行时读取文件切片，零复制漂移）；fresh deploy 使用独立 scratch 数据库，
// 不污染共享集成库。

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p9amig-${randomUUID().slice(0, 8)}`;
const MIGRATION_DIR = "20261002130000_phase9a_async_core_outbox";

const createdUserIds: string[] = [];
const createdProductIds: string[] = [];
const createdOrderIds: string[] = [];
const createdMembershipIds: string[] = [];

let campusId = "";
let productCategoryId = "";

/** 读取真实 migration 文件中的 backfill INSERT 语句（文件末段，零复制漂移）。 */
function loadBackfillSql(): string {
  const migrationSql = readFileSync(
    path.join(process.cwd(), "prisma", "migrations", MIGRATION_DIR, "migration.sql"),
    "utf8",
  );
  const insertIndex = migrationSql.indexOf("INSERT INTO \"AsyncJob\"");
  expect(insertIndex).toBeGreaterThan(-1);
  return migrationSql.slice(insertIndex);
}

beforeAll(async () => {
  if (!rawClient) return;
  const campus = await rawClient.campus.upsert({
    where: { slug: RUN_TAG },
    create: { name: `9A迁移校区 ${RUN_TAG}`, slug: RUN_TAG, schoolName: "集成测试大学" },
    update: {},
  });
  campusId = campus.id;
  const category = await rawClient.productCategory.create({
    data: { name: `9A迁移类目-${RUN_TAG}`, slug: RUN_TAG },
  });
  productCategoryId = category.id;
});

afterAll(async () => {
  if (!rawClient) return;
  await rawClient.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await rawClient.product.deleteMany({ where: { id: { in: createdProductIds } } });
  await rawClient.productCategory.deleteMany({ where: { id: productCategoryId } });
  await rawClient.campusMembership.deleteMany({ where: { id: { in: createdMembershipIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await rawClient.campus.deleteMany({ where: { id: campusId } });
  await rawClient.$disconnect();
});

/** legacy 形态订单（PENDING 必带 deadline——8B CHECK 契约）。 */
async function createLegacyOrder(input: {
  buyerId: string;
  sellerId: string;
  productId: string;
  status: "PENDING" | "CANCELLED";
  deadline?: Date;
}) {
  const order = await rawClient!.order.create({
    data: {
      orderNo: `${RUN_TAG}${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
      type: "PRODUCT",
      status: input.status,
      buyerId: input.buyerId,
      sellerId: input.sellerId,
      productId: input.productId,
      amount: "10.00",
      productReservationExpiresAt: input.status === "PENDING" ? (input.deadline ?? new Date()) : null,
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 9A migration（真实 PG：fresh deploy ×2 + reservation job backfill）",
  () => {
    it("MIGRATE-FRESH-01（§73）：scratch 库 fresh migrate deploy PASS ×2（幂等重跑）", async () => {
      const scratchDb = `phase9a_mig_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const parsed = new URL(integrationDatabaseUrl!);
      const maintenanceUrl = (() => {
        const u = new URL(integrationDatabaseUrl!);
        u.pathname = "/postgres";
        return u.toString();
      })();

      try {
        // CREATE DATABASE（已存在 42P04 吞掉）
        try {
          execSync("npx prisma db execute --schema prisma/schema.prisma --stdin", {
            input: `CREATE DATABASE "${scratchDb}";`,
            env: { ...process.env, DATABASE_URL: maintenanceUrl },
            stdio: ["pipe", "ignore", "pipe"],
          });
        } catch {
          // already exists
        }

        const scratchUrl = (() => {
          const u = new URL(integrationDatabaseUrl!);
          u.pathname = `/${scratchDb}`;
          return u.toString();
        })();

        // fresh deploy 必须成功
        execSync("npx prisma migrate deploy", {
          env: { ...process.env, DATABASE_URL: scratchUrl },
          stdio: ["pipe", "ignore", "pipe"],
        });
        // 第二次 deploy 必须幂等成功（No pending migrations）
        const second = execSync("npx prisma migrate deploy", {
          env: { ...process.env, DATABASE_URL: scratchUrl },
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        expect(second).toMatch(/No pending migrations/i);
      } finally {
        try {
          // 强制断开 scratch 连接后删除
          execSync("npx prisma db execute --schema prisma/schema.prisma --stdin", {
            input: `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${scratchDb}' AND pid <> pg_backend_pid(); DROP DATABASE IF EXISTS "${scratchDb}";`,
            env: { ...process.env, DATABASE_URL: maintenanceUrl },
            stdio: ["pipe", "ignore", "pipe"],
          });
        } catch {
          // scratch 清理尽力而为（命名唯一，残留不污染其它测试）
        }
      }
      void parsed;
    });

    it("BACKFILL-01（§10/§43）：存量 PENDING → 恰一条 intent（runAt 保留历史 deadline 含过去值）；terminal order → 零 job；语句重放幂等", async () => {
      const seller = await rawClient!.user.create({
        data: {
          email: `${RUN_TAG}-seller@it.local`,
          name: "backfill卖家",
          passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
          schoolName: "集成测试大学",
          campusId,
          role: "STUDENT",
          status: "ACTIVE",
        },
      });
      createdUserIds.push(seller.id);
      const membership = await rawClient!.campusMembership.create({
        data: { userId: seller.id, campusId, status: "ACTIVE" },
      });
      createdMembershipIds.push(membership.id);
      const buyer = await rawClient!.user.create({
        data: {
          email: `${RUN_TAG}-buyer@it.local`,
          name: "backfill买家",
          passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
          schoolName: "集成测试大学",
          campusId,
          role: "STUDENT",
          status: "ACTIVE",
        },
      });
      createdUserIds.push(buyer.id);
      const buyerMembership = await rawClient!.campusMembership.create({
        data: { userId: buyer.id, campusId, status: "ACTIVE" },
      });
      createdMembershipIds.push(buyerMembership.id);

      const product = await rawClient!.product.create({
        data: {
          title: `9A迁移商品 ${RUN_TAG}`,
          description: "backfill fixture",
          price: 10,
          condition: "NEW",
          locationText: "东门",
          categoryId: productCategoryId,
          campusId,
          sellerId: seller.id,
          status: "RESERVED",
        },
      });
      createdProductIds.push(product.id);

      // 模拟 pre-9A 存量：过去 deadline 的 PENDING（worker 上线立即发现）、
      // 未来 deadline 的 PENDING、历史 CANCELLED terminal
      const pastDeadline = new Date(Date.now() - 60 * 60 * 1000);
      const futureDeadline = new Date(Date.now() + 60 * 60 * 1000);
      const pendingPast = await createLegacyOrder({
        buyerId: buyer.id,
        sellerId: seller.id,
        productId: product.id,
        status: "PENDING",
        deadline: pastDeadline,
      });
      const pendingFuture = await createLegacyOrder({
        buyerId: buyer.id,
        sellerId: seller.id,
        productId: product.id,
        status: "PENDING",
        deadline: futureDeadline,
      });
      const terminalCancelled = await createLegacyOrder({
        buyerId: buyer.id,
        sellerId: seller.id,
        productId: product.id,
        status: "CANCELLED",
      });

      // 清除（若创建链或早前 backfill 产生的）job → 回到 pre-9A 状态
      for (const order of [pendingPast, pendingFuture, terminalCancelled]) {
        await rawClient!.asyncJob.deleteMany({
          where: { dedupeKey: `PRODUCT_RESERVATION_EXPIRE:${order.id}` },
        });
      }

      // 执行真实 migration 文件中的 backfill 语句
      const backfillSql = loadBackfillSql();
      await rawClient!.$executeRawUnsafe(backfillSql);

      // PENDING 行：恰一条 intent，runAt = 历史 deadline（过去值保留）
      for (const [order, deadline] of [
        [pendingPast, pastDeadline],
        [pendingFuture, futureDeadline],
      ] as const) {
        const jobs = await rawClient!.asyncJob.findMany({
          where: { dedupeKey: `PRODUCT_RESERVATION_EXPIRE:${order.id}` },
        });
        expect(jobs).toHaveLength(1);
        expect(jobs[0].kind).toBe("PRODUCT_RESERVATION_EXPIRE");
        expect(jobs[0].schemaVersion).toBe(1);
        expect(jobs[0].status).toBe("PENDING");
        expect(jobs[0].runAt.getTime()).toBe(deadline.getTime());
        expect(jobs[0].payload).toEqual({ orderId: order.id });
      }

      // 历史 terminal order：零 job（migration ≠ user event replay）
      expect(
        await rawClient!.asyncJob.count({
          where: { dedupeKey: `PRODUCT_RESERVATION_EXPIRE:${terminalCancelled.id}` },
        }),
      ).toBe(0);

      // 迁移不直接 expire Order：业务状态完全未被触碰（§10/§43）
      const untouchedPast = await rawClient!.order.findUniqueOrThrow({
        where: { id: pendingPast.id },
      });
      expect(untouchedPast.status).toBe("PENDING");
      expect(untouchedPast.productReservationResolution).toBeNull();

      // 语句重放幂等（ON CONFLICT DO NOTHING）
      await rawClient!.$executeRawUnsafe(backfillSql);
      expect(
        await rawClient!.asyncJob.count({
          where: { dedupeKey: { in: [pendingPast, pendingFuture].map((o) => `PRODUCT_RESERVATION_EXPIRE:${o.id}`) } },
        }),
      ).toBe(2);

      // 清理本用例产生的 backfill job（精确 dedupeKey 域）
      await rawClient!.asyncJob.deleteMany({
        where: {
          dedupeKey: {
            in: [pendingPast, pendingFuture].map((o) => `PRODUCT_RESERVATION_EXPIRE:${o.id}`),
          },
        },
      });
    });
  },
);
