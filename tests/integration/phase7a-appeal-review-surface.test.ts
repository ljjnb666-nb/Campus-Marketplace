import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PERMISSION_KEYS } from "@/lib/rbac/permissions";
import type { AppealQueueItemDto } from "@/lib/appeals/review-queue";

/**
 * Phase 7A Appeal Review Operations Surface 集成测试（真实 PostgreSQL）。
 *
 * 覆盖（Planning Repair 1/2 + 实现指令冻结）：
 *  - ROLE_ASSIGN_01..07：GLOBAL/CAMPUS rbac.role.assign 授权矩阵（7A 窄修）
 *  - Q-01A..Q-10：授权队列读模型（exact-pair DB 级过滤 / GLOBAL 宽度 / cursor）
 *  - A-01..A-18：详情授权 + capability hints + 域动作 + decisionNote 隔离
 *  - M-1..M-5：data-only migration（fresh/二次 no-pending/自然键幂等收敛/
 *    assignment 零触碰）+ ensureRbacFoundation bootstrap 收敛
 *
 * 并发全部确定性：advisory lock / row lock / racePoint / promise barrier；
 * 零 sleep、零随机重试。合成 seq 值段与其它集成文件严格不相交。
 */

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

// 领域服务（@/lib/prisma 单例）与 rawClient 同库：本地 = DATABASE_URL（.env），
// CI = INTEGRATION_DATABASE_URL（无 .env 时 rawClient 回退同源）。
const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p7a-${randomUUID().slice(0, 8)}`;
const NEW_MIGRATION = "20260912120000_phase7a_campus_appeal_reviewer_role";
const SYSTEM_REVIEWER_ROLE_KEY = "CAMPUS_APPEAL_REVIEWER";
const createdUserIds: string[] = [];
const createdCampusIds: string[] = [];
const createdRoleIds: string[] = [];

const BOUNDARY = BigInt(1_000_000_000);
// 与 phase6c-* 文件的合成 seq 值段严格不相交（vitest 并行文件共用同一 DB）
const SYNTHETIC_SEQ_BASE = BOUNDARY + BigInt(7_000_000);
let syntheticSeqCursor = 0;
function nextSyntheticSeq(): bigint {
  syntheticSeqCursor += 1;
  return SYNTHETIC_SEQ_BASE + BigInt(syntheticSeqCursor);
}

// ── fixture helpers（与 6C-1B 同款约定）──────────────────────────────────────

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
  options: {
    role?: "STUDENT" | "ADMIN";
    status?: "ACTIVE" | "SUSPENDED";
    membership?: boolean;
    membershipStatus?: "ACTIVE" | "SUSPENDED" | "LEFT";
  } = {},
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
  if (campusId && (options.membership ?? true)) {
    await rawClient!.campusMembership.create({
      data: {
        userId: user.id,
        campusId,
        status: options.membershipStatus ?? "ACTIVE",
      },
    });
  }
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

/** 直插 malformed / legacy 形状 EA 行（合成 seq；参数化 raw SQL） */
async function insertRawAction(data: {
  type: string;
  actorId: string;
  targetId: string;
  campusId?: string | null;
  scopeKey: string;
  previousState?: string | null;
  resultState: string;
}) {
  const id = `p7a-ea-${randomUUID()}`;
  await rawClient!.$executeRaw`
    INSERT INTO "EnforcementAction"
      ("id", "type", "actorId", "targetId", "campusId", "scopeKey", "reasonCode",
       "note", "sourceType", "sourceId", "previousState", "resultState", "enforcementSeq")
    VALUES (${id}, ${data.type}::"EnforcementActionType", ${data.actorId}, ${data.targetId},
            ${data.campusId ?? null}, ${data.scopeKey}, 'MANUAL_REVIEW',
            NULL, NULL, NULL, ${data.previousState ?? null}, ${data.resultState}, ${nextSyntheticSeq()})`;
  return id;
}

async function createAppealRow(enforcementActionId: string, statement = "集成测试申诉材料") {
  return rawClient!.appeal.create({
    data: { enforcementActionId, status: "SUBMITTED", statement },
  });
}

async function deriveAccess(userId: string) {
  const { loadAuthorizationContext } = await import("@/lib/rbac/service");
  const { deriveAppealReviewAccess } = await import("@/lib/appeals/reviewer-access");
  const context = await loadAuthorizationContext(userId);
  return { context, access: deriveAppealReviewAccess(context) };
}

function errorCodeOf(error: unknown): string {
  return (error as { code?: string })?.code ?? "";
}

function itemIds(items: AppealQueueItemDto[]): string[] {
  return items.map((item) => item.id);
}

// ── prisma CLI / 临时库（migration 验证，无 shell 注入）──────────────────────

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

function runPrismaDbExecute(sql: string, databaseUrl: string): void {
  runPrismaCli(["db", "execute", "--schema", "prisma/schema.prisma", "--stdin"], databaseUrl, sql);
}

function swapDatabaseName(databaseUrl: string, name: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${name}`;
  parsed.search = "";
  return parsed.toString();
}

async function createTempDatabase(dbName: string): Promise<string> {
  const maintenanceUrl = swapDatabaseName(integrationDatabaseUrl!, "postgres");
  runPrismaDbExecute(`DROP DATABASE IF EXISTS "${dbName}";`, maintenanceUrl);
  runPrismaDbExecute(`CREATE DATABASE "${dbName}";`, maintenanceUrl);
  return swapDatabaseName(integrationDatabaseUrl!, dbName);
}

async function dropTempDatabase(dbName: string): Promise<void> {
  const maintenanceUrl = swapDatabaseName(integrationDatabaseUrl!, "postgres");
  try {
    runPrismaDbExecute(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE);`, maintenanceUrl);
  } catch {
    // CI/本地偶发连接残留：FORCE 已尽力，不影响主流程断言
  }
}

// ── 测试主体 ────────────────────────────────────────────────────────────────

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 7A appeal review operations surface 集成测试（真实 PostgreSQL）",
  () => {
    let campusA: { id: string };
    let campusB: { id: string };
    let enforcer: { id: string };
    let globalAdmin: { id: string };
    let campusRoleManagerA: { id: string };
    let globalReviewer: { id: string };
    let globalReviewOnly: { id: string };
    let campusReviewerA: { id: string };
    let campusReviewerB: { id: string };
    let campusReviewerAB: { id: string };

    beforeAll(async () => {
      campusA = await createFixtureCampus("campus-a");
      campusB = await createFixtureCampus("campus-b");

      enforcer = await createFixtureUser("执法员", campusA.id);
      globalAdmin = await createFixtureUser("全局授权管理员", campusA.id);
      campusRoleManagerA = await createFixtureUser("校区A角色管理员", campusA.id);
      // 全局审核员（零 membership 语义由 Q-01 系列用无 membership 用户另测）
      globalReviewer = await createFixtureUser("全局审核员", campusA.id);
      globalReviewOnly = await createFixtureUser("仅审核权全局审核员", campusA.id);
      campusReviewerA = await createFixtureUser("校区A审核员", campusA.id);
      campusReviewerB = await createFixtureUser("校区B审核员", campusB.id);
      campusReviewerAB = await createFixtureUser("AB双校区审核员", campusA.id);
      // A+B 双授权：B 校区亦须 ACTIVE membership（deriveAppealReviewAccess 语义）
      await rawClient!.campusMembership.create({
        data: { userId: campusReviewerAB.id, campusId: campusB.id, status: "ACTIVE" },
      });

      // enforcer 兼具 appeal.review：A-04（reviewer==原执法 actor=self-review）需要
      await grantRole(
        enforcer.id,
        "ENFORCER",
        ["user.suspend", "campus.manage", "appeal.review"],
        "GLOBAL",
      );
      await grantRole(globalAdmin.id, "GLOBAL_ASSIGNER", ["rbac.role.assign"], "GLOBAL");
      await grantRole(
        campusRoleManagerA.id,
        "CAMPUS_ASSIGNER_A",
        ["rbac.role.assign"],
        "CAMPUS",
        campusA.id,
      );
      await grantRole(
        globalReviewer.id,
        "REVIEWER_GLOBAL",
        ["appeal.review", "user.suspend", "campus.manage"],
        "GLOBAL",
      );
      await grantRole(globalReviewOnly.id, "REVIEWER_GLOBAL_ONLY", ["appeal.review"], "GLOBAL");
      await grantRole(
        campusReviewerA.id,
        "REVIEWER_A",
        ["appeal.review", "campus.manage"],
        "CAMPUS",
        campusA.id,
      );
      await grantRole(campusReviewerB.id, "REVIEWER_B", ["appeal.review"], "CAMPUS", campusB.id);
      await grantRole(
        campusReviewerAB.id,
        "REVIEWER_AB",
        ["appeal.review"],
        "CAMPUS",
        campusA.id,
      );
      await grantRole(
        campusReviewerAB.id,
        "REVIEWER_AB_B",
        ["appeal.review"],
        "CAMPUS",
        campusB.id,
      );
    }, 60_000);

    afterAll(async () => {
      await rawClient!.appeal.deleteMany({
        where: { enforcementAction: { targetId: { in: createdUserIds } } },
      });
      await rawClient!.enforcementAction.deleteMany({
        where: {
          OR: [
            { targetId: { in: createdUserIds } },
            { enforcementSeq: { gte: SYNTHETIC_SEQ_BASE, lt: SYNTHETIC_SEQ_BASE + BigInt(1_000) } },
          ],
        },
      });
      await rawClient!.adminLog.deleteMany({ where: { adminId: { in: createdUserIds } } });
      await rawClient!.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
      await rawClient!.riskFlag.deleteMany({ where: { userId: { in: createdUserIds } } });
      await rawClient!.riskState.deleteMany({ where: { userId: { in: createdUserIds } } });
      await rawClient!.campusMembership.deleteMany({ where: { userId: { in: createdUserIds } } });
      await rawClient!.userRoleAssignment.deleteMany({ where: { userId: { in: createdUserIds } } });
      await rawClient!.rolePermission.deleteMany({ where: { roleId: { in: createdRoleIds } } });
      await rawClient!.role.deleteMany({ where: { id: { in: createdRoleIds } } });
      await rawClient!.user.deleteMany({ where: { id: { in: createdUserIds } } });
      await rawClient!.campus.deleteMany({ where: { id: { in: createdCampusIds } } });
      await rawClient!.$disconnect();
    });

    // ======================================================================
    // ROLE_ASSIGN_01..07：7A 窄修后的角色授予授权矩阵
    // ======================================================================

    it("ROLE_ASSIGN_01：GLOBAL PLATFORM_ADMIN 式 actor 授予 CAMPUS_APPEAL_REVIEWER@A → success", async () => {
      const target = await createFixtureUser("RA01目标", campusA.id);
      const { assignRole } = await import("@/lib/rbac/assignment-service");

      const { assignment, created } = await assignRole({
        actorId: globalAdmin.id,
        targetUserId: target.id,
        roleKey: SYSTEM_REVIEWER_ROLE_KEY,
        campusId: campusA.id,
      });

      expect(created).toBe(true);
      expect(assignment.campusId).toBe(campusA.id);
      expect(assignment.scopeKey).toBe(`CAMPUS:${campusA.id}`);

      // AdminAudit：ROLE_ASSIGNED + assignedById
      const audit = await rawClient!.adminLog.findFirst({
        where: { action: "ROLE_ASSIGNED", targetId: target.id },
      });
      expect(audit?.adminId).toBe(globalAdmin.id);
      expect(audit?.campusId).toBe(campusA.id);

      // 授予立即生效（无缓存）
      const { access } = await deriveAccess(target.id);
      expect(access).toEqual({ global: false, campusIds: [campusA.id] });
    });

    it("ROLE_ASSIGN_02：同一 GLOBAL actor 撤回 → success（审计 + 幂等 no-op）", async () => {
      const target = await createFixtureUser("RA02目标", campusA.id);
      const { assignRole, revokeRole } = await import("@/lib/rbac/assignment-service");

      await assignRole({
        actorId: globalAdmin.id,
        targetUserId: target.id,
        roleKey: SYSTEM_REVIEWER_ROLE_KEY,
        campusId: campusA.id,
      });

      const revoked = await revokeRole({
        actorId: globalAdmin.id,
        targetUserId: target.id,
        roleKey: SYSTEM_REVIEWER_ROLE_KEY,
        campusId: campusA.id,
      });
      expect(revoked.removed).toBe(true);

      const audit = await rawClient!.adminLog.findFirst({
        where: { action: "ROLE_REVOKED", targetId: target.id },
      });
      expect(audit?.adminId).toBe(globalAdmin.id);

      const again = await revokeRole({
        actorId: globalAdmin.id,
        targetUserId: target.id,
        roleKey: SYSTEM_REVIEWER_ROLE_KEY,
        campusId: campusA.id,
      });
      expect(again.removed).toBe(false);

      const { access } = await deriveAccess(target.id);
      expect(access).toEqual({ global: false, campusIds: [] });
    });

    it("ROLE_ASSIGN_03：campus A role-manager 授予 CAMPUS 角色@A → success", async () => {
      const target = await createFixtureUser("RA03目标", campusA.id);
      const { assignRole } = await import("@/lib/rbac/assignment-service");

      const { created } = await assignRole({
        actorId: campusRoleManagerA.id,
        targetUserId: target.id,
        roleKey: SYSTEM_REVIEWER_ROLE_KEY,
        campusId: campusA.id,
      });
      expect(created).toBe(true);
    });

    it("ROLE_ASSIGN_04：campus A role-manager 授予 CAMPUS 角色@B → DENY", async () => {
      const target = await createFixtureUser("RA04目标", campusB.id);
      const { assignRole } = await import("@/lib/rbac/assignment-service");

      await expect(
        assignRole({
          actorId: campusRoleManagerA.id,
          targetUserId: target.id,
          roleKey: SYSTEM_REVIEWER_ROLE_KEY,
          campusId: campusB.id,
        }),
      ).rejects.toMatchObject({ code: "ROLE_ASSIGNMENT_CAMPUS_MISMATCH" });
    });

    it("ROLE_ASSIGN_05：campus role-manager 授予 GLOBAL 角色 → DENY", async () => {
      const target = await createFixtureUser("RA05目标", campusA.id);
      const { assignRole } = await import("@/lib/rbac/assignment-service");

      await expect(
        assignRole({
          actorId: campusRoleManagerA.id,
          targetUserId: target.id,
          roleKey: `${RUN_TAG}-REVIEWER_GLOBAL_ONLY`,
          campusId: null,
        }),
      ).rejects.toMatchObject({ code: "ROLE_ASSIGNMENT_CAMPUS_MISMATCH" });
    });

    it("ROLE_ASSIGN_06：target membership 非 ACTIVE → DENY", async () => {
      const target = await createFixtureUser("RA06目标", campusA.id, {
        membershipStatus: "SUSPENDED",
      });
      const { assignRole } = await import("@/lib/rbac/assignment-service");

      await expect(
        assignRole({
          actorId: globalAdmin.id,
          targetUserId: target.id,
          roleKey: SYSTEM_REVIEWER_ROLE_KEY,
          campusId: campusA.id,
        }),
      ).rejects.toMatchObject({ code: "ROLE_ASSIGNMENT_TARGET_MEMBERSHIP_INACTIVE" });
    });

    it("ROLE_ASSIGN_07：actor 在治理锁等待期间被撤权 → post-lock DENY（确定性）", async () => {
      const target = await createFixtureUser("RA07目标", campusA.id);
      // 先给 target 一个 GLOBAL 角色，使 actor+target 都参与锁序
      await grantRole(target.id, "RA07_TARGET_ROLE", ["report.review"], "GLOBAL");
      const { assignRole } = await import("@/lib/rbac/assignment-service");

      // actor 的 GLOBAL rbac.role.assign assignment 行
      const actorAssignment = await rawClient!.userRoleAssignment.findFirst({
        where: { userId: globalAdmin.id, role: { key: `${RUN_TAG}-GLOBAL_ASSIGNER` } },
      });
      expect(actorAssignment).toBeTruthy();

      let releaseRace!: () => void;
      const releaseGate = new Promise<void>((resolve) => {
        releaseRace = resolve;
      });

      const attempt = assignRole({
        actorId: globalAdmin.id,
        targetUserId: target.id,
        roleKey: SYSTEM_REVIEWER_ROLE_KEY,
        campusId: campusA.id,
        // racePoint：完整 sorted 锁已取得、授权重读尚未执行
        racePoint: async () => {
          // 独立连接撤权（advisory 锁不锁 UserRoleAssignment 行，立即生效）
          await rawClient!.userRoleAssignment.delete({
            where: { id: actorAssignment!.id },
          });
          releaseRace();
        },
      });

      await releaseGate;
      await expect(attempt).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });
    }, 30_000);

    // ======================================================================
    // Q-01A..Q-10：授权队列读模型
    // ======================================================================

    async function makeSuspendedAccountAppeal(name: string) {
      const target = await createFixtureUser(name, campusA.id);
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      await suspendAccount({
        actorId: enforcer.id,
        targetUserId: target.id,
        reasonCode: "POLICY_VIOLATION",
      });
      const ea = await rawClient!.enforcementAction.findFirstOrThrow({
        where: { targetId: target.id, type: "ACCOUNT_SUSPEND" },
        orderBy: { enforcementSeq: "desc" },
      });
      const appeal = await createAppealRow(ea.id);
      return { target, ea, appeal };
    }

    it("Q-01A/B/C：GLOBAL reviewer 零 membership → GLOBAL 形 + 任意校区 canonical 形可见，malformed 不可见", async () => {
      // 零 ACTIVE membership 的 GLOBAL 审核员（User.campusId 非空为展示字段，无 membership 行）
      const noMembershipReviewer = await createFixtureUser("Q01零mship全局审核员", campusA.id, {
        membership: false,
      });
      await grantRole(noMembershipReviewer.id, "Q01_REVIEWER", ["appeal.review"], "GLOBAL");

      const globalAppeal = await makeSuspendedAccountAppeal("Q01GLOBAL目标");
      // 校区 A 的 MEMBERSHIP_SUSPEND appeal
      const membershipTarget = await createFixtureUser("Q01成员目标", campusA.id);
      const { suspendCampusMembership } = await import(
        "@/lib/enforcement/membership-enforcement-service"
      );
      await suspendCampusMembership({
        actorId: enforcer.id,
        targetUserId: membershipTarget.id,
        campusId: campusA.id,
        reasonCode: "POLICY_VIOLATION",
      });
      const membershipEa = await rawClient!.enforcementAction.findFirstOrThrow({
        where: { targetId: membershipTarget.id, type: "MEMBERSHIP_SUSPEND" },
        orderBy: { enforcementSeq: "desc" },
      });
      const campusAppeal = await createAppealRow(membershipEa.id);

      // malformed 交叉对：campusId=A / scopeKey=CAMPUS:B
      const malformedId = await insertRawAction({
        type: "MEMBERSHIP_SUSPEND",
        actorId: enforcer.id,
        targetId: (await createFixtureUser("Q01malformed目标", campusA.id)).id,
        campusId: campusA.id,
        scopeKey: `CAMPUS:${campusB.id}`,
        previousState: "CAMPUS_MEMBERSHIP:ACTIVE",
        resultState: "CAMPUS_MEMBERSHIP:SUSPENDED",
      });
      const malformedAppeal = await createAppealRow(malformedId);

      const { access } = await deriveAccess(noMembershipReviewer.id);
      expect(access).toEqual({ global: true, campusIds: [] });

      const { loadAuthorizedAppealQueue } = await import("@/lib/appeals/review-queue");
      const page = await loadAuthorizedAppealQueue({
        viewerId: noMembershipReviewer.id,
        access,
        limit: 50,
      });
      const ids = itemIds(page.items);

      expect(ids).toContain(globalAppeal.appeal.id); // Q-01A
      expect(ids).toContain(campusAppeal.id); // Q-01B（零 membership 仍可见）
      expect(ids).not.toContain(malformedAppeal.id); // Q-01C

      // scope 展示正确
      const globalItem = page.items.find((i) => i.id === globalAppeal.appeal.id)!;
      expect(globalItem.scopeKind).toBe("GLOBAL");
      const campusItem = page.items.find((i) => i.id === campusAppeal.id)!;
      expect(campusItem.scopeKind).toBe("CAMPUS");
    });

    it("Q-02/Q-03/Q-04：campus A reviewer 见 A、不见 B、不见 GLOBAL", async () => {
      const membershipTargetA = await createFixtureUser("Q02成员目标A", campusA.id);
      const { suspendCampusMembership } = await import(
        "@/lib/enforcement/membership-enforcement-service"
      );
      await suspendCampusMembership({
        actorId: enforcer.id,
        targetUserId: membershipTargetA.id,
        campusId: campusA.id,
        reasonCode: "POLICY_VIOLATION",
      });
      const eaA = await rawClient!.enforcementAction.findFirstOrThrow({
        where: { targetId: membershipTargetA.id, type: "MEMBERSHIP_SUSPEND" },
        orderBy: { enforcementSeq: "desc" },
      });
      const appealA = await createAppealRow(eaA.id);

      const membershipTargetB = await createFixtureUser("Q03成员目标B", campusB.id);
      await suspendCampusMembership({
        actorId: enforcer.id,
        targetUserId: membershipTargetB.id,
        campusId: campusB.id,
        reasonCode: "POLICY_VIOLATION",
      });
      const eaB = await rawClient!.enforcementAction.findFirstOrThrow({
        where: { targetId: membershipTargetB.id, type: "MEMBERSHIP_SUSPEND" },
        orderBy: { enforcementSeq: "desc" },
      });
      const appealB = await createAppealRow(eaB.id);

      const globalAppeal = await makeSuspendedAccountAppeal("Q04GLOBAL目标");

      const { access: accessA } = await deriveAccess(campusReviewerA.id);
      const { loadAuthorizedAppealQueue } = await import("@/lib/appeals/review-queue");
      const page = await loadAuthorizedAppealQueue({
        viewerId: campusReviewerA.id,
        access: accessA,
        limit: 50,
      });
      const ids = itemIds(page.items);
      expect(ids).toContain(appealA.id); // Q-02
      expect(ids).not.toContain(appealB.id); // Q-03
      expect(ids).not.toContain(globalAppeal.appeal.id); // Q-04
    });

    it("Q-05/Q-06：membership 失活 / 权限撤销移除可见性", async () => {
      const membershipTarget = await createFixtureUser("Q05成员目标", campusA.id);
      const { suspendCampusMembership } = await import(
        "@/lib/enforcement/membership-enforcement-service"
      );
      await suspendCampusMembership({
        actorId: enforcer.id,
        targetUserId: membershipTarget.id,
        campusId: campusA.id,
        reasonCode: "POLICY_VIOLATION",
      });
      const ea = await rawClient!.enforcementAction.findFirstOrThrow({
        where: { targetId: membershipTarget.id, type: "MEMBERSHIP_SUSPEND" },
        orderBy: { enforcementSeq: "desc" },
      });
      const appeal = await createAppealRow(ea.id);

      const reviewer = await createFixtureUser("Q05审核员", campusA.id);
      const role = await grantRole(reviewer.id, "Q05_REVIEWER", ["appeal.review"], "CAMPUS", campusA.id);

      const { loadAuthorizedAppealQueue } = await import("@/lib/appeals/review-queue");

      // 基线：可见
      const before = await deriveAccess(reviewer.id);
      const pageBefore = await loadAuthorizedAppealQueue({
        viewerId: reviewer.id,
        access: before.access,
        limit: 50,
      });
      expect(itemIds(pageBefore.items)).toContain(appeal.id);

      // Q-05：membership SUSPENDED → 可见性消失
      await rawClient!.campusMembership.updateMany({
        where: { userId: reviewer.id, campusId: campusA.id },
        data: { status: "SUSPENDED" },
      });
      const afterSuspend = await deriveAccess(reviewer.id);
      const pageSuspended = await loadAuthorizedAppealQueue({
        viewerId: reviewer.id,
        access: afterSuspend.access,
        limit: 50,
      });
      expect(itemIds(pageSuspended.items)).not.toContain(appeal.id);

      // 恢复 membership 后 Q-06：permission 撤销 → 可见性消失
      await rawClient!.campusMembership.updateMany({
        where: { userId: reviewer.id, campusId: campusA.id },
        data: { status: "ACTIVE" },
      });
      await rawClient!.userRoleAssignment.deleteMany({
        where: { userId: reviewer.id, roleId: role.id },
      });
      const afterRevoke = await deriveAccess(reviewer.id);
      const pageRevoked = await loadAuthorizedAppealQueue({
        viewerId: reviewer.id,
        access: afterRevoke.access,
        limit: 50,
      });
      expect(itemIds(pageRevoked.items)).not.toContain(appeal.id);
    });

    it("Q-07/Q-07B：malformed scope fail closed（含 A+B 授权者不可见交叉对）", async () => {
      const crossPairId = await insertRawAction({
        type: "MARKETPLACE_RESTRICT",
        actorId: enforcer.id,
        targetId: (await createFixtureUser("Q07B目标", campusA.id)).id,
        campusId: campusA.id,
        scopeKey: `CAMPUS:${campusB.id}`,
        previousState: `RISK_STATE:NORMAL@CAMPUS:${campusB.id}`,
        resultState: `RISK_STATE:RESTRICTED@CAMPUS:${campusB.id}`,
      });
      const crossAppeal = await createAppealRow(crossPairId);

      const nullPairId = await insertRawAction({
        type: "MEMBERSHIP_SUSPEND",
        actorId: enforcer.id,
        targetId: (await createFixtureUser("Q07目标", campusA.id)).id,
        campusId: null,
        scopeKey: `CAMPUS:${campusA.id}`,
        previousState: "CAMPUS_MEMBERSHIP:ACTIVE",
        resultState: "CAMPUS_MEMBERSHIP:SUSPENDED",
      });
      const nullAppeal = await createAppealRow(nullPairId);

      const { access: accessAB } = await deriveAccess(campusReviewerAB.id);
      expect(accessAB).toEqual({ global: false, campusIds: [campusA.id, campusB.id] });

      const { loadAuthorizedAppealQueue } = await import("@/lib/appeals/review-queue");
      const page = await loadAuthorizedAppealQueue({
        viewerId: campusReviewerAB.id,
        access: accessAB,
        limit: 50,
      });
      const ids = itemIds(page.items);
      expect(ids).not.toContain(crossAppeal.id); // Q-07B：授权 A+B 也不见 campusId=A/scopeKey=CAMPUS:B
      expect(ids).not.toContain(nullAppeal.id); // Q-07
    });

    it("Q-08：cursor 不能绕过 scope 过滤", async () => {
      const globalAppeal = await makeSuspendedAccountAppeal("Q08GLOBAL目标");
      const membershipTargetB = await createFixtureUser("Q08成员目标B", campusB.id);
      const { suspendCampusMembership } = await import(
        "@/lib/enforcement/membership-enforcement-service"
      );
      await suspendCampusMembership({
        actorId: enforcer.id,
        targetUserId: membershipTargetB.id,
        campusId: campusB.id,
        reasonCode: "POLICY_VIOLATION",
      });
      const eaB = await rawClient!.enforcementAction.findFirstOrThrow({
        where: { targetId: membershipTargetB.id, type: "MEMBERSHIP_SUSPEND" },
        orderBy: { enforcementSeq: "desc" },
      });
      const appealB = await createAppealRow(eaB.id);

      const { encodeAppealCursor } = await import("@/validators/appeal");
      const globalRow = await rawClient!.appeal.findUniqueOrThrow({
        where: { id: globalAppeal.appeal.id },
        select: { createdAt: true },
      });
      const cursorFromGlobalReviewer = encodeAppealCursor({
        createdAt: globalRow.createdAt,
        id: globalAppeal.appeal.id,
      });

      const { access: accessA } = await deriveAccess(campusReviewerA.id);
      const { loadAuthorizedAppealQueue, } = await import("@/lib/appeals/review-queue");
      const { decodeAppealCursor } = await import("@/validators/appeal");
      const page = await loadAuthorizedAppealQueue({
        viewerId: campusReviewerA.id,
        access: accessA,
        cursor: decodeAppealCursor(cursorFromGlobalReviewer)!,
        limit: 50,
      });
      expect(itemIds(page.items)).not.toContain(appealB.id);
    });

    it("Q-09：队列有界（take=limit+1 / keyset 严格推进 / 跨页无重复）", async () => {
      const { access } = await deriveAccess(globalReviewer.id);
      const { loadAuthorizedAppealQueue } = await import("@/lib/appeals/review-queue");
      const { decodeAppealCursor } = await import("@/validators/appeal");

      const page1 = await loadAuthorizedAppealQueue({
        viewerId: globalReviewer.id,
        access,
        limit: 2,
      });
      // 有界：绝不返回超过 limit 的行
      expect(page1.items.length).toBeLessThanOrEqual(2);

      if (page1.nextCursor) {
        const page2 = await loadAuthorizedAppealQueue({
          viewerId: globalReviewer.id,
          access,
          cursor: decodeAppealCursor(page1.nextCursor)!,
          limit: 2,
        });
        expect(page2.items.length).toBeLessThanOrEqual(2);

        // keyset 语义：page2 全部严格"不晚于"page1 末行（createdAt DESC, id DESC）
        const last1 = page1.items[page1.items.length - 1]!;
        for (const item of page2.items) {
          expect(item.createdAt <= last1.createdAt).toBe(true);
        }
        // 跨页无重复
        const page1Ids = new Set(itemIds(page1.items));
        for (const id of itemIds(page2.items)) {
          expect(page1Ids.has(id)).toBe(false);
        }
      }
    });

    it("Q-10：terminal/WITHDRAWN 不出现在默认队列", async () => {
      const { appeal: submittedAppeal } = await makeSuspendedAccountAppeal("Q10目标");
      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      await decideAppeal({
        reviewerId: globalReviewer.id,
        appealId: submittedAppeal.id,
        decision: "UPHELD",
      });

      const withdrawnTarget = await createFixtureUser("Q10撤回目标", campusA.id);
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      await suspendAccount({
        actorId: enforcer.id,
        targetUserId: withdrawnTarget.id,
        reasonCode: "POLICY_VIOLATION",
      });
      const withdrawnEa = await rawClient!.enforcementAction.findFirstOrThrow({
        where: { targetId: withdrawnTarget.id, type: "ACCOUNT_SUSPEND" },
        orderBy: { enforcementSeq: "desc" },
      });
      const withdrawnAppeal = await createAppealRow(withdrawnEa.id);
      const { withdrawAppeal } = await import("@/lib/appeals/appeal-service");
      await withdrawAppeal({ callerUserId: withdrawnTarget.id, appealId: withdrawnAppeal.id });

      const { access } = await deriveAccess(globalReviewer.id);
      const { loadAuthorizedAppealQueue } = await import("@/lib/appeals/review-queue");
      const page = await loadAuthorizedAppealQueue({
        viewerId: globalReviewer.id,
        access,
        limit: 50,
      });
      const ids = itemIds(page.items);
      expect(ids).not.toContain(submittedAppeal.id);
      expect(ids).not.toContain(withdrawnAppeal.id);
    });

    // ======================================================================
    // A-01..A-18：详情授权 / capability hints / 域动作 / 机密隔离
    // ======================================================================

    async function loadDetail(viewerId: string, appealId: string) {
      const { context, access } = await deriveAccess(viewerId);
      const { loadAuthorizedAppealDetail } = await import("@/lib/appeals/review-queue");
      if (!context) {
        return { ok: false as const };
      }
      return loadAuthorizedAppealDetail({ viewerId, context, access, appealId });
    }

    it("A-01：授权 reviewer 打开合格 Appeal 详情（DTO 最小面）", async () => {
      const { target, ea, appeal } = await makeSuspendedAccountAppeal("A01目标");
      const result = await loadDetail(globalReviewer.id, appeal.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.detail.id).toBe(appeal.id);
      expect(result.detail.status).toBe("SUBMITTED");
      expect(result.detail.statement).toContain("集成测试申诉材料");
      expect(result.detail.appellantName).toBe("A01目标");
      expect(result.detail.enforcement.type).toBe("ACCOUNT_SUSPEND");
      expect(result.detail.enforcement.scopeKind).toBe("GLOBAL");
      expect(result.detail.enforcement.previousState).toBe("USER:ACTIVE");
      expect(result.detail.selfReview).toBe(false);
      // W1：SUBMITTED 仅呈现 begin；终局控件（含 canGrant 提示）IN_REVIEW 才出现
      expect(result.capabilities).toEqual({
        canBeginReview: true,
        canUphold: false,
        canGrant: false,
      });
      // DTO 结构性最小面：不含禁披露字段
      const keys = Object.keys(result.detail);
      expect(keys).not.toContain("decisionNote");
      void target;
      void ea;
    });

    it("A-02：未授权/不存在/malformed 统一不可枚举（ok:false）", async () => {
      const { appeal } = await makeSuspendedAccountAppeal("A02目标");

      // campus A reviewer 对 GLOBAL appeal
      const resultA = await loadDetail(campusReviewerA.id, appeal.id);
      expect(resultA.ok).toBe(false);
      // campus B reviewer 对 campus A appeal（MEMBERSHIP 形）
      const membershipTarget = await createFixtureUser("A02成员目标", campusA.id);
      const { suspendCampusMembership } = await import(
        "@/lib/enforcement/membership-enforcement-service"
      );
      await suspendCampusMembership({
        actorId: enforcer.id,
        targetUserId: membershipTarget.id,
        campusId: campusA.id,
        reasonCode: "POLICY_VIOLATION",
      });
      const eaA = await rawClient!.enforcementAction.findFirstOrThrow({
        where: { targetId: membershipTarget.id, type: "MEMBERSHIP_SUSPEND" },
        orderBy: { enforcementSeq: "desc" },
      });
      const appealA = await createAppealRow(eaA.id);
      const resultB = await loadDetail(campusReviewerB.id, appealA.id);
      expect(resultB.ok).toBe(false);
      // 不存在
      const resultMissing = await loadDetail(globalReviewer.id, "p7a-nonexistent");
      expect(resultMissing.ok).toBe(false);
      // malformed scope
      const malformedId = await insertRawAction({
        type: "MEMBERSHIP_SUSPEND",
        actorId: enforcer.id,
        targetId: (await createFixtureUser("A02malformed目标", campusA.id)).id,
        campusId: campusA.id,
        scopeKey: `CAMPUS:${campusB.id}`,
        previousState: "CAMPUS_MEMBERSHIP:ACTIVE",
        resultState: "CAMPUS_MEMBERSHIP:SUSPENDED",
      });
      const malformedAppeal = await createAppealRow(malformedId);
      const resultMalformed = await loadDetail(globalReviewer.id, malformedAppeal.id);
      expect(resultMalformed.ok).toBe(false);
    });

    it("A-03：reviewer == appellant → notFound 语义（ok:false）", async () => {
      const { target, appeal } = await makeSuspendedAccountAppeal("A03 appellant");
      // appellant 同时持有 GLOBAL appeal.review
      await grantRole(target.id, "A03_SELF_REVIEWER", ["appeal.review"], "GLOBAL");
      const result = await loadDetail(target.id, appeal.id);
      expect(result.ok).toBe(false);
    });

    it("A-04：reviewer == 原执法 actor → 允许 + selfReview 警示", async () => {
      const { appeal } = await makeSuspendedAccountAppeal("A04目标");
      const result = await loadDetail(enforcer.id, appeal.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.detail.selfReview).toBe(true);
      expect(result.capabilities.canUphold || result.capabilities.canBeginReview).toBe(true);
    });

    it("A-05：SUBMITTED → IN_REVIEW（begin 不写 reviewedById/reviewedAt）", async () => {
      const { appeal } = await makeSuspendedAccountAppeal("A05目标");
      const { beginAppealReview } = await import("@/lib/appeals/appeal-review-service");
      await beginAppealReview({ reviewerId: globalReviewer.id, appealId: appeal.id });

      const row = await rawClient!.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
      expect(row.status).toBe("IN_REVIEW");
      expect(row.reviewedById).toBeNull();
      expect(row.reviewedAt).toBeNull();

      // capability 随状态翻转（W1）：IN_REVIEW 呈现终局控件，canGrant 有恢复权
      const result = await loadDetail(globalReviewer.id, appeal.id);
      expect(result.ok && result.capabilities).toEqual({
        canBeginReview: false,
        canUphold: true,
        canGrant: true,
      });
    });

    it("A-06：非 SUBMITTED 再 begin → 安全拒绝", async () => {
      const { appeal } = await makeSuspendedAccountAppeal("A06目标");
      const { beginAppealReview } = await import("@/lib/appeals/appeal-review-service");
      await beginAppealReview({ reviewerId: globalReviewer.id, appealId: appeal.id });
      await expect(
        beginAppealReview({ reviewerId: globalReviewOnly.id, appealId: appeal.id }),
      ).rejects.toMatchObject({ code: "APPEAL_INVALID_TRANSITION" });
    });

    it("A-07：GRANTED → canonical restoration（Account/Membership/Risk-WATCH 三族）", async () => {
      // Account 族
      const accountCase = await makeSuspendedAccountAppeal("A07账号目标");
      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      const accountResult = await decideAppeal({
        reviewerId: globalReviewer.id,
        appealId: accountCase.appeal.id,
        decision: "GRANTED",
      });
      expect(accountResult.outcome).toBe("GRANTED");
      const restoredUser = await rawClient!.user.findUniqueOrThrow({
        where: { id: accountCase.target.id },
        select: { status: true },
      });
      expect(restoredUser.status).toBe("ACTIVE");

      // Membership 族
      const membershipTarget = await createFixtureUser("A07成员目标", campusA.id);
      const { suspendCampusMembership, reinstateCampusMembership } = await import(
        "@/lib/enforcement/membership-enforcement-service"
      );
      await suspendCampusMembership({
        actorId: enforcer.id,
        targetUserId: membershipTarget.id,
        campusId: campusA.id,
        reasonCode: "POLICY_VIOLATION",
      });
      const membershipEa = await rawClient!.enforcementAction.findFirstOrThrow({
        where: { targetId: membershipTarget.id, type: "MEMBERSHIP_SUSPEND" },
        orderBy: { enforcementSeq: "desc" },
      });
      const membershipAppeal = await createAppealRow(membershipEa.id);
      await decideAppeal({
        reviewerId: globalReviewer.id,
        appealId: membershipAppeal.id,
        decision: "GRANTED",
      });
      const restoredMembership = await rawClient!.campusMembership.findUniqueOrThrow({
        where: { userId_campusId: { userId: membershipTarget.id, campusId: campusA.id } },
        select: { status: true },
      });
      expect(restoredMembership.status).toBe("ACTIVE");
      void reinstateCampusMembership;

      // Risk 族：WATCH → RESTRICTED → GRANTED 恢复回 WATCH（绝不硬编码 NORMAL）
      const riskTarget = await createFixtureUser("A07风险目标", campusA.id);
      const { setRiskState } = await import("@/lib/enforcement/risk-service");
      await setRiskState({
        actorId: enforcer.id,
        targetUserId: riskTarget.id,
        campusId: null,
        state: "WATCH",
        reasonCode: "MANUAL_REVIEW",
      });
      await setRiskState({
        actorId: enforcer.id,
        targetUserId: riskTarget.id,
        campusId: null,
        state: "RESTRICTED",
        reasonCode: "FRAUD_CONFIRMED",
      });
      const riskEa = await rawClient!.enforcementAction.findFirstOrThrow({
        where: { targetId: riskTarget.id, type: "MARKETPLACE_RESTRICT" },
        orderBy: { enforcementSeq: "desc" },
      });
      expect(riskEa.previousState).toBe("RISK_STATE:WATCH@GLOBAL");
      const riskAppeal = await createAppealRow(riskEa.id);
      await decideAppeal({
        reviewerId: globalReviewer.id,
        appealId: riskAppeal.id,
        decision: "GRANTED",
      });
      const restoredRisk = await rawClient!.riskState.findUniqueOrThrow({
        where: { userId_scopeKey: { userId: riskTarget.id, scopeKey: "GLOBAL" } },
        select: { state: true },
      });
      expect(restoredRisk.state).toBe("WATCH");
    });

    it("A-08：UPHELD → 零 operational restoration", async () => {
      const { target, appeal } = await makeSuspendedAccountAppeal("A08目标");
      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      const result = await decideAppeal({
        reviewerId: globalReviewer.id,
        appealId: appeal.id,
        decision: "UPHELD",
      });
      expect(result.outcome).toBe("UPHELD");
      const user = await rawClient!.user.findUniqueOrThrow({
        where: { id: target.id },
        select: { status: true },
      });
      expect(user.status).toBe("SUSPENDED");
      const restoreCount = await rawClient!.enforcementAction.count({
        where: { targetId: target.id, type: "ACCOUNT_REINSTATE" },
      });
      expect(restoreCount).toBe(0);
    });

    it("A-09：operator 请求 GRANTED 但 stale/reversed/provenance 不足 → 成功提交式 DISMISSED", async () => {
      // stale：新同族 punitive 已 linearize
      const staleCase = await makeSuspendedAccountAppeal("A09stale目标");
      const { suspendAccount, reinstateAccount } = await import(
        "@/lib/enforcement/account-enforcement-service"
      );
      await reinstateAccount({
        actorId: enforcer.id,
        targetUserId: staleCase.target.id,
        reasonCode: "FALSE_POSITIVE_CORRECTION",
      });
      await suspendAccount({
        actorId: enforcer.id,
        targetUserId: staleCase.target.id,
        reasonCode: "ACCOUNT_SECURITY",
      });

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      const staleResult = await decideAppeal({
        reviewerId: globalReviewer.id,
        appealId: staleCase.appeal.id,
        decision: "GRANTED",
      });
      expect(staleResult.outcome).toBe("DISMISSED");
      expect(staleResult.reasonCode).toBe("STALE_ENFORCEMENT");
      const staleRow = await rawClient!.appeal.findUniqueOrThrow({
        where: { id: staleCase.appeal.id },
      });
      expect(staleRow.status).toBe("DISMISSED");

      // provenance 不足：legacy 行（previousState=null）
      const legacyTarget = await createFixtureUser("A09legacy目标", campusA.id);
      await rawClient!.user.update({
        where: { id: legacyTarget.id },
        data: { status: "SUSPENDED" },
      });
      const legacyEaId = await insertRawAction({
        type: "ACCOUNT_SUSPEND",
        actorId: enforcer.id,
        targetId: legacyTarget.id,
        campusId: null,
        scopeKey: "GLOBAL",
        previousState: null,
        resultState: "USER:SUSPENDED",
      });
      const legacyAppeal = await createAppealRow(legacyEaId);
      const legacyResult = await decideAppeal({
        reviewerId: globalReviewer.id,
        appealId: legacyAppeal.id,
        decision: "GRANTED",
      });
      expect(legacyResult.outcome).toBe("DISMISSED");
      expect(legacyResult.reasonCode).toBe("LEGACY_PROVENANCE_INSUFFICIENT");
    });

    it("A-10/A-11：decisionNote 长度边界（域权威）", async () => {
      const okCase = await makeSuspendedAccountAppeal("A10目标");
      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      const okResult = await decideAppeal({
        reviewerId: globalReviewer.id,
        appealId: okCase.appeal.id,
        decision: "UPHELD",
        decisionNote: "好".repeat(1000),
      });
      expect(okResult.outcome).toBe("UPHELD");
      const row = await rawClient!.appeal.findUniqueOrThrow({
        where: { id: okCase.appeal.id },
        select: { decisionNote: true },
      });
      expect(row.decisionNote).toHaveLength(1000);

      const tooLong = await makeSuspendedAccountAppeal("A11目标");
      await expect(
        decideAppeal({
          reviewerId: globalReviewer.id,
          appealId: tooLong.appeal.id,
          decision: "UPHELD",
          decisionNote: "好".repeat(1001),
        }),
      ).rejects.toMatchObject({ code: "APPEAL_NOT_ALLOWED" });
    });

    it("A-12：读取与提交之间撤权 → deny（详情 ok:false + 域拒绝）", async () => {
      const { appeal } = await makeSuspendedAccountAppeal("A12目标");
      // GLOBAL appeal → GLOBAL 审核员
      const reviewer = await createFixtureUser("A12审核员", campusA.id);
      const role = await grantRole(reviewer.id, "A12_REVIEWER", ["appeal.review"], "GLOBAL");

      const before = await loadDetail(reviewer.id, appeal.id);
      expect(before.ok).toBe(true);

      await rawClient!.userRoleAssignment.deleteMany({
        where: { userId: reviewer.id, roleId: role.id },
      });

      const after = await loadDetail(reviewer.id, appeal.id);
      expect(after.ok).toBe(false);

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      await expect(
        decideAppeal({ reviewerId: reviewer.id, appealId: appeal.id, decision: "UPHELD" }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/APPEAL_(SCOPE_MISMATCH|REVIEW_FORBIDDEN)/) });
    });

    it("A-13：reviewer 账号被停用 → deny", async () => {
      const { appeal } = await makeSuspendedAccountAppeal("A13目标");
      const reviewer = await createFixtureUser("A13审核员", campusA.id);
      await grantRole(reviewer.id, "A13_REVIEWER", ["appeal.review"], "GLOBAL");

      const before = await loadDetail(reviewer.id, appeal.id);
      expect(before.ok).toBe(true);

      await rawClient!.user.update({
        where: { id: reviewer.id },
        data: { status: "SUSPENDED" },
      });

      const after = await loadDetail(reviewer.id, appeal.id);
      expect(after.ok).toBe(false);

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      await expect(
        decideAppeal({ reviewerId: reviewer.id, appealId: appeal.id, decision: "UPHELD" }),
      ).rejects.toMatchObject({ code: "APPEAL_REVIEW_FORBIDDEN" });
    });

    it("A-14：campus reviewer 跨校区 mutation → deny（不泄露存在性差异）", async () => {
      const membershipTarget = await createFixtureUser("A14成员目标", campusA.id);
      const { suspendCampusMembership } = await import(
        "@/lib/enforcement/membership-enforcement-service"
      );
      await suspendCampusMembership({
        actorId: enforcer.id,
        targetUserId: membershipTarget.id,
        campusId: campusA.id,
        reasonCode: "POLICY_VIOLATION",
      });
      const ea = await rawClient!.enforcementAction.findFirstOrThrow({
        where: { targetId: membershipTarget.id, type: "MEMBERSHIP_SUSPEND" },
        orderBy: { enforcementSeq: "desc" },
      });
      const appeal = await createAppealRow(ea.id);

      const { beginAppealReview } = await import("@/lib/appeals/appeal-review-service");
      await expect(
        beginAppealReview({ reviewerId: campusReviewerB.id, appealId: appeal.id }),
      ).rejects.toMatchObject({ code: "APPEAL_SCOPE_MISMATCH" });
    });

    it("A-15：可 UPHELD 不可 GRANT → UI 提示 + 伪造 GRANTED 被域拒绝并整体回滚", async () => {
      const { target, appeal } = await makeSuspendedAccountAppeal("A15目标");
      const { beginAppealReview } = await import("@/lib/appeals/appeal-review-service");
      await beginAppealReview({ reviewerId: globalReviewOnly.id, appealId: appeal.id });

      const result = await loadDetail(globalReviewOnly.id, appeal.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.capabilities.canUphold).toBe(true);
      expect(result.capabilities.canGrant).toBe(false);

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      await expect(
        decideAppeal({
          reviewerId: globalReviewOnly.id,
          appealId: appeal.id,
          decision: "GRANTED",
        }),
      ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });

      // 整体回滚：Appeal 保持 IN_REVIEW（非 terminal）、target 保持 SUSPENDED
      const row = await rawClient!.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
      expect(row.status).toBe("IN_REVIEW");
      const user = await rawClient!.user.findUniqueOrThrow({
        where: { id: target.id },
        select: { status: true },
      });
      expect(user.status).toBe("SUSPENDED");
    });

    it("A-16：双 reviewer 并发终局 → 恰一 legal 胜者，败者 INVALID_TRANSITION", async () => {
      const { appeal } = await makeSuspendedAccountAppeal("A16目标");
      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      // 两位均有 GLOBAL 审核权的 reviewer（UPHELD 无需恢复权）
      const results = await Promise.allSettled([
        decideAppeal({ reviewerId: globalReviewer.id, appealId: appeal.id, decision: "GRANTED" }),
        decideAppeal({ reviewerId: globalReviewOnly.id, appealId: appeal.id, decision: "UPHELD" }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(errorCodeOf((rejected[0] as PromiseRejectedResult).reason)).toBe(
        "APPEAL_INVALID_TRANSITION",
      );
      const row = await rawClient!.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
      expect(["GRANTED", "UPHELD"]).toContain(row.status);
      expect(row.reviewedById).toBeTruthy();
    });

    it("A-17：begin vs withdraw 遵循既有行锁/状态机合同", async () => {
      const { target, appeal } = await makeSuspendedAccountAppeal("A17目标");
      const { beginAppealReview } = await import("@/lib/appeals/appeal-review-service");
      await beginAppealReview({ reviewerId: globalReviewer.id, appealId: appeal.id });

      const { withdrawAppeal } = await import("@/lib/appeals/appeal-service");
      await expect(
        withdrawAppeal({ callerUserId: target.id, appealId: appeal.id }),
      ).rejects.toMatchObject({ code: "APPEAL_INVALID_TRANSITION" });

      const row = await rawClient!.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
      expect(row.status).toBe("IN_REVIEW");
    });

    it("A-18：decisionNote 绝不进入 AdminAudit/通知（隔离 canary）", async () => {
      const canary = `SECRET_CANARY_${randomUUID()}`;
      const { target, appeal } = await makeSuspendedAccountAppeal("A18目标");
      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      await decideAppeal({
        reviewerId: globalReviewer.id,
        appealId: appeal.id,
        decision: "UPHELD",
        decisionNote: canary,
      });

      // Appeal 行是 decisionNote 唯一来源
      const row = await rawClient!.appeal.findUniqueOrThrow({
        where: { id: appeal.id },
        select: { decisionNote: true },
      });
      expect(row.decisionNote).toBe(canary);

      // AdminAudit（全部 audit 面）：detail 恒 null，metadata 不含 canary
      const audits = await rawClient!.adminLog.findMany({
        where: { targetType: "APPEAL", targetId: appeal.id },
      });
      expect(audits.length).toBeGreaterThan(0);
      for (const audit of audits) {
        expect(audit.detail).toBeNull();
        expect(JSON.stringify(audit.metadata ?? {})).not.toContain(canary);
      }

      //  appellant 通知：固定文案，不含 canary
      const notifications = await rawClient!.notification.findMany({
        where: { userId: target.id },
      });
      expect(notifications.length).toBeGreaterThan(0);
      for (const notification of notifications) {
        expect(notification.content).not.toContain(canary);
        expect(notification.title).not.toContain(canary);
      }
    });

    // ======================================================================
    // M-1..M-5：data-only migration + bootstrap 收敛（真实 PostgreSQL）
    // ======================================================================

    it("M-1/M-2：fresh migrate deploy = PASS；二次 deploy 无 pending；角色行/权限集精确", async () => {
      const tempDb = `campus_p7a_m1_${randomUUID().slice(0, 8)}`;
      const tempUrl = await createTempDatabase(tempDb);
      const tempClient = new PrismaClient({ datasources: { db: { url: tempUrl } }, log: ["error"] });
      try {
        const deployOutput = runPrismaCli(["migrate", "deploy"], tempUrl);
        expect(deployOutput).not.toContain("error");

        const role = await tempClient.role.findUnique({
          where: { key: SYSTEM_REVIEWER_ROLE_KEY },
          include: { rolePermissions: { include: { permission: true } } },
        });
        expect(role).toBeTruthy();
        expect(role!.name).toBe("校区申诉审核员");
        expect(role!.scope).toBe("CAMPUS");
        expect(role!.isSystem).toBe(true);
        expect(role!.rolePermissions.map((rp) => rp.permission.key)).toEqual(["appeal.review"]);

        // M-2：二次 deploy 无 pending
        const secondOutput = runPrismaCli(["migrate", "deploy"], tempUrl);
        expect(secondOutput).toContain("No pending migrations");
        const migrationRows = await tempClient.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*)::int AS count FROM "_prisma_migrations"
          WHERE "migration_name" = ${NEW_MIGRATION}`;
        expect(migrationRows[0]!.count).toBe(1);

        // fresh deploy 后零 UserRoleAssignment 触碰（本 migration 不授任何用户）
        const assignmentCount = await tempClient.userRoleAssignment.count({
          where: { role: { key: SYSTEM_REVIEWER_ROLE_KEY } },
        });
        expect(assignmentCount).toBe(0);
      } finally {
        await tempClient.$disconnect();
        await dropTempDatabase(tempDb);
      }
    }, 240_000);

    it("M-3/M-4：既有角色行（自然键/非确定性 id）幂等收敛；UserRoleAssignment 零触碰", async () => {
      const tempDb = `campus_p7a_m3_${randomUUID().slice(0, 8)}`;
      const tempUrl = await createTempDatabase(tempDb);
      const tempClient = new PrismaClient({ datasources: { db: { url: tempUrl } }, log: ["error"] });
      try {
        runPrismaCli(["migrate", "deploy"], tempUrl);

        // 构造"污染"的既有角色：非确定性 id + 错误 name + 多余 permission + 一个授权行
        const campus = await tempClient.campus.create({
          data: { name: "M3校区", slug: `m3-${RUN_TAG}`, schoolName: "集成测试大学" },
        });
        const user = await tempClient.user.create({
          data: {
            email: `m3-${RUN_TAG}@it.local`,
            name: "M3用户",
            passwordHash: "x",
            schoolName: "集成测试大学",
            campusId: campus.id,
          },
        });
        const customId = `role_custom_${randomUUID().slice(0, 8)}`;
        await tempClient.$executeRaw`DELETE FROM "RolePermission" WHERE "roleId" = (SELECT "id" FROM "Role" WHERE "key" = ${SYSTEM_REVIEWER_ROLE_KEY})`;
        await tempClient.$executeRaw`DELETE FROM "Role" WHERE "key" = ${SYSTEM_REVIEWER_ROLE_KEY}`;
        await tempClient.$executeRaw`
          INSERT INTO "Role" ("id", "key", "name", "scope", "isSystem", "createdAt", "updatedAt")
          VALUES (${customId}, ${SYSTEM_REVIEWER_ROLE_KEY}, '错误名称', 'CAMPUS', true, now(), now())`;
        const extraPermissionId = (
          await tempClient.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "Permission" WHERE "key" = 'report.review'`
        )[0]!.id;
        await tempClient.$executeRaw`
          INSERT INTO "RolePermission" ("roleId", "permissionId")
          VALUES (${customId}, ${extraPermissionId})`;
        await tempClient.userRoleAssignment.create({
          data: {
            userId: user.id,
            roleId: customId,
            campusId: campus.id,
            scopeKey: `CAMPUS:${campus.id}`,
            assignedById: null,
          },
        });
        const assignmentCountBefore = await tempClient.userRoleAssignment.count();

        // 幂等重跑本 migration（自然键解析真实 id）
        const migrationSql = readFileSync(
          path.resolve("prisma", "migrations", NEW_MIGRATION, "migration.sql"),
          "utf8",
        );
        expect(migrationSql).toContain("BEGIN;");
        expect(migrationSql).toContain("COMMIT;");
        runPrismaDbExecute(migrationSql, tempUrl);

        const role = await tempClient.role.findUnique({
          where: { key: SYSTEM_REVIEWER_ROLE_KEY },
          include: { rolePermissions: { include: { permission: true } } },
        });
        expect(role!.id).toBe(customId); // 保留既有 id（自然键解析，不假设确定性 id）
        expect(role!.name).toBe("校区申诉审核员");
        expect(role!.scope).toBe("CAMPUS");
        expect(role!.isSystem).toBe(true);
        expect(role!.rolePermissions.map((rp) => rp.permission.key)).toEqual(["appeal.review"]);

        // UserRoleAssignment 计数与内容零变化
        expect(await tempClient.userRoleAssignment.count()).toBe(assignmentCountBefore);
        const untouched = await tempClient.userRoleAssignment.findFirstOrThrow({
          where: { roleId: customId },
        });
        expect(untouched.userId).toBe(user.id);
      } finally {
        await tempClient.$disconnect();
        await dropTempDatabase(tempDb);
      }
    }, 240_000);

    it("M-5：ensureRbacFoundation 幂等收敛系统角色（新鲜库创建 / 多余 permission 移除 / PLATFORM_ADMIN 不变）", async () => {
      const tempDb = `campus_p7a_m5_${randomUUID().slice(0, 8)}`;
      const tempUrl = await createTempDatabase(tempDb);
      const tempClient = new PrismaClient({ datasources: { db: { url: tempUrl } }, log: ["error"] });
      try {
        runPrismaCli(["migrate", "deploy"], tempUrl);
        const { ensureRbacFoundation } = await import("@/lib/rbac/bootstrap");

        await ensureRbacFoundation(tempClient);

        const role = await tempClient.role.findUnique({
          where: { key: SYSTEM_REVIEWER_ROLE_KEY },
          include: { rolePermissions: { include: { permission: true } } },
        });
        expect(role).toBeTruthy();
        expect(role!.scope).toBe("CAMPUS");
        expect(role!.rolePermissions.map((rp) => rp.permission.key)).toEqual(["appeal.review"]);

        // 污染：追加多余 permission → bootstrap 再收敛 → 精确回到 ["appeal.review"]
        const extra = await tempClient.permission.findUnique({ where: { key: "report.review" } });
        await tempClient.rolePermission.create({
          data: { roleId: role!.id, permissionId: extra!.id },
        });
        await ensureRbacFoundation(tempClient);
        const reconverged = await tempClient.role.findUnique({
          where: { key: SYSTEM_REVIEWER_ROLE_KEY },
          include: { rolePermissions: { include: { permission: true } } },
        });
        expect(reconverged!.rolePermissions.map((rp) => rp.permission.key)).toEqual([
          "appeal.review",
        ]);

        // PLATFORM_ADMIN 语义不变（全量 permission 的 GLOBAL 角色）
        const admin = await tempClient.role.findUnique({
          where: { key: "PLATFORM_ADMIN" },
          include: { rolePermissions: { select: { permission: { select: { key: true } } } } },
        });
        expect(admin!.scope).toBe("GLOBAL");
        expect(admin!.rolePermissions.length).toBe(PERMISSION_KEYS.length);
      } finally {
        await tempClient.$disconnect();
        await dropTempDatabase(tempDb);
      }
    }, 240_000);
  },
);
