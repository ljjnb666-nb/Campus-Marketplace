import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * MIGRATION-01/02：Repair 4 data-only migration 行为证明（真实 PostgreSQL）。
 *
 * 在临时库上重放全部 pre-migrations → 种子"迁移前"数据形态（历史通知
 * raw free text / 已注销用户的未清理副本）→ 应用本 migration SQL →
 * 逐字段断言确定性回填 → 重复应用同一 SQL 断言幂等（idempotent in effect）。
 *
 * 冻结合同：
 * - 无启发式作者猜测（全部经 FK / ownership / explicit actor relation 归属）
 * - 历史 Notification（DERIVED_EPHEMERAL）统一 redact，title/type/isRead 保留
 * - 非注销用户的权威字段绝不被触碰（对照用户）
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const NEW_MIGRATION = "20260924120000_repair4_privacy_lifecycle_backfill";
const ERASED_MARKER = "（该内容已随账号注销删除）";
const HISTORICAL_NOTIFICATION_MARKER = "历史通知详情已按隐私策略清理，请查看相关业务记录。";

function swapDatabaseName(databaseUrl: string, name: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${name}`;
  parsed.search = "";
  return parsed.toString();
}

function runPrismaCli(args: string[], databaseUrl: string, input?: string): string {
  const result = spawnSync(
    process.execPath,
    [join("node_modules", "prisma", "build", "index.js"), ...args],
    {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
      input,
    },
  );
  if (result.status !== 0) {
    throw new Error(`prisma cli failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

function runPrismaDbExecute(sql: string, databaseUrl: string): void {
  runPrismaCli(["db", "execute", "--schema", "prisma/schema.prisma", "--stdin"], databaseUrl, sql);
}

const TEMP_DB = `rb04mig_${randomUUID().slice(0, 8)}`;

function createTempDatabase(): string {
  const maintenanceUrl = swapDatabaseName(integrationDatabaseUrl!, "postgres");
  runPrismaDbExecute(`DROP DATABASE IF EXISTS "${TEMP_DB}";`, maintenanceUrl);
  runPrismaDbExecute(`CREATE DATABASE "${TEMP_DB}";`, maintenanceUrl);
  return swapDatabaseName(integrationDatabaseUrl!, TEMP_DB);
}

function dropTempDatabase(): void {
  const maintenanceUrl = swapDatabaseName(integrationDatabaseUrl!, "postgres");
  try {
    runPrismaDbExecute(`DROP DATABASE IF EXISTS "${TEMP_DB}" WITH (FORCE);`, maintenanceUrl);
  } catch {
    // 残留连接 FORCE 已尽力
  }
}

function replayPreMigrations(tempUrl: string): void {
  const migrationsDir = join(process.cwd(), "prisma", "migrations");
  const preMigrations = readdirSync(migrationsDir)
    .filter((name) => /^\d{14}_/.test(name) && name < NEW_MIGRATION)
    .sort();
  expect(preMigrations.length).toBeGreaterThan(0);
  const sql = preMigrations
    .map((name) => readFileSync(join(migrationsDir, name, "migration.sql"), "utf8"))
    .join("\n\n");
  runPrismaDbExecute(sql, tempUrl);
}

function newMigrationSql(): string {
  return readFileSync(
    join(process.cwd(), "prisma", "migrations", NEW_MIGRATION, "migration.sql"),
    "utf8",
  );
}

describe.skipIf(!integrationDatabaseUrl)("Repair 4 privacy backfill migration (real PostgreSQL)", () => {
  afterAll(async () => {
    if (integrationDatabaseUrl) {
      dropTempDatabase();
    }
  });

  it("MIGRATION-01/02：历史通知 redact + already-erased 用户确定性回填 + 幂等重放", async () => {
    const tempUrl = createTempDatabase();
    replayPreMigrations(tempUrl);

    // 临时库独立客户端（PrismaClient datasources 构造后不可变）
    const db = new PrismaClient({ datasources: { db: { url: tempUrl } }, log: ["error"] });
    try {
      // ---- 种子 pre-migration 数据形态 ----
      const campus = await db.campus.create({
        data: {
          name: "RB04 迁移校区",
          slug: `rb04mig-${randomUUID().slice(0, 8)}`,
          schoolName: "集成测试大学",
        },
      });
      const erased = await db.user.create({
        data: {
          name: "历史注销用户",
          email: `erased-${randomUUID().slice(0, 8)}@it.local`,
          passwordHash: "test-only",
          schoolName: "示例大学",
          campusId: campus.id,
          erasedAt: new Date("2026-09-01T00:00:00Z"),
        },
      });
      const survivor = await db.user.create({
        data: {
          name: "在册对照用户",
          email: `survivor-${randomUUID().slice(0, 8)}@it.local`,
          passwordHash: "test-only",
          schoolName: "示例大学",
          campusId: campus.id,
        },
      });
      const erasedMembership = await db.campusMembership.create({
        data: { userId: erased.id, campusId: campus.id, status: "LEFT" },
      });

      // 历史通知：无法定位作者（含 raw free text）——全部 redact
      await db.notification.create({
        data: { userId: erased.id, type: "SYSTEM", title: "历史标题A", content: "审核未通过：材料模糊" },
      });
      await db.notification.create({
        data: { userId: survivor.id, type: "RENTAL", title: "历史标题B", content: "拒绝原因：不想租了" },
      });

      // 已注销用户的未清理副本
      const verification = await db.userVerification.create({
        data: {
          userId: erased.id,
          membershipId: erasedMembership.id,
          schoolName: "示例大学",
          campusName: "主校区",
          studentIdLast4: "1234",
          studentCardImage: "erased",
          status: "REJECTED",
          reviewNote: "历史审核备注",
          submittedAt: new Date(),
          reviewDueAt: new Date(),
        },
      });
      expect(verification.reviewNote).toBe("历史审核备注");

      await db.supportTicket.create({
        data: {
          requesterId: erased.id,
          scopeKey: "UNSCOPED",
          category: "ACCOUNT",
          status: "RESOLVED",
          subject: "历史工单标题",
          description: "历史工单描述",
          resolutionCode: "ANSWERED",
          resolutionMessage: "历史处理消息",
          internalNote: "历史内部备注",
          dueAt: new Date(),
        },
      });

      const avatarAsset = await db.uploadedAsset.create({
        data: {
          ownerId: erased.id,
          category: "AVATAR",
          access: "PUBLIC",
          bucket: "campus-public",
          objectKey: `rb04mig/${randomUUID().slice(0, 8)}`,
          mimeType: "image/webp",
          sizeBytes: 10,
          status: "UPLOADED",
          originalFileName: "历史头像.png",
        },
      });
      const productAsset = await db.uploadedAsset.create({
        data: {
          ownerId: erased.id,
          category: "PRODUCT",
          access: "PUBLIC",
          bucket: "campus-public",
          objectKey: `rb04mig/${randomUUID().slice(0, 8)}`,
          mimeType: "image/webp",
          sizeBytes: 10,
          status: "ATTACHED",
          originalFileName: "历史商品图.png",
        },
      });

      // rental 链路：listing + order + status log
      const rentalCategory = await db.rentalCategory.create({
        data: { name: `rb04mig-${randomUUID().slice(0, 8)}`, slug: `rb04mig-${randomUUID().slice(0, 8)}` },
      });
      const listing = await db.rentalListing.create({
        data: {
          title: "迁移测试出租",
          description: "迁移测试",
          condition: "LIKE_NEW",
          price: "1.00",
          pricingUnit: "PER_DAY",
          depositAmount: "0",
          minimumDuration: 1,
          maximumDuration: 5,
          ownerId: survivor.id,
          campusId: campus.id,
          categoryId: rentalCategory.id,
          pickupLocation: "北门",
          returnLocation: "北门",
        },
      });
      const rentalOrder = await db.rentalOrder.create({
        data: {
          orderNumber: `ROMIG${randomUUID().slice(0, 6)}`,
          rentalListingId: listing.id,
          ownerId: survivor.id,
          renterId: erased.id,
          startTime: new Date(),
          endTime: new Date(),
          unitPriceSnapshot: "1.00",
          pricingUnitSnapshot: "PER_DAY",
          rentalDuration: 1,
          rentalAmount: "1.00",
          depositAmount: "0",
          finalAmount: "1.00",
          paymentStatus: "OFFLINE_PENDING",
          depositStatus: "NOT_REQUIRED",
          status: "CANCELLED",
          pickupLocationSnapshot: "北门",
          returnLocationSnapshot: "北门",
          renterNote: "历史租客备注",
          cancellationNote: "历史取消备注",
          cancelledById: erased.id,
        },
      });
      await db.rentalOrderStatusLog.create({
        data: { orderId: rentalOrder.id, fromStatus: "PENDING_APPROVAL", toStatus: "REJECTED", operatorId: erased.id, note: "历史日志备注" },
      });
      await db.rentalOrderStatusLog.create({
        data: { orderId: rentalOrder.id, fromStatus: "PENDING_APPROVAL", toStatus: "PENDING_PICKUP", operatorId: survivor.id, note: "对照日志备注" },
      });

      // message / review / report / dispute
      const conversation = await db.conversation.create({
        data: { participants: { create: [{ userId: erased.id }, { userId: survivor.id }] } },
      });
      await db.message.create({
        data: { conversationId: conversation.id, senderId: erased.id, type: "DIRECT", content: "历史消息原文" },
      });

      const productCategory = await db.productCategory.create({
        data: { name: `rb04mig-${randomUUID().slice(0, 8)}`, slug: `rb04mig-${randomUUID().slice(0, 8)}` },
      });
      const product = await db.product.create({
        data: {
          title: "迁移测试商品",
          description: "迁移测试",
          price: "1.00",
          locationText: "北门",
          condition: "LIKE_NEW",
          sellerId: survivor.id,
          campusId: campus.id,
          categoryId: productCategory.id,
        },
      });
      const order = await db.order.create({
        data: {
          orderNo: `GOMIG${randomUUID().slice(0, 6)}`,
          type: "PRODUCT",
          status: "COMPLETED",
          paymentStatus: "OFFLINE_PENDING",
          amount: "1.00",
          note: "历史订单留言",
          cancelReason: null,
          buyerId: erased.id,
          sellerId: survivor.id,
          productId: product.id,
        },
      });
      await db.review.create({
        data: { orderId: order.id, authorId: erased.id, targetUserId: survivor.id, rating: 5, content: "历史评价原文", tags: ["历史"] },
      });
      await db.report.create({
        data: {
          targetType: "USER",
          reason: "ADVERTISEMENT",
          detail: "历史举报详情",
          status: "RESOLVED",
          reporterId: erased.id,
          handledById: survivor.id,
          handledNote: "历史 operator 备注",
          scopeKey: "UNSCOPED",
        },
      });
      const enforcement = await db.enforcementAction.create({
        data: {
          type: "ACCOUNT_SUSPEND",
          actorId: survivor.id,
          targetId: erased.id,
          scopeKey: "GLOBAL",
          reasonCode: "POLICY_VIOLATION",
          resultState: "USER:SUSPENDED",
        },
      });
      await db.appeal.create({
        data: {
          enforcementActionId: enforcement.id,
          status: "UPHELD",
          statement: "历史申诉原文",
          reviewDueAt: new Date(),
          decisionReasonCode: "MERIT_VIOLATION_CONFIRMED",
        },
      });
      await db.rentalDispute.create({
        data: {
          orderId: rentalOrder.id,
          initiatorId: erased.id,
          reason: "历史纠纷原因",
          evidencePhotos: ["asset:legacy"],
          status: "CLOSED",
          campusId: campus.id,
          scopeKey: `CAMPUS:${campus.id}`,
          dueAt: new Date(),
          resolutionCode: "OTHER",
          resolutionAction: "CLOSE_ORDER",
        },
      });

      // ---- 应用新 migration SQL ----
      runPrismaDbExecute(newMigrationSql(), tempUrl);

      // ---- MIGRATION-01：历史通知全量 redact，title/type/isRead/createdAt 保留 ----
      const notifications = await db.notification.findMany({ orderBy: { createdAt: "asc" } });
      expect(notifications).toHaveLength(2);
      for (const notification of notifications) {
        expect(notification.content).toBe(HISTORICAL_NOTIFICATION_MARKER);
      }
      expect(notifications[0]!.title).toBe("历史标题A");
      expect(notifications[1]!.title).toBe("历史标题B");
      expect(notifications.map((entry) => entry.type).sort()).toEqual(["RENTAL", "SYSTEM"]);

      // ---- MIGRATION-02：already-erased 用户逐字段回填 ----
      const backfilledVerification = await db.userVerification.findUniqueOrThrow({ where: { id: verification.id } });
      expect(backfilledVerification.reviewNote).toBeNull();

      const ticket = await db.supportTicket.findFirstOrThrow({ where: { requesterId: erased.id } });
      expect(ticket.subject).toBe(ERASED_MARKER);
      expect(ticket.description).toBe(ERASED_MARKER);
      expect(ticket.resolutionMessage).toBeNull();
      expect(ticket.internalNote).toBeNull();

      const backfilledAvatar = await db.uploadedAsset.findUniqueOrThrow({ where: { id: avatarAsset.id } });
      expect(backfilledAvatar.originalFileName).toBeNull();
      expect(backfilledAvatar.status).toBe("PENDING_DELETE");
      const backfilledProduct = await db.uploadedAsset.findUniqueOrThrow({ where: { id: productAsset.id } });
      expect(backfilledProduct.originalFileName).toBeNull();
      expect(backfilledProduct.status).toBe("ATTACHED");

      const logs = await db.rentalOrderStatusLog.findMany({ where: { orderId: rentalOrder.id } });
      const erasedLog = logs.find((log) => log.operatorId === erased.id)!;
      const survivorLog = logs.find((log) => log.operatorId === survivor.id)!;
      expect(erasedLog.note).toBeNull();
      expect(survivorLog.note).toBe("对照日志备注");

      const backfilledOrder = await db.rentalOrder.findUniqueOrThrow({ where: { id: rentalOrder.id } });
      expect(backfilledOrder.renterNote).toBeNull();
      expect(backfilledOrder.cancellationNote).toBeNull();
      expect(backfilledOrder.cancellationReason).toBeNull();

      const backfilledMessage = await db.message.findFirstOrThrow({ where: { conversationId: conversation.id } });
      expect(backfilledMessage.content).toBe(ERASED_MARKER);
      expect(backfilledMessage.senderId).toBeNull();

      const backfilledReview = await db.review.findFirstOrThrow({ where: { authorId: erased.id } });
      expect(backfilledReview.content).toBeNull();
      expect(backfilledReview.tags).toEqual([]);
      expect(backfilledReview.rating).toBe(5);

      const backfilledReport = await db.report.findFirstOrThrow({ where: { reporterId: erased.id } });
      expect(backfilledReport.detail).toBeNull();
      expect(backfilledReport.handledNote).toBe("历史 operator 备注");

      const backfilledAppeal = await db.appeal.findUniqueOrThrow({ where: { enforcementActionId: enforcement.id } });
      expect(backfilledAppeal.statement).toBe(ERASED_MARKER);

      const backfilledGeneralOrder = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(backfilledGeneralOrder.note).toBeNull();

      const backfilledDispute = await db.rentalDispute.findFirstOrThrow({ where: { initiatorId: erased.id } });
      expect(backfilledDispute.reason).toBe(ERASED_MARKER);
      expect(backfilledDispute.evidencePhotos).toEqual([]);

      // ---- 对照用户权威字段绝不被触碰（历史通知 redact 除外） ----
      const survivorAfter = await db.user.findUniqueOrThrow({ where: { id: survivor.id } });
      expect(survivorAfter.name).toBe("在册对照用户");
      expect(survivorAfter.email).toContain("survivor-");
      expect(await db.userVerification.findUnique({ where: { userId: survivor.id } })).toBeNull();

      // ---- 幂等：重复应用同一 SQL，终态不变 ----
      runPrismaDbExecute(newMigrationSql(), tempUrl);
      const notificationsAfterReplay = await db.notification.findMany();
      expect(notificationsAfterReplay.map((entry) => entry.content)).toEqual([
        HISTORICAL_NOTIFICATION_MARKER,
        HISTORICAL_NOTIFICATION_MARKER,
      ]);
      const avatarAfterReplay = await db.uploadedAsset.findUniqueOrThrow({ where: { id: avatarAsset.id } });
      expect(avatarAfterReplay.status).toBe("PENDING_DELETE");
      const reviewAfterReplay = await db.review.findFirstOrThrow({ where: { authorId: erased.id } });
      expect(reviewAfterReplay.content).toBeNull();
      expect(reviewAfterReplay.tags).toEqual([]);
    } finally {
      await db.$disconnect().catch(() => undefined);
    }
  });
});
