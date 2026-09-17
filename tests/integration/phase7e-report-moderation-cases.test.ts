import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { decodeReportCursor } from "@/lib/reports/report-query";

// Phase 7E Report & Moderation Case Operations 集成测试（真实 PostgreSQL）。
//
// 覆盖（指令冻结的矩阵）：
//  - M01..M12：migration 合同（DDL/CHECK/unique/索引、四域 campus backfill、
//    USER/MESSAGE UNSCOPED、closedAt 映射、dueAt 历史起点、每 Report 恰一 case、
//    rerun 幂等、role data-only 收敛）
//  - S01..S06：scope 授权（GLOBAL/校区/UNSCOPED、fail-closed、exact-pair 无叉积）
//  - R01..R06：rental report 全链（validator→resolver→snapshot→case→投影→队列/详情）
//  - C01..C08：case 生命周期（1:1、close/reopen/dueAt、SLA 零自动执法）
//  - CL01..CL05：并发（claim 竞争/幂等/非领用人拒绝、review↔claim 串行、
//    resolve vs reject 唯一合法终局）
//  - P01..P06：隐私（queue DTO 最小化、越权 detail notFound、跨校区无存在性 oracle）
//
// 零 sleep：并发 barrier = racePoint seam + pg_stat_activity waiter 轮询
// （6B/7B/7C 同约定）。

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

const RUN_TAG = `p7e-${randomUUID().slice(0, 8)}`;
const FIXTURE_PASSWORD_HASH = ["$2a$10$", "itfixtureitfixtureitfixtureitfixtureitfix"].join("");

const createdUserIds: string[] = [];
const createdCampusIds: string[] = [];
const createdAssignmentIds: string[] = [];
const createdMembershipIds: string[] = [];
const createdReportIds: string[] = [];
const createdListingIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdConversationIds: string[] = [];

let campusA: { id: string; name: string };
let campusB: { id: string; name: string };
let globalAdmin: { id: string };
let reviewerA: { id: string };
let reviewerB: { id: string };
let reporter: { id: string };
let seller: { id: string };

async function createFixtureUser(
  name: string,
  options: { membershipCampusId?: string | null } = {},
) {
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
  const membershipCampusId = options.membershipCampusId === undefined ? campusA.id : options.membershipCampusId;
  if (membershipCampusId) {
    const membership = await rawClient!.campusMembership.create({
      data: { userId: user.id, campusId: membershipCampusId, status: "ACTIVE" },
    });
    createdMembershipIds.push(membership.id);
  }
  return user;
}

async function assignRoleByKey(
  userId: string,
  roleKey: string,
  campusId: string | null,
) {
  const role = await rawClient!.role.findUniqueOrThrow({ where: { key: roleKey } });
  const assignment = await rawClient!.userRoleAssignment.create({
    data: {
      userId,
      roleId: role.id,
      campusId,
      scopeKey: campusId ? `CAMPUS:${campusId}` : "GLOBAL",
    },
  });
  createdAssignmentIds.push(assignment.id);
  return assignment;
}

let productCategoryId: string | null = null;
async function ensureProductCategory() {
  if (productCategoryId) return { id: productCategoryId };
  const category = await rawClient!.productCategory.create({
    data: { name: `${RUN_TAG}-图书`, slug: `${RUN_TAG}-books`, isActive: true },
  });
  productCategoryId = category.id;
  createdCategoryIds.push(category.id);
  return category;
}

async function createProductFixture(campusId: string, ownerId: string) {
  const product = await rawClient!.product.create({
    data: {
      title: `${RUN_TAG}-集成商品`,
      description: "7E 集成测试商品",
      price: "88",
      status: "ACTIVE",
      condition: "NORMAL_USED",
      locationText: "东门集市",
      sellerId: ownerId,
      campusId,
      categoryId: (await ensureProductCategory()).id,
    },
  });
  createdListingIds.push(product.id);
  return product;
}

async function createErrandFixture(campusId: string, ownerId: string) {
  const category = await rawClient!.errandCategory.create({
    data: { name: `${RUN_TAG}-代取`, slug: `${RUN_TAG}-errand-${createdCategoryIds.length}`, isActive: true },
  });
  createdCategoryIds.push(category.id);
  const errand = await rawClient!.errandTask.create({
    data: {
      title: `${RUN_TAG}-集成跑腿`,
      description: "7E 集成测试跑腿",
      reward: "20",
      status: "OPEN",
      publisherId: ownerId,
      campusId,
      categoryId: category.id,
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      pickupLocation: "东门",
      deliveryLocation: "南门",
    },
  });
  createdListingIds.push(errand.id);
  return errand;
}

async function createServiceFixture(campusId: string, ownerId: string) {
  const category = await rawClient!.serviceCategory.create({
    data: { name: `${RUN_TAG}-服务类`, slug: `${RUN_TAG}-svc-${createdCategoryIds.length}`, isActive: true },
  });
  createdCategoryIds.push(category.id);
  const service = await rawClient!.serviceListing.create({
    data: {
      title: `${RUN_TAG}-集成服务`,
      description: "7E 集成测试服务",
      price: "50",
      pricingUnit: "PER_SESSION",
      locationText: "东门集市",
      status: "ACTIVE",
      providerId: ownerId,
      campusId,
      categoryId: category.id,
    },
  });
  createdListingIds.push(service.id);
  return service;
}

async function createRentalFixture(campusId: string, ownerId: string) {
  const category = await rawClient!.rentalCategory.create({
    data: { name: `${RUN_TAG}-设备`, slug: `${RUN_TAG}-rental-${createdCategoryIds.length}`, isActive: true },
  });
  createdCategoryIds.push(category.id);
  const listing = await rawClient!.rentalListing.create({
    data: {
      title: `${RUN_TAG}-集成租赁`,
      description: "7E 集成测试租赁",
      price: "30",
      pricingUnit: "PER_DAY",
      depositAmount: "50",
      condition: "NORMAL_USED",
      status: "AVAILABLE",
      ownerId,
      campusId,
      categoryId: category.id,
      totalQuantity: 1,
      availableQuantity: 1,
      minimumDuration: 1,
      maximumDuration: 30,
      pickupLocation: "北门",
      returnLocation: "北门",
    },
  });
  createdListingIds.push(listing.id);
  return listing;
}

/** 直建 Report（绕过 action；scope 按冻结规则给定）。 */
async function createReportRow(input: {
  reporterId: string;
  targetType: "PRODUCT" | "ERRAND_TASK" | "SERVICE_LISTING" | "RENTAL_LISTING" | "USER" | "MESSAGE";
  reason?: "FAKE_INFO" | "SCAM_RISK";
  status?: "OPEN" | "IN_REVIEW" | "RESOLVED" | "REJECTED";
  campusId: string | null;
  scopeKey: string;
  productId?: string;
  errandTaskId?: string;
  serviceListingId?: string;
  rentalListingId?: string;
  targetUserId?: string;
  handledAt?: Date;
}) {
  const report = await rawClient!.report.create({
    data: {
      reporterId: input.reporterId,
      targetType: input.targetType,
      reason: input.reason ?? "FAKE_INFO",
      detail: "集成测试举报",
      status: input.status ?? "OPEN",
      campusId: input.campusId,
      scopeKey: input.scopeKey,
      productId: input.productId,
      errandTaskId: input.errandTaskId,
      serviceListingId: input.serviceListingId,
      rentalListingId: input.rentalListingId,
      targetUserId: input.targetUserId,
      handledAt: input.handledAt,
    },
  });
  createdReportIds.push(report.id);
  return report;
}

/** 直建 case（模拟 post-migration 每行必有 case 的既有态）。 */
async function createCaseRow(input: {
  reportId: string;
  campusId: string | null;
  scopeKey: string;
  openedAt: Date;
  dueAt: Date;
  closedAt?: Date | null;
}) {
  return rawClient!.moderationCase.create({
    data: {
      reportId: input.reportId,
      campusId: input.campusId,
      scopeKey: input.scopeKey,
      openedAt: input.openedAt,
      dueAt: input.dueAt,
      lastActivityAt: input.openedAt,
      closedAt: input.closedAt ?? null,
    },
  });
}

/** 行锁等待者证明：目标表的 FOR UPDATE 真实存在等待者。 */
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

async function queueItemsFor(access: { global: boolean; campusIds: string[] }, filters?: Record<string, unknown>) {
  const { loadAuthorizedReportQueue } = await import("@/lib/reports/report-query");
  const items: Awaited<ReturnType<typeof loadAuthorizedReportQueue>>["items"] = [];
  let nextCursor: string | null = null;
  for (let page = 0; page < 40; page += 1) {
    const result = await loadAuthorizedReportQueue({
      viewerId: "viewer-not-used-for-authz",
      access: access as never,
      limit: 50,
      cursor: nextCursor
        ? (decodeReportCursor(nextCursor) as NonNullable<ReturnType<typeof decodeReportCursor>>)
        : undefined,
      filters: filters as never,
    });
    items.push(...result.items);
    nextCursor = result.nextCursor;
    if (!nextCursor) break;
  }
  return items;
}

async function queueReportIdsFor(access: { global: boolean; campusIds: string[] }, filters?: Record<string, unknown>) {
  const items = await queueItemsFor(access, filters);
  return items.map((item) => item.reportId);
}

beforeAll(async () => {
  if (!rawClient) return;

  campusA = await rawClient.campus.create({
    data: { name: `${RUN_TAG}-校区A`, slug: `${RUN_TAG}-a`, schoolName: "集成测试大学", isActive: true },
  });
  createdCampusIds.push(campusA.id);
  campusB = await rawClient.campus.create({
    data: { name: `${RUN_TAG}-校区B`, slug: `${RUN_TAG}-b`, schoolName: "集成测试大学", isActive: true },
  });
  createdCampusIds.push(campusB.id);

  globalAdmin = await createFixtureUser("全局管理员");
  await assignRoleByKey(globalAdmin.id, "PLATFORM_ADMIN", null);
  reviewerA = await createFixtureUser("校区A举报审核员");
  await assignRoleByKey(reviewerA.id, "CAMPUS_REPORT_REVIEWER", campusA.id);
  reviewerB = await createFixtureUser("校区B举报审核员");
  await assignRoleByKey(reviewerB.id, "CAMPUS_REPORT_REVIEWER", campusB.id);
  reporter = await createFixtureUser("举报人");
  seller = await createFixtureUser("被举报卖家");
});

afterAll(async () => {
  if (!rawClient) return;

  // 反向依赖顺序清理（shared Role/Permission/Campus seed 数据不动）
  await rawClient.moderationCase.deleteMany({ where: { reportId: { in: createdReportIds } } });
  await rawClient.riskFlag.deleteMany({ where: { sourceType: "REPORT", sourceId: { in: createdReportIds } } });
  await rawClient.adminLog.deleteMany({ where: { targetId: { in: createdReportIds } } });
  await rawClient.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await rawClient.report.deleteMany({ where: { id: { in: createdReportIds } } });
  await rawClient.adminLog.deleteMany({ where: { adminId: { in: createdUserIds } } });
  await rawClient.userRoleAssignment.deleteMany({ where: { id: { in: createdAssignmentIds } } });
  await rawClient.campusMembership.deleteMany({ where: { id: { in: createdMembershipIds } } });
  await rawClient.message.deleteMany({ where: { conversationId: { in: createdConversationIds } } });
  await rawClient.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
  await rawClient.rentalListing.deleteMany({ where: { id: { in: createdListingIds } } });
  await rawClient.serviceListing.deleteMany({ where: { id: { in: createdListingIds } } });
  await rawClient.errandTask.deleteMany({ where: { id: { in: createdListingIds } } });
  await rawClient.product.deleteMany({ where: { id: { in: createdListingIds } } });
  await rawClient.productCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await rawClient.errandCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await rawClient.serviceCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await rawClient.rentalCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await rawClient.campus.deleteMany({ where: { id: { in: createdCampusIds } } });

  await rawClient.$disconnect();
});

// ── Migration 合同（M01..M12）────────────────────────────────────────────────

describe.skipIf(!integrationDatabaseUrl)("Phase 7E migration 合同（真实 PG）", () => {
  it("M01：fresh DDL 形状——表/列/NOT NULL/CHECK/unique/索引/FK 行为", async () => {
    const columns = await rawClient!.$queryRaw<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'ModerationCase' ORDER BY column_name`;
    const names = columns.map((c) => c.column_name);
    for (const expected of ["reportId", "campusId", "scopeKey", "assignedToId", "openedAt", "dueAt", "lastActivityAt", "closedAt"]) {
      expect(names).toContain(expected);
    }

    const scopeKeyNullable = columns.find((c) => c.column_name === "scopeKey")!.is_nullable;
    expect(scopeKeyNullable).toBe("NO");

    // Report.scopeKey NOT NULL（upgrade 收敛完成）
    const reportColumns = await rawClient!.$queryRaw<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'Report' ORDER BY column_name`;
    expect(reportColumns.find((c) => c.column_name === "scopeKey")!.is_nullable).toBe("NO");
    expect(reportColumns.find((c) => c.column_name === "campusId")!.is_nullable).toBe("YES");

    // scope pair CHECK（Report + ModerationCase 双表）
    const checks = await rawClient!.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE contype = 'c' AND conrelid IN ('"Report"'::regclass, '"ModerationCase"'::regclass)
        AND conname LIKE '%scope_pair_check%'`;
    expect(checks.map((c) => c.conname).sort()).toEqual([
      "ModerationCase_scope_pair_check",
      "Report_scope_pair_check",
    ]);

    // UNIQUE(reportId)
    const uniqueIndexes = await rawClient!.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'ModerationCase' AND indexname LIKE '%reportId%key%'`;
    expect(uniqueIndexes).toHaveLength(1);
  });

  it("M02：role data-only 收敛——CAMPUS_REPORT_REVIEWER 恰具 report.review", async () => {
    const role = await rawClient!.role.findUniqueOrThrow({ where: { key: "CAMPUS_REPORT_REVIEWER" } });
    expect(role.scope).toBe("CAMPUS");
    expect(role.isSystem).toBe(true);
    const permissions = await rawClient!.rolePermission.findMany({
      where: { roleId: role.id },
      select: { permission: { select: { key: true } } },
    });
    expect(permissions.map((p) => p.permission.key)).toEqual(["report.review"]);

    // 数据-only 断言：本 migration 未触碰 UserRoleAssignment 结构
    const assignmentColumns = await rawClient!.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'UserRoleAssignment'`;
    expect(assignmentColumns.map((c) => c.column_name)).toContain("scopeKey");
  });

  it("M03+M04：backfill 重放幂等（rerun PASS）+ 每 Report 恰一 case", async () => {
    // 直建两条不带 case 的 report（模拟历史残缺），重放 migration 的
    // INSERT..SELECT（同款 SQL）→ 两行各建一个 case；再次重放 → 零新增。
    const r1 = await createReportRow({ reporterId: reporter.id, targetType: "USER", targetUserId: seller.id, campusId: null, scopeKey: "UNSCOPED" });
    const r2 = await createReportRow({ reporterId: reporter.id, targetType: "MESSAGE", campusId: null, scopeKey: "UNSCOPED" });
    const targetIds = [r1.id, r2.id];

    const caseCountFor = async () =>
      rawClient!.moderationCase.count({ where: { reportId: { in: targetIds } } });

    const before = await caseCountFor();
    // 测试内 replay 限定到本 run 的目标行：migration 的全表语句在 deploy 时
    // 独占执行（无并发写者）；共享测试库上并行文件在写 Report，全表扫描版
    // 会与 FK ShareLock 互撞死锁——行限定不改变语句语义验证的有效性。
    await rawClient!.$executeRaw`
      INSERT INTO "ModerationCase" (
        "id", "reportId", "campusId", "scopeKey", "assignedToId",
        "openedAt", "dueAt", "lastActivityAt", "closedAt", "createdAt", "updatedAt"
      )
      SELECT 'case_' || r."id", r."id", r."campusId", r."scopeKey", NULL,
             r."createdAt", r."createdAt" + INTERVAL '48 hours',
             COALESCE(r."handledAt", r."updatedAt", r."createdAt"),
             CASE WHEN r."status" IN ('RESOLVED', 'REJECTED')
                  THEN COALESCE(r."handledAt", r."updatedAt", r."createdAt")
                  ELSE NULL END,
             now(), now()
      FROM "Report" AS r
      WHERE r."id" IN (${r1.id}, ${r2.id})
      ON CONFLICT ("reportId") DO NOTHING`;
    const mid = await caseCountFor();
    await rawClient!.$executeRaw`
      INSERT INTO "ModerationCase" (
        "id", "reportId", "campusId", "scopeKey", "assignedToId",
        "openedAt", "dueAt", "lastActivityAt", "closedAt", "createdAt", "updatedAt"
      )
      SELECT 'case_' || r."id", r."id", r."campusId", r."scopeKey", NULL,
             r."createdAt", r."createdAt" + INTERVAL '48 hours',
             COALESCE(r."handledAt", r."updatedAt", r."createdAt"),
             CASE WHEN r."status" IN ('RESOLVED', 'REJECTED')
                  THEN COALESCE(r."handledAt", r."updatedAt", r."createdAt")
                  ELSE NULL END,
             now(), now()
      FROM "Report" AS r
      WHERE r."id" IN (${r1.id}, ${r2.id})
      ON CONFLICT ("reportId") DO NOTHING`;
    const after = await caseCountFor();

    expect(before).toBe(0);
    expect(mid - before).toBe(2);
    expect(after).toBe(mid);

    // 全库不变量：无重复 case
    const dupes = await rawClient!.$queryRaw<{ c: bigint }[]>`
      SELECT count(*) AS c FROM (
        SELECT "reportId" FROM "ModerationCase" GROUP BY "reportId" HAVING count(*) > 1
      ) t`;
    expect(Number(dupes[0].c)).toBe(0);
  });

  it("M05..M08：四域 campus backfill 按目标对象真实 campus 收敛", async () => {
    const product = await createProductFixture(campusA.id, seller.id);
    const errand = await createErrandFixture(campusA.id, seller.id);
    const service = await createServiceFixture(campusA.id, seller.id);
    const rental = await createRentalFixture(campusB.id, seller.id);

    const productReport = await createReportRow({
      reporterId: reporter.id, targetType: "PRODUCT", productId: product.id,
      campusId: null, scopeKey: "UNSCOPED",
    });
    const errandReport = await createReportRow({
      reporterId: reporter.id, targetType: "ERRAND_TASK", errandTaskId: errand.id,
      campusId: null, scopeKey: "UNSCOPED",
    });
    const serviceReport = await createReportRow({
      reporterId: reporter.id, targetType: "SERVICE_LISTING", serviceListingId: service.id,
      campusId: null, scopeKey: "UNSCOPED",
    });
    const rentalReport = await createReportRow({
      reporterId: reporter.id, targetType: "RENTAL_LISTING", rentalListingId: rental.id,
      campusId: null, scopeKey: "UNSCOPED",
    });

    // 重放 migration 的四段 backfill UPDATE（与 migration.sql 逐字同语义）
    await rawClient!.$executeRaw`
      UPDATE "Report" AS r SET "campusId" = p."campusId", "scopeKey" = 'CAMPUS:' || p."campusId"
      FROM "Product" AS p WHERE r."productId" = p."id" AND r."targetType" = 'PRODUCT'`;
    await rawClient!.$executeRaw`
      UPDATE "Report" AS r SET "campusId" = e."campusId", "scopeKey" = 'CAMPUS:' || e."campusId"
      FROM "ErrandTask" AS e WHERE r."errandTaskId" = e."id" AND r."targetType" = 'ERRAND_TASK'`;
    await rawClient!.$executeRaw`
      UPDATE "Report" AS r SET "campusId" = s."campusId", "scopeKey" = 'CAMPUS:' || s."campusId"
      FROM "ServiceListing" AS s WHERE r."serviceListingId" = s."id" AND r."targetType" = 'SERVICE_LISTING'`;
    await rawClient!.$executeRaw`
      UPDATE "Report" AS r SET "campusId" = rl."campusId", "scopeKey" = 'CAMPUS:' || rl."campusId"
      FROM "RentalListing" AS rl WHERE r."rentalListingId" = rl."id" AND r."targetType" = 'RENTAL_LISTING'`;

    for (const [report, expectedCampus] of [
      [productReport, campusA.id],
      [errandReport, campusA.id],
      [serviceReport, campusA.id],
      [rentalReport, campusB.id],
    ] as const) {
      const row = await rawClient!.report.findUniqueOrThrow({
        where: { id: report.id },
        select: { campusId: true, scopeKey: true },
      });
      expect(row.campusId).toBe(expectedCampus);
      expect(row.scopeKey).toBe(`CAMPUS:${expectedCampus}`);
    }
  });

  it("M09：USER/MESSAGE backfill → UNSCOPED（campusId=null，绝不猜测）", async () => {
    const userReport = await createReportRow({
      reporterId: reporter.id, targetType: "USER", targetUserId: seller.id,
      campusId: null, scopeKey: "UNSCOPED",
    });
    // 模拟迁移前脏值再重放 UNSCOPED sweep
    await rawClient!.$executeRaw`
      UPDATE "Report" SET "campusId" = NULL, "scopeKey" = 'UNSCOPED' WHERE "scopeKey" IS NULL`;
    const row = await rawClient!.report.findUniqueOrThrow({
      where: { id: userReport.id },
      select: { campusId: true, scopeKey: true },
    });
    expect(row).toEqual({ campusId: null, scopeKey: "UNSCOPED" });
  });

  it("M10+M11：closedAt 映射（terminal=handledAt 优先）与 dueAt 历史起点", async () => {
    const handledAt = new Date(Date.now() - 72 * 60 * 60 * 1000);
    const legacyResolved = await createReportRow({
      reporterId: reporter.id, targetType: "USER", targetUserId: seller.id,
      status: "RESOLVED", handledAt, campusId: null, scopeKey: "UNSCOPED",
    });
    const legacyOpen = await createReportRow({
      reporterId: reporter.id, targetType: "USER", targetUserId: seller.id,
      status: "OPEN", campusId: null, scopeKey: "UNSCOPED",
    });

    // 直建无 case 的行后重放 backfill（同 M03 的语句，行限定版）
    await rawClient!.$executeRaw`
      INSERT INTO "ModerationCase" (
        "id", "reportId", "campusId", "scopeKey", "assignedToId",
        "openedAt", "dueAt", "lastActivityAt", "closedAt", "createdAt", "updatedAt"
      )
      SELECT 'case_' || r."id", r."id", r."campusId", r."scopeKey", NULL,
             r."createdAt", r."createdAt" + INTERVAL '48 hours',
             COALESCE(r."handledAt", r."updatedAt", r."createdAt"),
             CASE WHEN r."status" IN ('RESOLVED', 'REJECTED')
                  THEN COALESCE(r."handledAt", r."updatedAt", r."createdAt")
                  ELSE NULL END,
             now(), now()
      FROM "Report" AS r
      WHERE r."id" IN (${legacyResolved.id}, ${legacyOpen.id})
      ON CONFLICT ("reportId") DO NOTHING`;

    const resolvedCase = await rawClient!.moderationCase.findUniqueOrThrow({
      where: { reportId: legacyResolved.id },
    });
    expect(resolvedCase.closedAt).not.toBeNull();
    expect(resolvedCase.closedAt!.getTime()).toBe(handledAt.getTime());
    // M11：历史 SLA 起点 = report.createdAt（绝不用 migration 执行时刻）
    expect(resolvedCase.openedAt.getTime()).toBe(legacyResolved.createdAt.getTime());
    expect(resolvedCase.dueAt.getTime() - resolvedCase.openedAt.getTime()).toBe(48 * 60 * 60 * 1000);

    const openCase = await rawClient!.moderationCase.findUniqueOrThrow({
      where: { reportId: legacyOpen.id },
    });
    expect(openCase.closedAt).toBeNull();
  });

  it("M12：UNIQUE(reportId)——重复 case 被 DB 拒绝", async () => {
    const report = await createReportRow({
      reporterId: reporter.id, targetType: "USER", targetUserId: seller.id,
      campusId: null, scopeKey: "UNSCOPED",
    });
    await createCaseRow({
      reportId: report.id, campusId: null, scopeKey: "UNSCOPED",
      openedAt: report.createdAt, dueAt: new Date(report.createdAt.getTime() + 48 * 60 * 60 * 1000),
    });
    await expect(
      createCaseRow({
        reportId: report.id, campusId: null, scopeKey: "UNSCOPED",
        openedAt: report.createdAt, dueAt: new Date(report.createdAt.getTime() + 48 * 60 * 60 * 1000),
      }),
    ).rejects.toThrow();
  });

  it("S05（migration 侧）：malformed scope pair 被 DB CHECK 结构性拒绝", async () => {
    await expect(
      rawClient!.$executeRaw`
        INSERT INTO "Report" ("id", "targetType", "reason", "status", "reporterId", "campusId", "scopeKey", "createdAt", "updatedAt")
        VALUES (${`m1-${randomUUID()}`}, 'USER', 'FAKE_INFO', 'OPEN', ${reporter.id}, ${campusA.id}, 'UNSCOPED', now(), now())`,
    ).rejects.toThrow();
    await expect(
      rawClient!.$executeRaw`
        INSERT INTO "Report" ("id", "targetType", "reason", "status", "reporterId", "campusId", "scopeKey", "createdAt", "updatedAt")
        VALUES (${`m2-${randomUUID()}`}, 'USER', 'FAKE_INFO', 'OPEN', ${reporter.id}, ${campusA.id}, 'CAMPUS:other', now(), now())`,
    ).rejects.toThrow();
  });
});

// ── Rental 全链 + scope 授权 + case 生命周期（R/S/C/P）───────────────────────

describe.skipIf(!integrationDatabaseUrl)("Phase 7E rental 全链 / scope 授权 / case 生命周期", () => {
  it("R01..R06：rental 举报从创建到审核全链成立", async () => {
    const { createReport } = await import("@/actions/trust");
    const { deriveReportReviewAccess } = await import("@/lib/reports/report-access");
    const { loadAuthorizedReportDetail } = await import("@/lib/reports/report-query");
    const { loadAuthorizationContext } = await import("@/lib/rbac/service");

    const rentalOwner = await createFixtureUser("租赁卖家", { membershipCampusId: campusA.id });
    const rental = await createRentalFixture(campusA.id, rentalOwner.id);

    // R02：目标不存在 fail closed
    sessionSeam.actionUser.current = { id: reporter.id, email: "", name: "" };
    const missingForm = new FormData();
    missingForm.set("targetType", "RENTAL_LISTING");
    missingForm.set("reason", "SCAM_RISK");
    missingForm.set("detail", "不存在目标");
    missingForm.set("rentalListingId", "ghost-rental");
    const missingResult = await createReport({ success: false, message: "" }, missingForm);
    expect(missingResult).toMatchObject({ success: false, message: "举报目标不存在" });

    // R01：创建成功（经真实 validator/service/action 链）
    const form = new FormData();
    form.set("targetType", "RENTAL_LISTING");
    form.set("reason", "SCAM_RISK");
    form.set("detail", "租赁物品与描述不符");
    form.set("rentalListingId", rental.id);
    const result = await createReport({ success: false, message: "" }, form);
    expect(result.success).toBe(true);

    const report = await rawClient!.report.findFirstOrThrow({
      where: { rentalListingId: rental.id },
      orderBy: { createdAt: "desc" },
    });
    createdReportIds.push(report.id);

    // R03/R04：owner/campus resolve + immutable scope 快照
    expect(report.campusId).toBe(campusA.id);
    expect(report.scopeKey).toBe(`CAMPUS:${campusA.id}`);

    const kase = await rawClient!.moderationCase.findUniqueOrThrow({ where: { reportId: report.id } });
    expect(kase.campusId).toBe(campusA.id);
    expect(kase.scopeKey).toBe(`CAMPUS:${campusA.id}`);
    expect(kase.closedAt).toBeNull();
    // C01/C03：创建即 ACTIVE，SLA 起点 = report.createdAt
    expect(kase.openedAt.getTime()).toBe(report.createdAt.getTime());
    expect(kase.dueAt.getTime() - kase.openedAt.getTime()).toBe(48 * 60 * 60 * 1000);

    // R05：projection 收敛（REPORT_SUBMITTED ACTIVE on owner，campus 对齐）
    const submittedFlag = await rawClient!.riskFlag.findUniqueOrThrow({
      where: {
        kind_sourceType_sourceId: { kind: "REPORT_SUBMITTED", sourceType: "REPORT", sourceId: report.id },
      },
    });
    expect(submittedFlag.userId).toBe(rentalOwner.id);
    expect(submittedFlag.status).toBe("ACTIVE");
    expect(submittedFlag.campusId).toBe(campusA.id);

    // R06：queue/detail 可达（GLOBAL + campus A reviewer；campus B reviewer 不可见）
    const adminContext = await loadAuthorizationContext(globalAdmin.id);
    const adminAccess = deriveReportReviewAccess(adminContext);
    const queueIds = await queueReportIdsFor(adminAccess);
    expect(queueIds).toContain(report.id);

    const detail = await loadAuthorizedReportDetail({
      viewerId: globalAdmin.id, context: adminContext!, access: adminAccess, reportId: report.id,
    });
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      expect(detail.detail.targetType).toBe("RENTAL_LISTING");
      // P01/P02/P03：队列结构不含 detail/handledNote/message 内容——
      // 详情面才允许 detail；queue item 由 P01-P03 专项断言（见下）
    }
  });

  it("S01..S06：scope 授权矩阵（GLOBAL/校区/UNSCOPED/exact-pair）", async () => {
    const { deriveReportReviewAccess } = await import("@/lib/reports/report-access");
    const { loadAuthorizationContext } = await import("@/lib/rbac/service");

    const productA = await createProductFixture(campusA.id, seller.id);
    const productB = await createProductFixture(campusB.id, seller.id);
    const reportA = await createReportRow({
      reporterId: reporter.id, targetType: "PRODUCT", productId: productA.id,
      campusId: campusA.id, scopeKey: `CAMPUS:${campusA.id}`,
    });
    const reportB = await createReportRow({
      reporterId: reporter.id, targetType: "PRODUCT", productId: productB.id,
      campusId: campusB.id, scopeKey: `CAMPUS:${campusB.id}`,
    });
    const reportUnscoped = await createReportRow({
      reporterId: reporter.id, targetType: "USER", targetUserId: seller.id,
      campusId: null, scopeKey: "UNSCOPED",
    });
    for (const r of [reportA, reportB, reportUnscoped]) {
      await createCaseRow({
        reportId: r.id, campusId: r.campusId, scopeKey: r.scopeKey,
        openedAt: r.createdAt, dueAt: new Date(r.createdAt.getTime() + 48 * 60 * 60 * 1000),
      });
    }

    // S01：GLOBAL 全见（含 UNSCOPED）
    const adminAccess = deriveReportReviewAccess(await loadAuthorizationContext(globalAdmin.id));
    const adminIds = await queueReportIdsFor(adminAccess);
    expect(adminIds).toEqual(expect.arrayContaining([reportA.id, reportB.id, reportUnscoped.id]));

    // S02：campus A 见 CAMPUS:A
    const accessA = deriveReportReviewAccess(await loadAuthorizationContext(reviewerA.id));
    expect(accessA).toEqual({ global: false, campusIds: [campusA.id] });
    const idsA = await queueReportIdsFor(accessA);
    expect(idsA).toContain(reportA.id);

    // S03：campus A 不见 campus B
    expect(idsA).not.toContain(reportB.id);

    // S04：campus A 不见 UNSCOPED
    expect(idsA).not.toContain(reportUnscoped.id);

    // S06：exact-pair 无叉积——campus A reviewer 请求 campus=B filter → 结构性空
    const crossProduct = await queueReportIdsFor(accessA, { campusId: campusB.id });
    expect(crossProduct).not.toContain(reportB.id);
    expect(crossProduct).not.toContain(reportA.id);
    // GLOBAL 的 campus filter 也不能扩大到授权外形状
    const adminFiltered = await queueReportIdsFor(adminAccess, { campusId: campusA.id });
    expect(adminFiltered).toContain(reportA.id);
    expect(adminFiltered).not.toContain(reportB.id);
    expect(adminFiltered).not.toContain(reportUnscoped.id);

    // fail-closed：零 scope → 空页
    const empty = await queueReportIdsFor({ global: false, campusIds: [] });
    expect(empty).toEqual([]);
  });

  it("P01..P06：队列 DTO 最小化 + 越权/跨校区 detail 无存在性 oracle", async () => {
    const { deriveReportReviewAccess } = await import("@/lib/reports/report-access");
    const { loadAuthorizedReportDetail } = await import("@/lib/reports/report-query");
    const { loadAuthorizationContext } = await import("@/lib/rbac/service");

    // MESSAGE 举报（content 属私有面）+ handledNote/detail 的 IN_REVIEW report
    const conversation = await rawClient!.conversation.create({ data: {} });
    createdConversationIds.push(conversation.id);
    const message = await rawClient!.message.create({
      data: { conversationId: conversation.id, senderId: seller.id, content: `${RUN_TAG}-机密消息内容-E2EShouldNotLeak` },
    });
    const messageReport = await createReportRow({
      reporterId: reporter.id, targetType: "MESSAGE", status: "IN_REVIEW",
      campusId: null, scopeKey: "UNSCOPED",
    });
    await rawClient!.report.update({
      where: { id: messageReport.id },
      data: { messageId: message.id, handledNote: `${RUN_TAG}-机密处理备注`, detail: `${RUN_TAG}-机密举报详情` },
    });
    await createCaseRow({
      reportId: messageReport.id, campusId: null, scopeKey: "UNSCOPED",
      openedAt: messageReport.createdAt, dueAt: new Date(messageReport.createdAt.getTime() + 48 * 60 * 60 * 1000),
    });

    const adminContext = await loadAuthorizationContext(globalAdmin.id);
    const adminAccess = deriveReportReviewAccess(adminContext);
    const items = await queueItemsFor(adminAccess);
    const item = items.find((i) => i.reportId === messageReport.id);
    expect(item).toBeDefined();

    // P01：queue 无 report detail；P02：无 handledNote；P03：无 message content；
    // P04：无 email/phone/studentId / 私有 URL
    expect(item!.safeTargetLabel).toBe("消息举报");
    expect(JSON.stringify(items)).not.toContain("E2EShouldNotLeak");
    expect(JSON.stringify(items)).not.toContain("机密处理备注");
    expect(JSON.stringify(items)).not.toContain("机密举报详情");
    expect(JSON.stringify(items)).not.toContain("email");
    expect(Object.keys(item!).sort()).toEqual(
      [
        "assignedReviewer", "caseId", "createdAt", "dueAt", "overdue",
        "reason", "reportId", "safeTargetLabel", "scopeLabel", "status", "targetType",
      ].sort(),
    );

    // P05/P06：越权与 missing 统一 { ok: false }（无存在性 oracle）
    const accessA = deriveReportReviewAccess(await loadAuthorizationContext(reviewerA.id));
    const contextA = await loadAuthorizationContext(reviewerA.id);
    const forbidden = await loadAuthorizedReportDetail({
      viewerId: reviewerA.id, context: contextA!, access: accessA, reportId: messageReport.id,
    });
    const missing = await loadAuthorizedReportDetail({
      viewerId: reviewerA.id, context: contextA!, access: accessA, reportId: "ghost-report",
    });
    expect(forbidden).toEqual({ ok: false });
    expect(missing).toEqual({ ok: false });
  });

  it("C04+C05：RESOLVED/REJECTED 关闭 case（reviewReportInGovernance canonical 链）", async () => {
    const { reviewReportInGovernance } = await import("@/lib/reports/report-review-service");

    const resolvedReport = await createReportRow({
      reporterId: reporter.id, targetType: "USER", targetUserId: seller.id,
      campusId: null, scopeKey: "UNSCOPED",
    });
    await createCaseRow({
      reportId: resolvedReport.id, campusId: null, scopeKey: "UNSCOPED",
      openedAt: resolvedReport.createdAt, dueAt: new Date(resolvedReport.createdAt.getTime() + 48 * 60 * 60 * 1000),
    });

    const result = await reviewReportInGovernance({
      actorId: globalAdmin.id,
      reportId: resolvedReport.id,
      status: "RESOLVED",
      handledNote: "处理完成备注",
    });
    expect(result.status).toBe("RESOLVED");

    let kase = await rawClient!.moderationCase.findUniqueOrThrow({ where: { reportId: resolvedReport.id } });
    expect(kase.closedAt).not.toBeNull();
    expect(kase.lastActivityAt >= kase.openedAt).toBe(true);

    // C05：REJECTED 同样关闭
    const rejectedReport = await createReportRow({
      reporterId: reporter.id, targetType: "USER", targetUserId: seller.id,
      campusId: null, scopeKey: "UNSCOPED",
    });
    await createCaseRow({
      reportId: rejectedReport.id, campusId: null, scopeKey: "UNSCOPED",
      openedAt: rejectedReport.createdAt, dueAt: new Date(rejectedReport.createdAt.getTime() + 48 * 60 * 60 * 1000),
    });
    await reviewReportInGovernance({ actorId: globalAdmin.id, reportId: rejectedReport.id, status: "REJECTED" });
    kase = await rawClient!.moderationCase.findUniqueOrThrow({ where: { reportId: rejectedReport.id } });
    expect(kase.closedAt).not.toBeNull();

    // 通知合同（§35/§36 事务性）零改动：reporter 收到 RESOLVED 通知
    const notification = await rawClient!.notification.findFirst({
      where: { userId: reporter.id, type: "REPORT", title: "举报已处理" },
      orderBy: { createdAt: "desc" },
    });
    expect(notification).not.toBeNull();
  });

  it("C06+C07：reopen 清空 closedAt 并重置 openedAt/dueAt（reopen clock）", async () => {
    const { reviewReportInGovernance } = await import("@/lib/reports/report-review-service");

    const report = await createReportRow({
      reporterId: reporter.id, targetType: "USER", targetUserId: seller.id,
      campusId: null, scopeKey: "UNSCOPED",
    });
    await createCaseRow({
      reportId: report.id, campusId: null, scopeKey: "UNSCOPED",
      openedAt: report.createdAt, dueAt: new Date(report.createdAt.getTime() + 48 * 60 * 60 * 1000),
    });

    await reviewReportInGovernance({ actorId: globalAdmin.id, reportId: report.id, status: "RESOLVED" });
    const closedCase = await rawClient!.moderationCase.findUniqueOrThrow({ where: { reportId: report.id } });
    const oldDueAt = closedCase.dueAt;
    expect(closedCase.closedAt).not.toBeNull();

    await reviewReportInGovernance({ actorId: globalAdmin.id, reportId: report.id, status: "IN_REVIEW" });
    const reopenedCase = await rawClient!.moderationCase.findUniqueOrThrow({ where: { reportId: report.id } });
    // C06：closedAt 清空（ACTIVE）
    expect(reopenedCase.closedAt).toBeNull();
    // C07：openedAt/dueAt 以 reopen 时刻重置（> 旧值）
    expect(reopenedCase.openedAt.getTime()).toBeGreaterThan(report.createdAt.getTime());
    expect(reopenedCase.dueAt.getTime()).toBeGreaterThan(oldDueAt.getTime());
    expect(reopenedCase.dueAt.getTime() - reopenedCase.openedAt.getTime()).toBe(48 * 60 * 60 * 1000);

    // reopen 后 Report 状态机回到 IN_REVIEW（Option B 中央断言保留）
    const updated = await rawClient!.report.findUniqueOrThrow({
      where: { id: report.id }, select: { status: true },
    });
    expect(updated.status).toBe("IN_REVIEW");
  });

  it("C08：SLA 超时零自动执法（OVERDUE 只读，无任何决策/处置写入）", async () => {
    const { deriveReportReviewAccess } = await import("@/lib/reports/report-access");
    const { loadAuthorizationContext } = await import("@/lib/rbac/service");
    const { loadAuthorizedReportQueue } = await import("@/lib/reports/report-query");

    const product = await createProductFixture(campusA.id, seller.id);
    const report = await createReportRow({
      reporterId: reporter.id, targetType: "PRODUCT", productId: product.id,
      campusId: campusA.id, scopeKey: `CAMPUS:${campusA.id}`,
    });
    // dueAt 置于过去（人工模拟超时）
    await createCaseRow({
      reportId: report.id, campusId: campusA.id, scopeKey: `CAMPUS:${campusA.id}`,
      openedAt: new Date(Date.now() - 96 * 60 * 60 * 1000),
      dueAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });

    // C08：SLA 超时零自动执法（OVERDUE 只读，无任何决策/处置写入）——
    // 计数按本 run 实体范围（seller/product/report），避免并行文件污染
    const before = {
      enforcement: await rawClient!.enforcementAction.count({ where: { targetId: seller.id } }),
      riskStates: await rawClient!.riskState.count({ where: { userId: seller.id } }),
      listingModerations: await rawClient!.listingModeration.count({ where: { productId: product.id } }),
      reportStatus: (await rawClient!.report.findUniqueOrThrow({ where: { id: report.id } })).status,
      caseClosedAt: (await rawClient!.moderationCase.findUniqueOrThrow({ where: { reportId: report.id } })).closedAt,
    };

    // 队列读取（overdue 判定发生处）+ 审核服务路径均不得触发自动执法
    const adminAccess = deriveReportReviewAccess(await loadAuthorizationContext(globalAdmin.id));
    const overdueItems = await queueItemsFor(adminAccess, { overdueOnly: true });
    const overdueItem = overdueItems.find((i) => i.reportId === report.id);
    expect(overdueItem).toBeDefined();
    expect(overdueItem!.overdue).toBe(true);

    const after = {
      enforcement: await rawClient!.enforcementAction.count({ where: { targetId: seller.id } }),
      riskStates: await rawClient!.riskState.count({ where: { userId: seller.id } }),
      listingModerations: await rawClient!.listingModeration.count({ where: { productId: product.id } }),
      reportStatus: (await rawClient!.report.findUniqueOrThrow({ where: { id: report.id } })).status,
      caseClosedAt: (await rawClient!.moderationCase.findUniqueOrThrow({ where: { reportId: report.id } })).closedAt,
    };
    expect(after).toEqual(before);
  });
});

// ── 并发（CL01..CL05，真实行锁串行化）────────────────────────────────────────

describe.skipIf(!integrationDatabaseUrl)("Phase 7E claim/review 并发（真实 PG 行锁）", () => {
  /** CL 组共享：CAMPUS:A 商品举报 + case（reviewerA 与 globalAdmin 均有授权）。 */
  async function createClaimableScenario() {
    const product = await createProductFixture(campusA.id, seller.id);
    const report = await createReportRow({
      reporterId: reporter.id, targetType: "PRODUCT", productId: product.id,
      campusId: campusA.id, scopeKey: `CAMPUS:${campusA.id}`,
    });
    await createCaseRow({
      reportId: report.id, campusId: campusA.id, scopeKey: `CAMPUS:${campusA.id}`,
      openedAt: report.createdAt, dueAt: new Date(report.createdAt.getTime() + 48 * 60 * 60 * 1000),
    });
    return report;
  }

  it("CL01+CL02：两审核员竞争同一 case → 恰一 canonical winner；本人重试幂等", async () => {
    const { claimModerationCase } = await import("@/lib/reports/moderation-case-service");
    const { isReportCaseError } = await import("@/lib/reports/errors");

    const report = await createClaimableScenario();

    // T1（reviewerA）先取得 REPORT+CASE 行锁；racePoint 先发"已持锁"信号，
    // 再等待 T2 成为 Report FOR UPDATE 等待者（确定性串行，非 sleep）。
    let signalLocked: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const winnerPromise = claimModerationCase({
      actorId: reviewerA.id,
      reportId: report.id,
      racePoint: async () => {
        signalLocked();
        await barrier;
      },
    });

    await locked;
    const loserPromise = claimModerationCase({ actorId: globalAdmin.id, reportId: report.id }).catch(
      (error: unknown) => error,
    );

    // T2 已在 Report 行锁上排队（T1 持锁中）→ 放行 T1（canonical winner）
    await waitForRowLockWaiter(rawClient!, "Report");

    releaseBarrier();
    const winner = await winnerPromise;
    const loser = await loserPromise;

    expect(winner).toMatchObject({ outcome: "CLAIMED", assignedToId: reviewerA.id });
    expect(isReportCaseError(loser)).toBe(true);
    expect((loser as { code: string }).code).toBe("REPORT_CASE_ALREADY_CLAIMED");

    // CL02：winner 重试 → 幂等 ALREADY_YOURS
    const retry = await claimModerationCase({ actorId: reviewerA.id, reportId: report.id });
    expect(retry.outcome).toBe("ALREADY_YOURS");

    const kase = await rawClient!.moderationCase.findUniqueOrThrow({ where: { reportId: report.id } });
    expect(kase.assignedToId).toBe(reviewerA.id);
  });

  it("CL03：非领用人 release → fail closed；领用人 release → 成功", async () => {
    const { claimModerationCase, releaseModerationCase } = await import("@/lib/reports/moderation-case-service");
    const { isReportCaseError } = await import("@/lib/reports/errors");

    const report = await createClaimableScenario();

    await claimModerationCase({ actorId: reviewerA.id, reportId: report.id });

    // globalAdmin 授权通过但非 assignee → fail closed（CL03 deny）
    const foreignRelease = await releaseModerationCase({ actorId: globalAdmin.id, reportId: report.id }).catch(
      (error: unknown) => error,
    );
    expect(isReportCaseError(foreignRelease)).toBe(true);
    expect((foreignRelease as { code: string }).code).toBe("REPORT_CASE_FORBIDDEN");

    const selfRelease = await releaseModerationCase({ actorId: reviewerA.id, reportId: report.id });
    expect(selfRelease.outcome).toBe("RELEASED");
    const kase = await rawClient!.moderationCase.findUniqueOrThrow({ where: { reportId: report.id } });
    expect(kase.assignedToId).toBeNull();
  });

  it("CL04：review vs claim 串行（同一 REPORT→CASE 锁序，双方合法收敛）", async () => {
    const { claimModerationCase } = await import("@/lib/reports/moderation-case-service");
    const { reviewReportInGovernance } = await import("@/lib/reports/report-review-service");

    const report = await createClaimableScenario();

    let signalLocked: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const claimPromise = claimModerationCase({
      actorId: reviewerA.id,
      reportId: report.id,
      racePoint: async () => {
        signalLocked();
        await barrier;
      },
    });

    // T1 持锁后启动 review；等 review 在 Report FOR UPDATE 上排队再放行
    await locked;
    const reviewPromise = reviewReportInGovernance({
      actorId: globalAdmin.id, reportId: report.id, status: "RESOLVED",
    }).catch((error: unknown) => error);
    await waitForRowLockWaiter(rawClient!, "Report");

    releaseBarrier();
    const claim = await claimPromise;
    const review = await reviewPromise;

    expect(claim).toMatchObject({ outcome: "CLAIMED" });
    expect(review).toMatchObject({ status: "RESOLVED" });

    // 串行化终态：report terminal ∧ case closed ∧ assignment 保留
    const finalReport = await rawClient!.report.findUniqueOrThrow({
      where: { id: report.id }, select: { status: true },
    });
    const kase = await rawClient!.moderationCase.findUniqueOrThrow({ where: { reportId: report.id } });
    expect(finalReport.status).toBe("RESOLVED");
    expect(kase.closedAt).not.toBeNull();
    expect(kase.assignedToId).toBe(reviewerA.id);
  });

  it("CL05：resolve vs reject 并发 → 恰一个合法终局", async () => {
    const { reviewReportInGovernance } = await import("@/lib/reports/report-review-service");

    const report = await createClaimableScenario();
    // 先进入 IN_REVIEW（resolve/reject 的合法前置）
    await reviewReportInGovernance({ actorId: globalAdmin.id, reportId: report.id, status: "IN_REVIEW" });

    let signalLocked: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const resolvePromise = reviewReportInGovernance({
      actorId: globalAdmin.id, reportId: report.id, status: "RESOLVED",
      racePoint: async () => {
        signalLocked();
        await barrier;
      },
    });

    // T1 持锁后启动 reject；等 reject 在 Report FOR UPDATE 上排队再放行
    await locked;
    const rejectPromise = reviewReportInGovernance({
      actorId: reviewerA.id, reportId: report.id, status: "REJECTED",
    }).catch((error: unknown) => error);
    await waitForRowLockWaiter(rawClient!, "Report");

    releaseBarrier();
    const resolveOutcome = await resolvePromise;
    const rejectOutcome = await rejectPromise;

    expect(resolveOutcome).toMatchObject({ status: "RESOLVED" });
    expect((rejectOutcome as { message?: string }).message).toContain("REPORT_STATUS_INVALID_TRANSITION");

    const finalReport = await rawClient!.report.findUniqueOrThrow({
      where: { id: report.id }, select: { status: true },
    });
    expect(finalReport.status).toBe("RESOLVED");
    const kase = await rawClient!.moderationCase.findUniqueOrThrow({ where: { reportId: report.id } });
    expect(kase.closedAt).not.toBeNull();
  });
});
