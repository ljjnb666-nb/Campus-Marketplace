import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p7h-${randomUUID().slice(0, 8)}`;
const FIXTURE_PASSWORD_HASH = ["$2a$10$", "itfixtureitfixtureitfixtureitfixtureitfix"].join("");

const createdUserIds: string[] = [];
const createdCampusIds: string[] = [];
const createdMembershipIds: string[] = [];
const createdAssignmentIds: string[] = [];
const createdVerificationIds: string[] = [];
const createdTicketIds: string[] = [];
const createdReportIds: string[] = [];
const createdCaseIds: string[] = [];
const createdAppealIds: string[] = [];
const createdEnforcementIds: string[] = [];
const createdDisputeIds: string[] = [];
const createdOrderIds: string[] = [];
const createdListingIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdPolicyIds: string[] = [];
// User.campusId 必填投影字段的默认校区（beforeAll 中指向 campusA）
let projectionCampusId = "";

// 与 phase7a（BOUNDARY+7M）严格不相交的合成 seq 值段（vitest 并行文件共用同一 DB；
// 本地基线取高位段，规避历史本地运行残留在低位段的可能）
const BOUNDARY = BigInt(1_000_000_000);
const SYNTHETIC_SEQ_BASE = BOUNDARY + BigInt(21_000_000);
let syntheticSeqCursor = 0;
function nextSyntheticSeq(): bigint {
  syntheticSeqCursor += 1;
  return SYNTHETIC_SEQ_BASE + BigInt(syntheticSeqCursor);
}

const GOVERNANCE_LOCK_NAMESPACE = 730_501;
const POLICY_LOCK_NAMESPACE = 730_502;

/** NO_40P01：任何拒绝原因都不得是 PG serialization failure。 */
function assertNoSerializationFailure(errors: unknown[]) {
  for (const error of errors) {
    const message = String((error as Error)?.message ?? error);
    expect(message).not.toContain("40P01");
    expect(message).not.toContain("deadlock detected");
  }
}

function errorCodeOf(error: unknown): string {
  return (error as { code?: string })?.code ?? "";
}

// ── fixture helpers ──────────────────────────────────────────────────────────

async function createFixtureCampus(name: string, options: { isActive?: boolean } = {}) {
  const campus = await rawClient!.campus.create({
    data: {
      name,
      slug: `${RUN_TAG}-${name.toLowerCase()}-${createdCampusIds.length}`,
      schoolName: "集成测试大学",
      isActive: options.isActive ?? true,
    },
  });
  createdCampusIds.push(campus.id);
  return campus;
}

async function createFixtureUser(
  name: string,
  options: { membershipCampusId?: string | null; membershipStatus?: string; status?: string } = {},
) {
  const user = await rawClient!.user.create({
    data: {
      email: `${RUN_TAG}-${createdUserIds.length}-${name}@it.local`,
      name,
      passwordHash: FIXTURE_PASSWORD_HASH,
      schoolName: "集成测试大学",
      // User.campusId 是必填投影字段（授权恒走 membership/grant，绝不读它判权）
      campusId: projectionCampusId,
      role: "STUDENT",
      status: (options.status ?? "ACTIVE") as never,
    },
  });
  createdUserIds.push(user.id);
  const membershipCampusId =
    options.membershipCampusId === undefined ? null : options.membershipCampusId;
  if (membershipCampusId) {
    const membership = await rawClient!.campusMembership.create({
      data: {
        userId: user.id,
        campusId: membershipCampusId,
        status: (options.membershipStatus ?? "ACTIVE") as never,
      },
    });
    createdMembershipIds.push(membership.id);
  }
  return user;
}

async function assignRoleByKey(userId: string, roleKey: string, campusId?: string) {
  const role = await rawClient!.role.findFirstOrThrow({ where: { key: roleKey } });
  const assignment = await rawClient!.userRoleAssignment.create({
    data: {
      userId,
      roleId: role.id,
      campusId: campusId ?? null,
      scopeKey: campusId ? `CAMPUS:${campusId}` : "GLOBAL",
    },
  });
  createdAssignmentIds.push(assignment.id);
  return assignment;
}

/**
 * 本轮专属自定义角色（RUN_TAG 唯一键）：7H fixture 一律不使用系统角色键，
 * 避免与其它 phase 集成文件对系统角色 UserRoleAssignment 的全局零断言
 * （如 7F RB03）在 vitest 文件级并行下产生跨文件计数竞态。
 */
async function grantCustomRole(
  userId: string,
  permissionKeys: readonly string[],
  campusId?: string,
) {
  const role = await rawClient!.role.create({
    data: {
      key: `P7H_CUSTOM_${RUN_TAG}_${createdRoleSeq++}`,
      name: "p7h 自定义角色",
      scope: campusId ? "CAMPUS" : "GLOBAL",
      isSystem: false,
    },
  });
  createdRoleIds.push(role.id);
  const permissions = await rawClient!.permission.findMany({
    where: { key: { in: [...permissionKeys] } },
  });
  for (const permission of permissions) {
    await rawClient!.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
  }
  const assignment = await rawClient!.userRoleAssignment.create({
    data: {
      userId,
      roleId: role.id,
      campusId: campusId ?? null,
      scopeKey: campusId ? `CAMPUS:${campusId}` : "GLOBAL",
    },
  });
  createdAssignmentIds.push(assignment.id);
  return assignment;
}

async function grantRawCampusManage(userId: string, campusId: string) {
  // 误配形状：GLOBAL-only permission 的 CAMPUS grant（§17/§30 的 DENY 对象）
  const role = await rawClient!.role.create({
    data: {
      key: `P7H_BAD_CAMPUS_ADMIN_${RUN_TAG}_${createdRoleSeq++}`,
      name: "p7h 误配 campus admin",
      scope: "CAMPUS",
      isSystem: false,
    },
  });
  createdRoleIds.push(role.id);
  const managePermission = await rawClient!.permission.findFirstOrThrow({
    where: { key: "campus.manage" },
  });
  await rawClient!.rolePermission.create({
    data: { roleId: role.id, permissionId: managePermission.id },
  });
  const assignment = await rawClient!.userRoleAssignment.create({
    data: {
      userId,
      roleId: role.id,
      campusId,
      scopeKey: `CAMPUS:${campusId}`,
    },
  });
  createdAssignmentIds.push(assignment.id);
  return assignment;
}
let createdRoleSeq = 0;
const createdRoleIds: string[] = [];

async function createPendingVerification(userId: string, campusId: string) {
  const existing = await rawClient!.campusMembership.findUnique({
    where: { userId_campusId: { userId, campusId } },
  });
  const membership =
    existing ??
    (await rawClient!.campusMembership.create({
      data: { userId, campusId, status: "ACTIVE" },
    }));
  if (!existing) {
    createdMembershipIds.push(membership.id);
  }
  const submittedAt = new Date();
  const verification = await rawClient!.userVerification.create({
    data: {
      userId,
      membershipId: membership.id,
      schoolName: "集成测试大学",
      campusName: `${campusId}-校区`,
      studentIdLast4: "9999",
      studentCardImage: "legacy",
      status: "PENDING",
      submittedAt,
      reviewDueAt: new Date(submittedAt.getTime() + 48 * 60 * 60 * 1000),
    },
  });
  createdVerificationIds.push(verification.id);
  return verification;
}

async function createSupportTicketRow(input: {
  requesterId: string;
  campusId: string | null;
  scopeKey: string;
  status?: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";
  assignedToId?: string | null;
}) {
  const ticket = await rawClient!.supportTicket.create({
    data: {
      requesterId: input.requesterId,
      campusId: input.campusId,
      scopeKey: input.scopeKey,
      category: "OTHER",
      subject: `${RUN_TAG}-工单`,
      description: "7H 集成测试工单描述正文。",
      status: input.status ?? "OPEN",
      assignedToId: input.assignedToId ?? null,
      dueAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    },
  });
  createdTicketIds.push(ticket.id);
  return ticket;
}

async function createReportRow(input: {
  reporterId: string;
  campusId: string | null;
  scopeKey: string;
  status?: "OPEN" | "IN_REVIEW" | "RESOLVED" | "REJECTED";
}) {
  const report = await rawClient!.report.create({
    data: {
      reporterId: input.reporterId,
      targetType: "USER",
      reason: "FAKE_INFO",
      detail: "7H 集成测试举报",
      status: input.status ?? "OPEN",
      campusId: input.campusId,
      scopeKey: input.scopeKey,
      targetUserId: input.reporterId,
    },
  });
  createdReportIds.push(report.id);
  return report;
}

async function createCaseRow(input: {
  reportId: string;
  campusId: string | null;
  scopeKey: string;
  closedAt?: Date | null;
  overdue?: boolean;
}) {
  const now = Date.now();
  const dueAt = new Date(now + (input.overdue ? -1 : 48) * 60 * 60 * 1000);
  const kase = await rawClient!.moderationCase.create({
    data: {
      reportId: input.reportId,
      campusId: input.campusId,
      scopeKey: input.scopeKey,
      openedAt: new Date(now),
      dueAt,
      lastActivityAt: new Date(now),
      closedAt: input.closedAt ?? null,
    },
  });
  createdCaseIds.push(kase.id);
  return kase;
}

async function insertRawAction(data: {
  actorId: string;
  targetId: string;
  campusId?: string | null;
  scopeKey: string;
  resultState: string;
}) {
  const id = `p7h-ea-${randomUUID()}`;
  // seq 唯一冲突（历史残留/并行文件）→ 游标递增重试（bounded）
  for (;;) {
    try {
      await rawClient!.$executeRaw`
        INSERT INTO "EnforcementAction"
          ("id", "type", "actorId", "targetId", "campusId", "scopeKey", "reasonCode",
           "note", "sourceType", "sourceId", "previousState", "resultState", "enforcementSeq")
        VALUES (${id}, 'MARKETPLACE_RESTRICT', ${data.actorId}, ${data.targetId},
                ${data.campusId ?? null}, ${data.scopeKey}, 'MANUAL_REVIEW',
                NULL, NULL, NULL, NULL, ${data.resultState}, ${nextSyntheticSeq()})`;
      break;
    } catch (error) {
      // 23505（seq 唯一冲突，Prisma 以 P2010 包裹 raw 失败）→ 游标递增重试；
      // 其余错误原样抛出
      if (!String((error as Error)?.message).includes("23505")) {
        throw error;
      }
    }
  }
  createdEnforcementIds.push(id);
  return id;
}

async function createAppealRow(enforcementActionId: string, overdue = false) {
  const appeal = await rawClient!.appeal.create({
    data: {
      enforcementActionId,
      status: "SUBMITTED",
      statement: "7H 集成测试申诉材料",
      reviewDueAt: new Date(Date.now() + (overdue ? -1 : 48) * 60 * 60 * 1000),
    },
  });
  createdAppealIds.push(appeal.id);
  return appeal;
}

async function createDisputeRow(input: {
  ownerId: string;
  renterId: string;
  campusId: string;
  status?: "OPEN" | "IN_REVIEW" | "RESOLVED" | "CLOSED";
  assignedToId?: string | null;
  overdue?: boolean;
}) {
  const category = await rawClient!.rentalCategory.create({
    data: {
      name: `${RUN_TAG}-cat-${createdCategoryIds.length}`,
      slug: `${RUN_TAG}-rc-${createdCategoryIds.length}`,
      isActive: true,
    },
  });
  createdCategoryIds.push(category.id);
  const listing = await rawClient!.rentalListing.create({
    data: {
      title: `${RUN_TAG}-租赁-${createdListingIds.length}`,
      description: "7H 集成测试租赁",
      price: "30",
      pricingUnit: "PER_DAY",
      depositAmount: "50",
      condition: "NORMAL_USED",
      status: "AVAILABLE",
      ownerId: input.ownerId,
      campusId: input.campusId,
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
  const now = new Date();
  const order = await rawClient!.rentalOrder.create({
    data: {
      orderNumber: `${RUN_TAG}-RO-${createdOrderIds.length}`,
      rentalListingId: listing.id,
      ownerId: input.ownerId,
      renterId: input.renterId,
      startTime: now,
      endTime: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      quantity: 1,
      unitPriceSnapshot: 100,
      pricingUnitSnapshot: "PER_DAY",
      rentalDuration: 1,
      rentalAmount: 100,
      depositAmount: 50,
      finalAmount: 150,
      paymentStatus: "OFFLINE_PENDING",
      depositStatus: "PENDING_PAYMENT",
      status: "IN_RENTAL",
      pickupLocationSnapshot: "门口",
      returnLocationSnapshot: "门口",
    },
  });
  createdOrderIds.push(order.id);
  const dispute = await rawClient!.rentalDispute.create({
    data: {
      orderId: order.id,
      initiatorId: input.renterId,
      reason: `7H 集成测试纠纷 ${createdDisputeIds.length}`,
      evidencePhotos: [],
      status: input.status ?? "OPEN",
      campusId: input.campusId,
      scopeKey: `CAMPUS:${input.campusId}`,
      openedFromOrderStatus: "IN_RENTAL",
      assignedToId: input.assignedToId ?? null,
      dueAt: new Date(now.getTime() + (input.overdue ? -1 : 48) * 60 * 60 * 1000),
    },
  });
  createdDisputeIds.push(dispute.id);
  return dispute;
}

// ── advisory 锁 barrier（730501 subject / 730502 policy 双命名空间）──────────

async function waitForAdvisoryLockWaiter(
  client: PrismaClient,
  subjectKeys: string[],
  namespace: number,
  options: { timeoutMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await client.$queryRaw<{ objid: number }[]>`
      SELECT locks.objid
      FROM pg_locks locks
      WHERE locks.locktype = 'advisory'
        AND NOT locks.granted
        AND locks.classid = ${namespace}::int
        AND EXISTS (
          SELECT 1
          FROM unnest(${subjectKeys}::text[]) AS expected(key)
          WHERE hashtext(expected.key)::bit(32)::bigint = locks.objid
        )`;
    if (rows.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`advisory-lock barrier 超时：预期等待键 [${subjectKeys.join(", ")}] 未进入锁等待`);
}

/**
 * 持有 advisory 锁的确定性 barrier：返回 release 函数——目标事务被证明
 * 进入锁等待队列（零 sleep）后才允许放行。
 */
async function holdAdvisoryLock(
  client: PrismaClient,
  namespace: number,
  key: string,
): Promise<() => Promise<void>> {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${namespace}::int, hashtext(${key}))`;
    await barrier;
    return "holder-released";
  });
  // 确定性：轮询直到该锁键已被 holder「授予持有」（绝不依赖固定 sleep 排序）
  const holdDeadline = Date.now() + 5000;
  for (;;) {
    const rows = await client.$queryRaw<{ objid: number }[]>`
      SELECT locks.objid
      FROM pg_locks locks
      WHERE locks.locktype = 'advisory'
        AND locks.granted
        AND locks.classid = ${namespace}::int
          AND locks.pid <> pg_backend_pid()
        AND hashtext(${key})::bit(32)::bigint = locks.objid`;
    if (rows.length > 0 || Date.now() > holdDeadline) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return () => {
    release();
    return holder.then(() => undefined);
  };
}

// ── prisma CLI（migration 收敛验证）──────────────────────────────────────────

function runPrismaCli(args: string[], databaseUrl: string, input?: string): string {
  const result = spawnSync(
    process.execPath,
    [path.resolve("node_modules", "prisma", "build", "index.js"), ...args],
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

// ── 测试主体 ─────────────────────────────────────────────────────────────────

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 7H operations overview + campus administration 集成测试（真实 PostgreSQL）",
  () => {
    let campusA: { id: string };
    let campusB: { id: string };
    let platformAdmin: { id: string };
    let reportReviewerA: { id: string };
    let plainUser: { id: string };

    beforeAll(async () => {
      if (!rawClient) {
        return;
      }
      // migration 收敛（幂等；本地/CI 均先 deploy 再跑集成）
      runPrismaCli(["migrate", "deploy", "--schema", "prisma/schema.prisma"], integrationDatabaseUrl!);

      campusA = await createFixtureCampus("P7H-A");
      campusB = await createFixtureCampus("P7H-B");
      projectionCampusId = campusA.id;

      platformAdmin = await createFixtureUser("P7HAdmin");
      await assignRoleByKey(platformAdmin.id, "PLATFORM_ADMIN");

      reportReviewerA = await createFixtureUser("P7HReporterA", { membershipCampusId: campusA.id });
      await assignRoleByKey(reportReviewerA.id, "CAMPUS_REPORT_REVIEWER", campusA.id);

      plainUser = await createFixtureUser("P7HPlain");
    }, 180_000);

    afterAll(async () => {
      if (!rawClient) {
        return;
      }
      try {
        await rawClient.$transaction([
          rawClient.adminLog.deleteMany({
            where: {
              OR: [
                { targetId: { in: [...createdCaseIds, ...createdPolicyIds, ...createdCampusIds] } },
                { campusId: { in: createdCampusIds } },
              ],
            },
          }),
          rawClient.campusVerificationPolicy.deleteMany({
            where: { campusId: { in: createdCampusIds } },
          }),
          rawClient.moderationCase.deleteMany({ where: { id: { in: createdCaseIds } } }),
          rawClient.report.deleteMany({ where: { id: { in: createdReportIds } } }),
          rawClient.supportTicket.deleteMany({ where: { id: { in: createdTicketIds } } }),
          rawClient.appeal.deleteMany({ where: { id: { in: createdAppealIds } } }),
          rawClient.rentalDispute.deleteMany({ where: { id: { in: createdDisputeIds } } }),
          rawClient.rentalOrderStatusLog.deleteMany({ where: { orderId: { in: createdOrderIds } } }),
          rawClient.rentalOrder.deleteMany({ where: { id: { in: createdOrderIds } } }),
          rawClient.rentalListing.deleteMany({ where: { id: { in: createdListingIds } } }),
          rawClient.rentalCategory.deleteMany({ where: { id: { in: createdCategoryIds } } }),
          rawClient.enforcementAction.deleteMany({ where: { id: { in: createdEnforcementIds } } }),
          rawClient.notification.deleteMany({ where: { userId: { in: createdUserIds } } }),
          rawClient.userRoleAssignment.deleteMany({ where: { id: { in: createdAssignmentIds } } }),
          rawClient.rolePermission.deleteMany({ where: { roleId: { in: createdRoleIds } } }),
          rawClient.role.deleteMany({ where: { id: { in: createdRoleIds } } }),
          rawClient.userVerification.deleteMany({ where: { id: { in: createdVerificationIds } } }),
          rawClient.campusMembership.deleteMany({ where: { id: { in: createdMembershipIds } } }),
          rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } }),
          rawClient.campus.deleteMany({ where: { id: { in: createdCampusIds } } }),
        ]);
      } catch (error) {
        console.warn("phase7h cleanup 失败（不影响断言）", error);
      }
      await rawClient!.$disconnect();
    }, 60_000);

    // ── RBAC migration 合同（§37/§57）──────────────────────────────────────

    it("RB01：operations.overview 恰 1 行；DB permission 集合与代码 PERMISSION_KEYS 零漂移", async () => {
      const { PERMISSION_KEYS } = await import("@/lib/rbac/permissions");
      const permissions = await rawClient!.permission.findMany({ select: { key: true } });
      expect(permissions).toHaveLength(PERMISSION_KEYS.length);
      expect(permissions.map((p) => p.key).sort()).toEqual([...PERMISSION_KEYS].sort());

      const rows = await rawClient!.permission.findMany({ where: { key: "operations.overview" } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.description).toBe("读取平台运行状态与安全的运营级系统概览");
    });

    it("RB02：PLATFORM_ADMIN 持有 operations.overview；CAMPUS-scope 角色恒不持有（§57）", async () => {
      // 注：全局"恰 1 条 RolePermission"不作为断言——既有 phase6b 全量
      // GLOBAL 测试夹具（FULL_ADMIN_*，permissionKeys = [...PERMISSION_KEYS]）
      // 在其文件存活期同样持有该 key，属既有合同；7H 冻结不变量是：
      // (a) PLATFORM_ADMIN 必有；(b) CAMPUS-scope 角色恒零（GLOBAL ONLY）。
      const permission = await rawClient!.permission.findFirstOrThrow({
        where: { key: "operations.overview" },
      });
      const grants = await rawClient!.rolePermission.findMany({
        where: { permissionId: permission.id },
        include: { role: { select: { key: true, scope: true } } },
      });
      expect(
        grants.some((grant) => grant.role.key === "PLATFORM_ADMIN"),
      ).toBe(true);
      expect(grants.filter((grant) => grant.role.scope === "CAMPUS")).toEqual([]);

      const campusGrants = await rawClient!.rolePermission.count({
        where: {
          permission: { key: "operations.overview" },
          role: { scope: "CAMPUS" },
        },
      });
      expect(campusGrants).toBe(0);
    });

    it("RB03：7H migration SQL 保持 DATA-ONLY 合同（BEGIN/COMMIT 显式包裹，零 DDL，零 assignment）", async () => {
      const { readFileSync } = await import("node:fs");
      const sql = readFileSync(
        "prisma/migrations/20260920120000_phase7h_operations_overview_permission/migration.sql",
        "utf8",
      );
      expect(sql).toContain("BEGIN;");
      expect(sql).toContain("COMMIT;");
      expect(sql.toLowerCase()).not.toMatch(/create table|alter table|add column|drop /);
      expect(sql).not.toMatch(/(insert into|update|delete from)\s+"UserRoleAssignment"/i);
    });

    it("RB04：SO01/SO02/SO03——operations.overview access 派生（GLOBAL only，真实 RBAC context）", async () => {
      const { loadAuthorizationContext } = await import("@/lib/rbac/service");
      const { deriveOperationsOverviewAccess } = await import(
        "@/lib/governance/operations-overview-access"
      );
      const { deriveCampusManageAccess } = await import("@/lib/campus/campus-admin-access");

      const adminContext = await loadAuthorizationContext(platformAdmin.id);
      expect(deriveOperationsOverviewAccess(adminContext).global).toBe(true);
      expect(deriveCampusManageAccess(adminContext).global).toBe(true);

      const reviewerContext = await loadAuthorizationContext(reportReviewerA.id);
      expect(deriveOperationsOverviewAccess(reviewerContext).global).toBe(false);
      expect(deriveCampusManageAccess(reviewerContext).global).toBe(false);

      const plainContext = await loadAuthorizationContext(plainUser.id);
      expect(deriveOperationsOverviewAccess(plainContext).global).toBe(false);
    });

    // ── Campus 管理基础合同（§21-§28，CA01-CA08）───────────────────────────

    it("CA01/CA08：GLOBAL campus.manage 创建校区（isActive=true）+ audit；重复 slug → 稳定冲突码", async () => {
      const { createGovernanceCampus } = await import("@/lib/campus/campus-governance-service");

      const campus = await createGovernanceCampus({
        actorId: platformAdmin.id,
        name: "新校区",
        slug: `${RUN_TAG}-new-campus`,
        schoolName: "集成测试大学",
        district: "海淀区",
      });
      createdCampusIds.push(campus.id);
      expect(campus.isActive).toBe(true);

      const audit = await rawClient!.adminLog.findFirstOrThrow({
        where: { targetType: "CAMPUS", targetId: campus.id, action: "CAMPUS_CREATED" },
      });
      expect(audit.adminId).toBe(platformAdmin.id);

      await expect(
        createGovernanceCampus({
          actorId: platformAdmin.id,
          name: "抢注校区",
          slug: `${RUN_TAG}-new-campus`,
          schoolName: "集成测试大学",
        }),
      ).rejects.toMatchObject({ code: "CAMPUS_SLUG_CONFLICT" });
    });

    it("CA02：campus.manage @ CAMPUS（误配）→ 服务层锁内授权拒绝，零 mutation 零 audit", async () => {
      const { createGovernanceCampus } = await import("@/lib/campus/campus-governance-service");

      const misconfigured = await createFixtureUser("P7HBadCampusAdmin", {
        membershipCampusId: campusA.id,
      });
      await grantRawCampusManage(misconfigured.id, campusA.id);

      const before = await rawClient!.campus.count();
      const outcome = await createGovernanceCampus({
        actorId: misconfigured.id,
        name: "越权校区",
        slug: `${RUN_TAG}-bad-admin-campus`,
        schoolName: "集成测试大学",
      }).then(
        () => null,
        (e: unknown) => e as { code?: string },
      );
      expect(["AUTH_PERMISSION_DENIED", "AUTH_CAMPUS_SCOPE_MISMATCH"]).toContain(outcome?.code);
      expect(await rawClient!.campus.count()).toBe(before);
    });

    it("CA03/CA04：无权限 / 停用账号 → fail closed", async () => {
      const { deactivateGovernanceCampus } = await import("@/lib/campus/campus-governance-service");

      await expect(
        deactivateGovernanceCampus({ actorId: plainUser.id, campusId: campusA.id }),
      ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });

      const suspended = await createFixtureUser("P7HSuspended", { status: "SUSPENDED" });
      await assignRoleByKey(suspended.id, "PLATFORM_ADMIN");
      await expect(
        deactivateGovernanceCampus({ actorId: suspended.id, campusId: campusA.id }),
      ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });
    });

    it("CA06/CA07/CA08：slug 不可变；same-state 切换幂等（零 mutation 零 audit）；状态迁移审计机器字段", async () => {
      const {
        createGovernanceCampus,
        updateGovernanceCampusMetadata,
        deactivateGovernanceCampus,
        activateGovernanceCampus,
      } = await import("@/lib/campus/campus-governance-service");

      const campus = await createGovernanceCampus({
        actorId: platformAdmin.id,
        name: "幂等校区",
        slug: `${RUN_TAG}-idem-campus`,
        schoolName: "集成测试大学",
      });
      createdCampusIds.push(campus.id);

      // same-state 激活：幂等 no-op
      const auditBefore = await rawClient!.adminLog.count({
        where: { targetType: "CAMPUS", targetId: campus.id },
      });
      const unchanged = await activateGovernanceCampus({
        actorId: platformAdmin.id,
        campusId: campus.id,
      });
      expect(unchanged.isActive).toBe(true);
      expect(
        await rawClient!.adminLog.count({ where: { targetType: "CAMPUS", targetId: campus.id } }),
      ).toBe(auditBefore);

      // deactivate 迁移 + 机器字段 audit
      await deactivateGovernanceCampus({ actorId: platformAdmin.id, campusId: campus.id });
      const deactivated = await rawClient!.campus.findUniqueOrThrow({ where: { id: campus.id } });
      expect(deactivated.isActive).toBe(false);
      const deactivateAudit = await rawClient!.adminLog.findFirstOrThrow({
        where: { targetType: "CAMPUS", targetId: campus.id, action: "CAMPUS_DEACTIVATED" },
      });
      expect(deactivateAudit.metadata).toEqual(
        expect.objectContaining({ previousIsActive: true, newIsActive: false }),
      );
      expect(JSON.stringify(deactivateAudit.metadata)).not.toContain("名称");

      // 元数据更新：slug 结构性不变（§21）
      await updateGovernanceCampusMetadata({
        actorId: platformAdmin.id,
        campusId: campus.id,
        name: "改名校区",
      });
      const after = await rawClient!.campus.findUniqueOrThrow({ where: { id: campus.id } });
      expect(after.name).toBe("改名校区");
      expect(after.slug).toBe(`${RUN_TAG}-idem-campus`);
      const updateAudit = await rawClient!.adminLog.findFirstOrThrow({
        where: { targetType: "CAMPUS", targetId: campus.id, action: "CAMPUS_UPDATED" },
      });
      expect(updateAudit.metadata ?? null).toBeNull();
    });

    it("C-RACE-01：role revoke wins → campus update denied，零 mutation / 零 audit（advisory barrier，零 sleep）", async () => {
      const { deactivateGovernanceCampus } = await import("@/lib/campus/campus-governance-service");

      const admin = await createFixtureUser("P7HRaceAdmin");
      const assignment = await assignRoleByKey(admin.id, "PLATFORM_ADMIN");
      const campus = await createFixtureCampus("P7H-RACE01");

      const campusKey = `CAMPUS:${campus.id}`;
      const release = await holdAdvisoryLock(rawClient!, GOVERNANCE_LOCK_NAMESPACE, campusKey);
      try {
        const target = deactivateGovernanceCampus({ actorId: admin.id, campusId: campus.id });
        const guarded = target.catch((error: unknown) => error);
        await waitForAdvisoryLockWaiter(
          rawClient!,
          [campusKey, `USER:${admin.id}`],
          GOVERNANCE_LOCK_NAMESPACE,
        );

        // 目标事务已在锁等待（授权重读尚未发生）→ 撤权先行提交
        await rawClient!.userRoleAssignment.delete({ where: { id: assignment.id } });
        createdAssignmentIds.splice(createdAssignmentIds.indexOf(assignment.id), 1);
        await release();

        const error = (await guarded) as { code?: string };
        expect(error.code).toBe("AUTH_PERMISSION_DENIED");

        const row = await rawClient!.campus.findUniqueOrThrow({ where: { id: campus.id } });
        expect(row.isActive).toBe(true);
        expect(
          await rawClient!.adminLog.count({ where: { targetType: "CAMPUS", targetId: campus.id } }),
        ).toBe(0);
      } finally {
        await release();
      }
    });

    it("C-RACE-02：campus update wins → legal commit then revoke（锁定授权重读先于撤权提交）", async () => {
      const { deactivateGovernanceCampus } = await import("@/lib/campus/campus-governance-service");

      const admin = await createFixtureUser("P7HRaceAdmin02");
      const assignment = await assignRoleByKey(admin.id, "PLATFORM_ADMIN");
      const campus = await createFixtureCampus("P7H-RACE02");

      const campusKey = `CAMPUS:${campus.id}`;
      const release = await holdAdvisoryLock(rawClient!, GOVERNANCE_LOCK_NAMESPACE, campusKey);
      try {
        const guarded = deactivateGovernanceCampus({
          actorId: admin.id,
          campusId: campus.id,
        }).catch((error: unknown) => error);
        await waitForAdvisoryLockWaiter(
          rawClient!,
          [campusKey, `USER:${admin.id}`],
          GOVERNANCE_LOCK_NAMESPACE,
        );
        await release();

        const outcome = (await guarded) as { code?: string; isActive?: boolean } | Error;
        expect((outcome as { code?: string }).code).toBeUndefined();
        expect((outcome as { isActive?: boolean }).isActive).toBe(false);

        // 合法提交先于撤权落地：mutation 与 audit 均保留
        await rawClient!.userRoleAssignment.delete({ where: { id: assignment.id } });
        createdAssignmentIds.splice(createdAssignmentIds.indexOf(assignment.id), 1);
        const row = await rawClient!.campus.findUniqueOrThrow({ where: { id: campus.id } });
        expect(row.isActive).toBe(false);
        const audit = await rawClient!.adminLog.findFirstOrThrow({
          where: { targetType: "CAMPUS", targetId: campus.id, action: "CAMPUS_DEACTIVATED" },
        });
        expect(audit.metadata).toEqual(
          expect.objectContaining({ previousIsActive: true, newIsActive: false }),
        );
      } finally {
        await release();
      }
    });

    it("C-RACE-03：并发 activate/deactivate → 串行化合法终态，无死锁", async () => {
      const { activateGovernanceCampus, deactivateGovernanceCampus } = await import(
        "@/lib/campus/campus-governance-service"
      );

      const adminA = await createFixtureUser("P7HRaceAdmin03A");
      const adminB = await createFixtureUser("P7HRaceAdmin03B");
      await assignRoleByKey(adminA.id, "PLATFORM_ADMIN");
      await assignRoleByKey(adminB.id, "PLATFORM_ADMIN");
      const campus = await createFixtureCampus("P7H-RACE03");

      const results = await Promise.allSettled([
        activateGovernanceCampus({ actorId: adminA.id, campusId: campus.id }),
        deactivateGovernanceCampus({ actorId: adminB.id, campusId: campus.id }),
      ]);
      assertNoSerializationFailure(
        results
          .filter((r) => r.status === "rejected")
          .map((r) => (r as PromiseRejectedResult).reason),
      );
      for (const result of results) {
        expect(result.status).toBe("fulfilled");
      }

      const row = await rawClient!.campus.findUniqueOrThrow({ where: { id: campus.id } });
      // 串行化后终态合法（最后提交者为准），且 audit 恰覆盖每次真实状态迁移
      const audits = await rawClient!.adminLog.findMany({
        where: { targetType: "CAMPUS", targetId: campus.id },
        orderBy: { createdAt: "asc" },
      });
      expect(audits.length).toBeGreaterThanOrEqual(1);
      const lastAudit = audits[audits.length - 1]!;
      if (lastAudit.action === "CAMPUS_DEACTIVATED") {
        expect(row.isActive).toBe(false);
      } else if (lastAudit.action === "CAMPUS_ACTIVATED") {
        expect(row.isActive).toBe(true);
      }
    });

    it("C-RACE-04：same-state toggle 并发重试 → 双双幂等，零 audit", async () => {
      const { deactivateGovernanceCampus } = await import("@/lib/campus/campus-governance-service");

      const admin = await createFixtureUser("P7HRaceAdmin04");
      await assignRoleByKey(admin.id, "PLATFORM_ADMIN");
      const campus = await createFixtureCampus("P7H-RACE04");
      const { deactivateGovernanceCampus: deactivate } = await import(
        "@/lib/campus/campus-governance-service"
      );
      // 先置为 inactive（一次真实迁移）
      await deactivate({ actorId: admin.id, campusId: campus.id });
      const auditBaseline = await rawClient!.adminLog.count({
        where: { targetType: "CAMPUS", targetId: campus.id, action: "CAMPUS_DEACTIVATED" },
      });
      expect(auditBaseline).toBe(1);

      const results = await Promise.allSettled([
        deactivateGovernanceCampus({ actorId: admin.id, campusId: campus.id }),
        deactivateGovernanceCampus({ actorId: admin.id, campusId: campus.id }),
      ]);
      assertNoSerializationFailure(
        results
          .filter((r) => r.status === "rejected")
          .map((r) => (r as PromiseRejectedResult).reason),
      );
      expect(
        await rawClient!.adminLog.count({
          where: { targetType: "CAMPUS", targetId: campus.id, action: "CAMPUS_DEACTIVATED" },
        }),
      ).toBe(1);
    });

    it("C-RACE-05：并发 create 同 slug → 恰一成功，败者稳定冲突码，无死锁", async () => {
      const { createGovernanceCampus } = await import("@/lib/campus/campus-governance-service");

      const adminA = await createFixtureUser("P7HRaceAdmin05A");
      const adminB = await createFixtureUser("P7HRaceAdmin05B");
      await assignRoleByKey(adminA.id, "PLATFORM_ADMIN");
      await assignRoleByKey(adminB.id, "PLATFORM_ADMIN");
      const slug = `${RUN_TAG}-race-slug`;

      const results = await Promise.allSettled([
        createGovernanceCampus({ actorId: adminA.id, name: "竞速A", slug, schoolName: "集成测试大学" }),
        createGovernanceCampus({ actorId: adminB.id, name: "竞速B", slug, schoolName: "集成测试大学" }),
      ]);

      const errors = results
        .filter((r) => r.status === "rejected")
        .map((r) => (r as PromiseRejectedResult).reason);
      assertNoSerializationFailure(errors);
      expect(errors).toHaveLength(1);
      expect(errorCodeOf(errors[0])).toBe("CAMPUS_SLUG_CONFLICT");

      const fulfilled = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{
        id: string;
      }>;
      createdCampusIds.push(fulfilled.value.id);
      expect(
        await rawClient!.campus.count({ where: { slug } }),
      ).toBe(1);
    });

    // ─ Campus.isActive 语义冻结（§22/§51 deactivation safety）──────────────

    it("§51：deactivate 不级联任何义务（membership/verification/assignment/ticket/user 全保留）", async () => {
      const { deactivateGovernanceCampus } = await import("@/lib/campus/campus-governance-service");

      const campus = await createFixtureCampus("P7H-Safety");
      const member = await createFixtureUser("P7HSafetyMember", {
        membershipCampusId: campus.id,
      });
      await createPendingVerification(member.id, campus.id);
      await grantCustomRole(member.id, ["report.review"], campus.id);
      const ticket = await createSupportTicketRow({
        requesterId: member.id,
        campusId: campus.id,
        scopeKey: `CAMPUS:${campus.id}`,
      });

      await deactivateGovernanceCampus({ actorId: platformAdmin.id, campusId: campus.id });

      expect((await rawClient!.user.findUniqueOrThrow({ where: { id: member.id } })).status).toBe(
        "ACTIVE",
      );
      expect(
        await rawClient!.campusMembership.count({
          where: { campusId: campus.id, status: "ACTIVE" },
        }),
      ).toBe(1);
      expect(
        await rawClient!.userVerification.count({
          where: { membership: { campusId: campus.id }, status: "PENDING" },
        }),
      ).toBe(1);
      expect(
        await rawClient!.userRoleAssignment.count({
          where: { userId: member.id, campusId: campus.id },
        }),
      ).toBe(1);
      const ticketAfter = await rawClient!.supportTicket.findUniqueOrThrow({
        where: { id: ticket.id },
      });
      expect(ticketAfter.status).toBe("OPEN");

      // §23 admission：停用校区退出注册可选集（listActiveCampuses 同谓词）
      expect(
        await rawClient!.campus.count({ where: { id: campus.id, isActive: true } }),
      ).toBe(0);
    });

    // ── 认证策略治理（§29-§36，CP01-CP10）─────────────────────────────────

    it("CP01/CP02：draft 顺序分配 next version；instructions 更新重算 contentHash", async () => {
      const {
        createGovernanceVerificationPolicyDraft,
        updateGovernanceVerificationPolicyDraft,
      } = await import("@/lib/campus/policy-governance-service");
      const { computePolicyContentHash } = await import("@/lib/campus/verification-policy-service");

      const draft1 = await createGovernanceVerificationPolicyDraft({
        actorId: platformAdmin.id,
        campusId: campusA.id,
        title: "认证规则",
        instructions: "上传学生证",
      });
      createdPolicyIds.push(draft1.id);
      expect(draft1.version).toBe(1);
      expect(draft1.status).toBe("DRAFT");
      expect(draft1.contentHash).toBe(computePolicyContentHash("上传学生证"));

      const draft2 = await createGovernanceVerificationPolicyDraft({
        actorId: platformAdmin.id,
        campusId: campusA.id,
        title: "认证规则 v2 草稿",
        instructions: "上传学生证 v2",
      });
      createdPolicyIds.push(draft2.id);
      expect(draft2.version).toBe(2);

      const updated = await updateGovernanceVerificationPolicyDraft({
        actorId: platformAdmin.id,
        policyId: draft2.id,
        instructions: "上传学生证 + 校园卡",
      });
      expect(updated.version).toBe(2);
      expect(updated.instructions).toBe("上传学生证 + 校园卡");
      expect(updated.contentHash).toBe(computePolicyContentHash("上传学生证 + 校园卡"));

      const audit = await rawClient!.adminLog.findFirstOrThrow({
        where: { action: "UPDATE_VERIFICATION_POLICY_DRAFT", targetId: draft2.id },
      });
      expect(audit.metadata).toEqual({ policyVersion: 2 });
      expect(JSON.stringify(audit.metadata)).not.toContain("学生证");
    });

    it("CP03/CP04/CP06：PUBLISHED/RETIRED IMMUTABLE；RETIRED 不可重发布", async () => {
      const {
        createGovernanceVerificationPolicyDraft,
        updateGovernanceVerificationPolicyDraft,
        publishGovernanceVerificationPolicy,
        retireGovernanceVerificationPolicy,
      } = await import("@/lib/campus/policy-governance-service");

      const draft = await createGovernanceVerificationPolicyDraft({
        actorId: platformAdmin.id,
        campusId: campusB.id,
        title: "不可变规则",
        instructions: "原说明",
      });
      createdPolicyIds.push(draft.id);
      const originalHash = draft.contentHash;

      await publishGovernanceVerificationPolicy({ actorId: platformAdmin.id, policyId: draft.id });
      await expect(
        updateGovernanceVerificationPolicyDraft({
          actorId: platformAdmin.id,
          policyId: draft.id,
          instructions: "篡改",
        }),
      ).rejects.toMatchObject({ code: "CAMPUS_VERIFICATION_POLICY_IMMUTABLE" });
      const published = await rawClient!.campusVerificationPolicy.findUniqueOrThrow({
        where: { id: draft.id },
      });
      expect(published.instructions).toBe("原说明");
      expect(published.contentHash).toBe(originalHash);

      // 幂等重发布：同一策略原样返回，不产生第二个 published
      const republished = await publishGovernanceVerificationPolicy({
        actorId: platformAdmin.id,
        policyId: draft.id,
      });
      expect(republished.status).toBe("PUBLISHED");
      expect(
        await rawClient!.adminLog.count({
          where: { action: "PUBLISH_VERIFICATION_POLICY", targetId: draft.id },
        }),
      ).toBe(1);

      await retireGovernanceVerificationPolicy({ actorId: platformAdmin.id, policyId: draft.id });
      await expect(
        updateGovernanceVerificationPolicyDraft({
          actorId: platformAdmin.id,
          policyId: draft.id,
          instructions: "再篡改",
        }),
      ).rejects.toMatchObject({ code: "CAMPUS_VERIFICATION_POLICY_IMMUTABLE" });
      await expect(
        publishGovernanceVerificationPolicy({ actorId: platformAdmin.id, policyId: draft.id }),
      ).rejects.toMatchObject({ code: "CAMPUS_VERIFICATION_POLICY_ALREADY_PUBLISHED" });
    });

    it("CP05/CP10：current 解析语义零变化——future effectiveAt 生效前不是 current，生效后接管", async () => {
      const {
        createGovernanceVerificationPolicyDraft,
        publishGovernanceVerificationPolicy,
      } = await import("@/lib/campus/policy-governance-service");
      const { getCurrentVerificationPolicy } = await import(
        "@/lib/campus/verification-policy-service"
      );

      const now = new Date();
      const future = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const draft = await createGovernanceVerificationPolicyDraft({
        actorId: platformAdmin.id,
        campusId: campusB.id,
        title: "未来生效规则",
        instructions: "未来说明",
        effectiveAt: future,
      });
      createdPolicyIds.push(draft.id);
      await publishGovernanceVerificationPolicy({ actorId: platformAdmin.id, policyId: draft.id });

      const beforeEffective = await getCurrentVerificationPolicy(campusB.id, new Date());
      if (beforeEffective) {
        expect(beforeEffective.version).toBeLessThan(draft.version);
      }
      const afterEffective = await getCurrentVerificationPolicy(
        campusB.id,
        new Date(future.getTime() + 1000),
      );
      expect(afterEffective?.id).toBe(draft.id);
    });

    it("CP07/CP08：campus-scoped campus.manage 不能触碰策略；revoke race fail closed", async () => {
      const { createGovernanceVerificationPolicyDraft } = await import(
        "@/lib/campus/policy-governance-service"
      );

      const misconfigured = await createFixtureUser("P7HBadPolicyAdmin", {
        membershipCampusId: campusA.id,
      });
      await grantRawCampusManage(misconfigured.id, campusA.id);

      const denied = await createGovernanceVerificationPolicyDraft({
        actorId: misconfigured.id,
        campusId: campusA.id,
        title: "越权草稿",
        instructions: "越权说明",
      }).then(
        () => null,
        (e: unknown) => e as { code?: string },
      );
      expect(["AUTH_PERMISSION_DENIED", "AUTH_CAMPUS_SCOPE_MISMATCH"]).toContain(denied?.code);

      // CP08：授权重读前撤权（policy 锁 barrier）→ fail closed 零 mutation
      const admin = await createFixtureUser("P7HPolicyRaceAdmin");
      const assignment = await assignRoleByKey(admin.id, "PLATFORM_ADMIN");
      const policyKey = `CAMPUS_VERIFICATION_POLICY:${campusB.id}`;
      const release = await holdAdvisoryLock(rawClient!, POLICY_LOCK_NAMESPACE, policyKey);
      try {
        const guarded = createGovernanceVerificationPolicyDraft({
          actorId: admin.id,
          campusId: campusB.id,
          title: "race 草稿",
          instructions: "race 说明",
        }).catch((error: unknown) => error);
        await waitForAdvisoryLockWaiter(
          rawClient!,
          [policyKey, `USER:${admin.id}`],
          POLICY_LOCK_NAMESPACE,
        );
        await rawClient!.userRoleAssignment.delete({ where: { id: assignment.id } });
        createdAssignmentIds.splice(createdAssignmentIds.indexOf(assignment.id), 1);
        await release();

        const error = (await guarded) as { code?: string };
        expect(error.code).toBe("AUTH_PERMISSION_DENIED");
        expect(
          await rawClient!.campusVerificationPolicy.count({
            where: { campusId: campusB.id, title: "race 草稿" },
          }),
        ).toBe(0);
      } finally {
        await release();
      }
    });

    it("P-RACE-01：并发 draft create → 唯一单调 version 分配（锁内 max+1），无死锁", async () => {
      const { createGovernanceVerificationPolicyDraft } = await import(
        "@/lib/campus/policy-governance-service"
      );

      const baseline = await rawClient!.campusVerificationPolicy.aggregate({
        _max: { version: true },
        where: { campusId: campusA.id },
      });
      const expectedBase = baseline._max.version ?? 0;

      const results = await Promise.allSettled([
        createGovernanceVerificationPolicyDraft({
          actorId: platformAdmin.id,
          campusId: campusA.id,
          title: "并发草稿 A",
          instructions: "并发说明 A",
        }),
        createGovernanceVerificationPolicyDraft({
          actorId: platformAdmin.id,
          campusId: campusA.id,
          title: "并发草稿 B",
          instructions: "并发说明 B",
        }),
      ]);
      assertNoSerializationFailure(
        results
          .filter((r) => r.status === "rejected")
          .map((r) => (r as PromiseRejectedResult).reason),
      );
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);

      const versions = results
        .map((r) => (r as PromiseFulfilledResult<{ version: number }>).value.version)
        .sort((a, b) => a - b);
      expect(versions).toEqual([expectedBase + 1, expectedBase + 2]);
      for (const result of results) {
        createdPolicyIds.push((result as PromiseFulfilledResult<{ id: string }>).value.id);
      }
    });

    it("P-RACE-02：draft update vs publish 并发 → 两种合法串行结局之一，终态自洽", async () => {
      const {
        createGovernanceVerificationPolicyDraft,
        updateGovernanceVerificationPolicyDraft,
        publishGovernanceVerificationPolicy,
      } = await import("@/lib/campus/policy-governance-service");
      const { computePolicyContentHash } = await import("@/lib/campus/verification-policy-service");

      const draft = await createGovernanceVerificationPolicyDraft({
        actorId: platformAdmin.id,
        campusId: campusB.id,
        title: "竞速草稿",
        instructions: "初版说明",
      });
      createdPolicyIds.push(draft.id);

      const results = await Promise.allSettled([
        updateGovernanceVerificationPolicyDraft({
          actorId: platformAdmin.id,
          policyId: draft.id,
          instructions: "更新版说明",
        }),
        publishGovernanceVerificationPolicy({ actorId: platformAdmin.id, policyId: draft.id }),
      ]);
      assertNoSerializationFailure(
        results
          .filter((r) => r.status === "rejected")
          .map((r) => (r as PromiseRejectedResult).reason),
      );

      const row = await rawClient!.campusVerificationPolicy.findUniqueOrThrow({
        where: { id: draft.id },
      });
      expect(row.status).toBe("PUBLISHED");
      // 终态自洽：contentHash 与最终 instructions 同源（update-first ⇒ 发布更新内容；
      // publish-first ⇒ update 被拒，发布初版内容）
      if (row.instructions === "更新版说明") {
        expect(row.contentHash).toBe(computePolicyContentHash("更新版说明"));
      } else {
        expect(row.instructions).toBe("初版说明");
        expect(row.contentHash).toBe(computePolicyContentHash("初版说明"));
      }
    });

    it("P-RACE-03：policy publish-first → legal publish then revoke（提交与审计保留）", async () => {
      const {
        createGovernanceVerificationPolicyDraft,
        publishGovernanceVerificationPolicy,
      } = await import("@/lib/campus/policy-governance-service");

      const admin = await createFixtureUser("P7HPolicyRace04");
      const assignment = await assignRoleByKey(admin.id, "PLATFORM_ADMIN");
      const draft = await createGovernanceVerificationPolicyDraft({
        actorId: admin.id,
        campusId: campusA.id,
        title: "先发布后撤权",
        instructions: "先发布说明",
      });
      createdPolicyIds.push(draft.id);

      const published = await publishGovernanceVerificationPolicy({
        actorId: admin.id,
        policyId: draft.id,
      });
      expect(published.status).toBe("PUBLISHED");

      await rawClient!.userRoleAssignment.delete({ where: { id: assignment.id } });
      createdAssignmentIds.splice(createdAssignmentIds.indexOf(assignment.id), 1);

      const row = await rawClient!.campusVerificationPolicy.findUniqueOrThrow({
        where: { id: draft.id },
      });
      expect(row.status).toBe("PUBLISHED");
      expect(
        await rawClient!.adminLog.count({
          where: { action: "PUBLISH_VERIFICATION_POLICY", targetId: draft.id },
        }),
      ).toBe(1);
    });

    it("P-RACE-04（=§35 idempotent publish 合同）：两个并发 publish → 既有 invariant 保持（恰 1 审计、唯一 PUBLISHED 行）", async () => {
      const {
        createGovernanceVerificationPolicyDraft,
        publishGovernanceVerificationPolicy,
      } = await import("@/lib/campus/policy-governance-service");

      const draft = await createGovernanceVerificationPolicyDraft({
        actorId: platformAdmin.id,
        campusId: campusA.id,
        title: "双发布竞速",
        instructions: "双发布说明",
      });
      createdPolicyIds.push(draft.id);

      const results = await Promise.allSettled([
        publishGovernanceVerificationPolicy({ actorId: platformAdmin.id, policyId: draft.id }),
        publishGovernanceVerificationPolicy({ actorId: platformAdmin.id, policyId: draft.id }),
      ]);
      assertNoSerializationFailure(
        results
          .filter((r) => r.status === "rejected")
          .map((r) => (r as PromiseRejectedResult).reason),
      );
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);

      const publishedRows = await rawClient!.campusVerificationPolicy.findMany({
        where: { campusId: campusA.id, version: draft.version },
      });
      expect(publishedRows).toHaveLength(1);
      expect(publishedRows[0]!.status).toBe("PUBLISHED");
      expect(
        await rawClient!.adminLog.count({
          where: { action: "PUBLISH_VERIFICATION_POLICY", targetId: draft.id },
        }),
      ).toBe(1);
    });

    // ── §48/§49：仪表盘授权矩阵与 count 一致性（五域，GLOBAL + CAMPUS）──────

    it("§49：五域 dashboard count == canonical queue 谓词计数（campus reviewer 隔离视角 + GLOBAL 邻近查询）", async () => {
      // campus 隔离：全部 fixture 落在 RUN_TAG 专属校区（并行文件互不干扰），
      // dashboard / queue / 期望常数三方相等断言确定性成立
      const reporter = await createFixtureUser("P7HConsistencyReporter", {
        membershipCampusId: campusA.id,
      });

      // campus A 活跃：reports 2（1 超时）、verifications 1、appeals 1、
      // disputes 1（超时）、support 1；终态行（closed/RESOLVED）不计入 active
      await createCaseRow({
        reportId: (
          await createReportRow({ reporterId: reporter.id, campusId: campusA.id, scopeKey: `CAMPUS:${campusA.id}` })
        ).id,
        campusId: campusA.id,
        scopeKey: `CAMPUS:${campusA.id}`,
      });
      await createCaseRow({
        reportId: (
          await createReportRow({ reporterId: reporter.id, campusId: campusA.id, scopeKey: `CAMPUS:${campusA.id}` })
        ).id,
        campusId: campusA.id,
        scopeKey: `CAMPUS:${campusA.id}`,
        overdue: true,
      });
      await createCaseRow({
        reportId: (
          await createReportRow({
            reporterId: reporter.id,
            campusId: campusA.id,
            scopeKey: `CAMPUS:${campusA.id}`,
            status: "RESOLVED",
          })
        ).id,
        campusId: campusA.id,
        scopeKey: `CAMPUS:${campusA.id}`,
        closedAt: new Date(),
      });

      await createPendingVerification(reporter.id, campusA.id);

      await createAppealRow(
        await insertRawAction({
          actorId: platformAdmin.id,
          targetId: reporter.id,
          campusId: campusA.id,
          scopeKey: `CAMPUS:${campusA.id}`,
          resultState: "RESTRICTED",
        }),
      );

      await createDisputeRow({
        ownerId: platformAdmin.id,
        renterId: reporter.id,
        campusId: campusA.id,
        overdue: true,
      });

      await createSupportTicketRow({
        requesterId: reporter.id,
        campusId: campusA.id,
        scopeKey: `CAMPUS:${campusA.id}`,
      });
      await createSupportTicketRow({
        requesterId: reporter.id,
        campusId: campusA.id,
        scopeKey: `CAMPUS:${campusA.id}`,
        status: "RESOLVED",
      });

      // campus A 五域 reviewer（grant ∧ ACTIVE membership）
      const reviewer = await createFixtureUser("P7HReviewerAll", {
        membershipCampusId: campusA.id,
      });
      await grantCustomRole(
        reviewer.id,
        [
          "report.review",
          "verification.review",
          "appeal.review",
          "dispute.review",
          "support.manage",
        ],
        campusA.id,
      );

      const { loadOperationsOverview } = await import("@/lib/governance/operations-overview-query");
      const { deriveReportReviewAccess } = await import("@/lib/reports/report-access");
      const { deriveVerificationReviewAccess } = await import("@/lib/campus/verification-review-access");
      const { deriveAppealReviewAccess } = await import("@/lib/appeals/reviewer-access");
      const { deriveDisputeReviewAccess } = await import("@/lib/disputes/dispute-access");
      const { deriveSupportManageAccess } = await import("@/lib/support/support-access");
      const { loadAuthorizationContext } = await import("@/lib/rbac/service");
      const { loadAuthorizedReportQueue } = await import("@/lib/reports/report-query");
      const { loadAuthorizedVerificationQueue } = await import("@/lib/campus/verification-review-query");
      const { loadAuthorizedAppealQueue } = await import("@/lib/appeals/review-queue");
      const { loadAuthorizedDisputeQueue } = await import("@/lib/disputes/dispute-query");
      const { loadAuthorizedSupportQueue } = await import("@/lib/support/support-query");

      const reviewerContext = await loadAuthorizationContext(reviewer.id);
      const access = {
        reports: deriveReportReviewAccess(reviewerContext),
        verifications: deriveVerificationReviewAccess(reviewerContext),
        appeals: deriveAppealReviewAccess(reviewerContext),
        disputes: deriveDisputeReviewAccess(reviewerContext),
        support: deriveSupportManageAccess(reviewerContext),
      };
      // campus reviewer：五域 access 全为 campus-scoped（无 GLOBAL）
      expect(access.reports).toEqual({ global: false, campusIds: [campusA.id] });
      expect(access.support).toEqual({ global: false, campusIds: [campusA.id] });

      const summaries = await loadOperationsOverview({ viewerId: reviewer.id, ...access });
      const byDomain = new Map(summaries.map((summary) => [summary.domain, summary]));
      expect(summaries).toHaveLength(5);

      // canonical queue（campus reviewer 的 scope 谓词天然限于 campus A）
      const reportQueue = await loadAuthorizedReportQueue({
        viewerId: reviewer.id,
        access: access.reports,
        limit: 50,
      });
      const verificationQueue = await loadAuthorizedVerificationQueue({
        access: access.verifications,
        limit: 50,
      });
      const appealQueue = await loadAuthorizedAppealQueue({
        viewerId: reviewer.id,
        access: access.appeals,
        limit: 50,
      });
      const disputeQueue = await loadAuthorizedDisputeQueue({
        viewerId: reviewer.id,
        access: access.disputes,
        limit: 50,
      });
      const supportQueue = await loadAuthorizedSupportQueue({
        viewerId: reviewer.id,
        access: access.support,
        limit: 50,
      });

      // reports：queue 全量 3 行（2 active + 1 closed）；dashboard 只计 active
      expect(reportQueue.items).toHaveLength(3);
      expect(byDomain.get("reports")!.activeCount).toBe(2);
      expect(byDomain.get("reports")!.activeCount).toBe(
        await rawClient!.moderationCase.count({
          where: { campusId: campusA.id, scopeKey: `CAMPUS:${campusA.id}`, closedAt: null },
        }),
      );

      // verifications：queue 全量 1 行（PENDING 即 active）
      expect(verificationQueue.items).toHaveLength(1);
      expect(verificationQueue.items[0]!.status).toBe("PENDING");
      expect(byDomain.get("verifications")!.activeCount).toBe(1);

      // appeal 队列本身即 active 预过滤（QUEUE_STATUSES）
      expect(byDomain.get("appeals")!.activeCount).toBe(1);
      expect(appealQueue.items).toHaveLength(1);

      expect(byDomain.get("disputes")!.activeCount).toBe(1);
      expect(disputeQueue.items).toHaveLength(1);
      expect(disputeQueue.items[0]!.status).toBe("OPEN");

      expect(byDomain.get("support")!.activeCount).toBe(1);
      expect(supportQueue.items).toHaveLength(2); // 1 active + 1 RESOLVED
      expect(
        supportQueue.items.filter((item) => item.status === "OPEN" || item.status === "IN_PROGRESS"),
      ).toHaveLength(1);

      // overdue（各域 SLA truth）：reports 1（超时 fixture）、disputes 1（超时 fixture）
      expect(byDomain.get("reports")!.overdueCount).toBe(1);
      expect(byDomain.get("disputes")!.overdueCount).toBe(1);
      expect(byDomain.get("verifications")!.overdueCount).toBe(0);
      expect(byDomain.get("appeals")!.overdueCount).toBe(0);
      expect(byDomain.get("support")!.overdueCount).toBe(0);

      // assignedToMe 仅 assignment 域携带
      expect(byDomain.get("reports")!.assignedToMeCount).toBeDefined();
      expect(byDomain.get("disputes")!.assignedToMeCount).toBeDefined();
      expect(byDomain.get("support")!.assignedToMeCount).toBeDefined();
      expect(byDomain.get("verifications")!.assignedToMeCount).toBeUndefined();
      expect(byDomain.get("appeals")!.assignedToMeCount).toBeUndefined();

      // oldestDueAt 为合法 ISO 时间戳
      for (const domain of ["reports", "verifications", "appeals", "disputes", "support"] as const) {
        expect(new Date(byDomain.get(domain)!.oldestDueAt!).getTime()).not.toBeNaN();
      }

      // O05：campus reviewer 绝不见 UNSCOPED —— access 谓词结构性限制
      const unscopedTicket = await createSupportTicketRow({
        requesterId: reporter.id,
        campusId: null,
        scopeKey: "UNSCOPED",
      });
      const campusSupportQueue = await loadAuthorizedSupportQueue({
        viewerId: reviewer.id,
        access: access.support,
        limit: 50,
      });
      expect(campusSupportQueue.items.some((item) => item.ticketId === unscopedTicket.id)).toBe(false);

      // GLOBAL 视角（邻近查询对；UNSCOPED + 他校区行使 GLOBAL 严格大于 campus 视角）
      const adminContext = await loadAuthorizationContext(platformAdmin.id);
      const globalSummaries = await loadOperationsOverview({
        viewerId: platformAdmin.id,
        reports: deriveReportReviewAccess(adminContext),
        verifications: deriveVerificationReviewAccess(adminContext),
        appeals: deriveAppealReviewAccess(adminContext),
        disputes: deriveDisputeReviewAccess(adminContext),
        support: deriveSupportManageAccess(adminContext),
      });
      const globalByDomain = new Map(globalSummaries.map((summary) => [summary.domain, summary]));
      const dbOpenCases = await rawClient!.moderationCase.count({ where: { closedAt: null } });
      expect(globalByDomain.get("reports")!.activeCount).toBe(dbOpenCases);
      expect(globalByDomain.get("reports")!.activeCount).toBeGreaterThan(
        byDomain.get("reports")!.activeCount,
      );
      expect(globalByDomain.get("support")!.activeCount).toBeGreaterThan(
        byDomain.get("support")!.activeCount,
      );
    });
  },
);
