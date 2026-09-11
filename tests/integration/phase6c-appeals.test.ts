import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Phase 6C-1B Appeal Domain 集成测试（真实 PostgreSQL）。
 *
 * 覆盖 T01–T38（Planning Repair 1–4 冻结的测试全集）：
 *  - 提交：并发唯一性（T01）、ownership/punitive（T02/T03）、vs erasure 串行化（T20/T21）
 *  - 审核：double-review（T04）、latestSameFamily stale/reversed（T05/T06/T07）、
 *    WATCH/NORMAL 精确恢复（T08/T09）、legacy/rollback-compat fail-closed（T10/T11/T24）、
 *    selfReview（T12）、reviewer==appellant 零例外（T13）、scope 矩阵（T14/T15/T16）、
 *    GRANT ‖ 新处罚 subject 串行化（T17）、锁序双方向 NO_40P01（T18/T19）
 *  - begin-review：IN_REVIEW workflow-only / reviewedById=实际决策者（T22）、
 *    vs 角色撤销（T30）、vs 账号停用（T31）
 *  - 撤回：vs erasure（T35）、vs begin-review（T36）
 *  - 语义：程序性 DISMISSED = 提交成功（T23/T24）、decisionNote 隔离 canary（T37）
 *  - GRANT restorative provenance（T32/T33/T34）
 *  - 导出 v2 / ownership / 内部字段（T25–T29）
 *  - FK referential actions：catalog + 破坏性 DELETE + drift（T38）
 *  - migration 验证 D-1..D-6
 *
 * 并发全部确定性：advisory lock / row lock / racePoint / promise barrier；
 * 零 sleep、零随机重试。锁序统一：Appeal 行锁 → governance USER 锁。
 */

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const prisma = integrationDatabaseUrl ? (await import("@/lib/prisma")).prisma : null;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p6c1b-${randomUUID().slice(0, 8)}`;
const NEW_MIGRATION = "20260911120000_phase6c_appeal_domain";
const createdUserIds: string[] = [];
const createdCampusIds: string[] = [];
const createdRoleIds: string[] = [];

const BOUNDARY = BigInt(1_000_000_000);
// 与 phase6c-enforcement-provenance.test.ts 的合成 seq 值段严格不相交
//（vitest 并行文件共用同一 DB；enforcementSeq @unique 全表唯一）
const SYNTHETIC_LEGACY_SEQ = BOUNDARY - BigInt(1002);
const SYNTHETIC_T24_LEGACY_SEQ = BOUNDARY - BigInt(1004);
const SYNTHETIC_EARLIER_AUTH_SEQ = BOUNDARY + BigInt(5_000_008);
const SYNTHETIC_ROLLBACK_COMPAT_SEQ = BOUNDARY + BigInt(5_000_010);
const SYNTHETIC_T40_MALFORMED_ACCOUNT_SEQ = BOUNDARY + BigInt(5_000_012);
const SYNTHETIC_T40_MALFORMED_RISK_SEQ = BOUNDARY + BigInt(5_000_014);
const ALL_SYNTHETIC_SEQS = [
  SYNTHETIC_LEGACY_SEQ,
  SYNTHETIC_T24_LEGACY_SEQ,
  SYNTHETIC_EARLIER_AUTH_SEQ,
  SYNTHETIC_ROLLBACK_COMPAT_SEQ,
  SYNTHETIC_T40_MALFORMED_ACCOUNT_SEQ,
  SYNTHETIC_T40_MALFORMED_RISK_SEQ,
];

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

/** 直插 legacy / rollback-compat 形状的 EA 行（合成 seq；参数化，远离真实 sequence 值段） */
async function insertRawAction(data: {
  id: string;
  type: string;
  actorId: string;
  targetId: string;
  campusId?: string | null;
  scopeKey: string;
  previousState: string | null;
  resultState: string;
  enforcementSeq: bigint;
}) {
  await rawClient!.$executeRaw`
    INSERT INTO "EnforcementAction"
      ("id", "type", "actorId", "targetId", "campusId", "scopeKey", "reasonCode",
       "note", "sourceType", "sourceId", "previousState", "resultState", "enforcementSeq")
    VALUES (${data.id}, ${data.type}::"EnforcementActionType", ${data.actorId}, ${data.targetId},
            ${data.campusId ?? null}, ${data.scopeKey}, 'MANUAL_REVIEW',
            NULL, NULL, NULL, ${data.previousState}, ${data.resultState}, ${data.enforcementSeq})`;
}

/**
 * 无 shell 的 Prisma CLI 调用（spawnSync 参数数组，结构上排除命令注入；
 * Windows 直调 node_modules 内 CLI 入口，避免 npx cmd shim）。
 */
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

/** 目标最新的同族 action（被申诉对象的定位捷径） */
async function latestActionFor(targetId: string, type: string) {
  return rawClient!.enforcementAction.findFirst({
    where: { targetId, type: type as never },
    orderBy: { enforcementSeq: "desc" },
  });
}

/** owner 提交（caller = EA.target；owner source of truth = EA.targetId） */
async function submitFor(actionId: string, callerUserId: string) {
  const { submitAppeal } = await import("@/lib/appeals/appeal-service");
  return submitAppeal({
    callerUserId,
    enforcementActionId: actionId,
    statement: "集成测试申诉：请复核该处罚",
  });
}

function errorCodeOf(error: unknown): string {
  return (error as { code?: string })?.code ?? "";
}

/** 展开后台 promise（fulfilled/rejected 包装，避免 unhandled rejection） */
function settled<T>(promise: Promise<T>): Promise<{
  fulfilled: boolean;
  value: T | undefined;
  error: unknown;
}> {
  return promise.then(
    (value) => ({ fulfilled: true, value, error: undefined as unknown }),
    (error) => ({ fulfilled: false, value: undefined as T | undefined, error }),
  );
}

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 6C-1B appeal domain 集成测试（真实 PostgreSQL）",
  () => {
    let campusA: { id: string };
    let campusB: { id: string };
    let enforcerA: { id: string };
    let enforcerB: { id: string };
    let reviewerFull: { id: string };
    let reviewerSecond: { id: string };
    let roleAdmin: { id: string };

    beforeAll(async () => {
      await rawClient!.enforcementAction.deleteMany({
        where: { enforcementSeq: { in: ALL_SYNTHETIC_SEQS } },
      });

      campusA = await createFixtureCampus("campus-a");
      campusB = await createFixtureCampus("campus-b");
      enforcerA = await createFixtureUser("执法员A", campusA.id);
      enforcerB = await createFixtureUser("执法员B", campusB.id);
      reviewerFull = await createFixtureUser("全能审核员", campusA.id);
      reviewerSecond = await createFixtureUser("第二审核员", campusA.id);
      roleAdmin = await createFixtureUser("角色管理员", campusA.id);
      // enforcerA 兼具 campus.manage（campus-scoped risk/membership 执法用）
      await grantRole(enforcerA.id, "ENFORCER_A", ["user.suspend", "campus.manage"], "GLOBAL");
      await grantRole(enforcerB.id, "ENFORCER_B", ["user.suspend"], "GLOBAL");
      // GRANT 必须同时通过 canonical seam 的权限复核（appeal.review + seam 权限）
      await grantRole(
        reviewerFull.id,
        "REVIEWER_FULL",
        ["appeal.review", "user.suspend", "campus.manage"],
        "GLOBAL",
      );
      await grantRole(
        reviewerSecond.id,
        "REVIEWER_SECOND",
        ["appeal.review", "user.suspend", "campus.manage"],
        "GLOBAL",
      );
      await grantRole(roleAdmin.id, "ROLE_ADMIN", ["rbac.role.assign"], "GLOBAL");

      const { ensureRbacFoundation, syncLegacyAdminRoles, ensureCampusMemberships } =
        await import("@/lib/rbac/bootstrap");
      await ensureRbacFoundation(prisma!);
      await syncLegacyAdminRoles(prisma!);
      await ensureCampusMemberships(prisma!);
    });

    afterAll(async () => {
      await rawClient!.appeal.deleteMany({
        where: { enforcementAction: { targetId: { in: createdUserIds } } },
      });
      await rawClient!.enforcementAction.deleteMany({ where: { targetId: { in: createdUserIds } } });
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
      await prisma?.$disconnect();
    });

    // ------------------------------------------------------------------
    // T01 并发提交：恰好一条 Appeal，loser 收敛 APPEAL_ALREADY_EXISTS
    // ------------------------------------------------------------------
    it("T01 两个并发提交同一 EA：恰好一条 Appeal", async () => {
      const target = await createFixtureUser("T01目标", campusA.id);
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      await suspendAccount({ actorId: enforcerA.id, targetUserId: target.id, reasonCode: "ACCOUNT_SECURITY" });
      const ea = await latestActionFor(target.id, "ACCOUNT_SUSPEND");
      expect(ea).toBeTruthy();

      const results = await Promise.allSettled([
        submitFor(ea!.id, target.id),
        submitFor(ea!.id, target.id),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(errorCodeOf((rejected[0] as PromiseRejectedResult).reason)).toBe("APPEAL_ALREADY_EXISTS");

      const appeals = await rawClient!.appeal.findMany({
        where: { enforcementActionId: ea!.id },
      });
      expect(appeals).toHaveLength(1);
      expect(appeals[0]!.status).toBe("SUBMITTED");
    });

    // ------------------------------------------------------------------
    // T02 申诉他人 EA → APPEAL_NOT_OWNED（404 防枚举）
    // ------------------------------------------------------------------
    it("T02 申诉他人的 EnforcementAction → DENY", async () => {
      const target = await createFixtureUser("T02目标", campusA.id);
      const outsider = await createFixtureUser("T02旁人", campusA.id);
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      await suspendAccount({ actorId: enforcerA.id, targetUserId: target.id, reasonCode: "POLICY_VIOLATION" });
      const ea = await latestActionFor(target.id, "ACCOUNT_SUSPEND");

      await expect(submitFor(ea!.id, outsider.id)).rejects.toMatchObject({
        code: "APPEAL_NOT_OWNED",
        status: 404,
      });
      expect(await rawClient!.appeal.count({ where: { enforcementActionId: ea!.id } })).toBe(0);
    });

    // ------------------------------------------------------------------
    // T03 申诉 restorative 动作 → APPEAL_NOT_ALLOWED
    // ------------------------------------------------------------------
    it("T03 restorative action 不可申诉", async () => {
      const target = await createFixtureUser("T03目标", campusA.id);
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      await suspendAccount({ actorId: enforcerA.id, targetUserId: target.id, reasonCode: "POLICY_VIOLATION" });
      await submitFor((await latestActionFor(target.id, "ACCOUNT_SUSPEND"))!.id, target.id);

      // enforcer 恢复 → 产生 ACCOUNT_REINSTATE（restorative）
      const { reinstateAccount } = await import("@/lib/enforcement/account-enforcement-service");
      await reinstateAccount({
        actorId: enforcerA.id,
        targetUserId: target.id,
        reasonCode: "FALSE_POSITIVE_CORRECTION",
      });
      const restoreEA = await latestActionFor(target.id, "ACCOUNT_REINSTATE");
      expect(restoreEA).toBeTruthy();

      // 槽位已被占用 + restorative 不可申诉：双 fail-closed
      await expect(submitFor(restoreEA!.id, target.id)).rejects.toMatchObject({
        code: "APPEAL_NOT_ALLOWED",
      });
    });

    // ------------------------------------------------------------------
    // T04 double-review race：恰好一个 terminal 决策，loser APPEAL_INVALID_TRANSITION
    // ------------------------------------------------------------------
    it("T04 double-review race：GRANTED ‖ UPHELD 恰一胜者", async () => {
      const target = await createFixtureUser("T04目标", campusA.id);
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      await suspendAccount({ actorId: enforcerA.id, targetUserId: target.id, reasonCode: "POLICY_VIOLATION" });
      const ea = (await latestActionFor(target.id, "ACCOUNT_SUSPEND"))!;
      const { appeal } = await submitFor(ea.id, target.id);

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      const results = await Promise.allSettled([
        decideAppeal({ reviewerId: reviewerFull.id, appealId: appeal.id, decision: "GRANTED" }),
        decideAppeal({ reviewerId: reviewerSecond.id, appealId: appeal.id, decision: "UPHELD" }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{
        outcome: string;
      }>[];
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(errorCodeOf(rejected[0]!.reason)).toBe("APPEAL_INVALID_TRANSITION");

      const terminal = await rawClient!.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
      expect(["GRANTED", "UPHELD"]).toContain(terminal.status);
      // reviewedById = 实际 terminal 决策者
      expect(terminal.reviewedById).toBeTruthy();
      const winnerEA = await rawClient!.enforcementAction.count({
        where: { targetId: target.id, type: "ACCOUNT_REINSTATE" },
      });
      expect(winnerEA).toBe(terminal.status === "GRANTED" ? 1 : 0);
    });

    // ------------------------------------------------------------------
    // T05 newer punitive 同族 → DISMISSED(STALE_ENFORCEMENT)
    // T23 程序性结局 = 提交成功（不 throw）+ AdminAudit 落行
    // ------------------------------------------------------------------
    it("T05+T23 newer punitive → 提交式 DISMISSED(STALE_ENFORCEMENT) + 审计", async () => {
      const target = await createFixtureUser("T05目标", campusA.id);
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      await suspendAccount({ actorId: enforcerA.id, targetUserId: target.id, reasonCode: "POLICY_VIOLATION" });
      const appealedEA = (await latestActionFor(target.id, "ACCOUNT_SUSPEND"))!;
      const { appeal } = await submitFor(appealedEA.id, target.id);

      // 新的同族 punitive（更高 seq）在审核前 linearize。
      // suspendAccount 幂等：已 SUSPENDED 再 suspend = no-op（不产生 EA），
      // 因此先 reinstate（restorative）再 suspend 产生更高 seq 的 punitive
      const { reinstateAccount } = await import("@/lib/enforcement/account-enforcement-service");
      await reinstateAccount({
        actorId: enforcerA.id,
        targetUserId: target.id,
        reasonCode: "FALSE_POSITIVE_CORRECTION",
      });
      await suspendAccount({ actorId: enforcerA.id, targetUserId: target.id, reasonCode: "ACCOUNT_SECURITY" });

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      const result = await decideAppeal({
        reviewerId: reviewerFull.id,
        appealId: appeal.id,
        decision: "GRANTED",
      });

      // 提交式结局：不 throw、DISMISSED + 机器 reasonCode
      expect(result.outcome).toBe("DISMISSED");
      expect(result.reasonCode).toBe("STALE_ENFORCEMENT");
      const row = await rawClient!.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
      expect(row.status).toBe("DISMISSED");
      expect(row.decisionReasonCode).toBe("STALE_ENFORCEMENT");
      expect(row.reviewedById).toBe(reviewerFull.id);
      // AdminAudit 已随事务 COMMIT
      const audit = await rawClient!.adminLog.findFirst({
        where: { targetType: "APPEAL", targetId: appeal.id, action: "APPEAL_DISMISSED" },
      });
      expect(audit).toBeTruthy();
      expect((audit!.metadata as Record<string, unknown>).decisionReasonCode).toBe("STALE_ENFORCEMENT");
      // 零 restoration（target 保持 SUSPENDED）
      expect((await rawClient!.user.findUniqueOrThrow({ where: { id: target.id } })).status).toBe("SUSPENDED");
    });

    // ------------------------------------------------------------------
    // T06 newer restorative 同族 → DISMISSED(ENFORCEMENT_ALREADY_REVERSED)
    // ------------------------------------------------------------------
    it("T06 newer restorative → DISMISSED(ENFORCEMENT_ALREADY_REVERSED)", async () => {
      const target = await createFixtureUser("T06目标", campusA.id);
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      await suspendAccount({ actorId: enforcerA.id, targetUserId: target.id, reasonCode: "POLICY_VIOLATION" });
      const appealedEA = (await latestActionFor(target.id, "ACCOUNT_SUSPEND"))!;
      const { appeal } = await submitFor(appealedEA.id, target.id);

      const { reinstateAccount } = await import("@/lib/enforcement/account-enforcement-service");
      await reinstateAccount({
        actorId: enforcerA.id,
        targetUserId: target.id,
        reasonCode: "FALSE_POSITIVE_CORRECTION",
      });

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      const result = await decideAppeal({
        reviewerId: reviewerFull.id,
        appealId: appeal.id,
        decision: "GRANTED",
      });
      expect(result).toMatchObject({ outcome: "DISMISSED", reasonCode: "ENFORCEMENT_ALREADY_REVERSED" });
    });

    // ------------------------------------------------------------------
    // T07 campus-B 的新 membership 动作不使 campus-A appeal 失效（跨 scope 不 supersede）
    // ------------------------------------------------------------------
    it("T07 跨 campus 新动作不 stale campus-A appeal（GRANTED 恢复同 campus）", async () => {
      const targetA = await createFixtureUser("T07目标A", campusA.id);
      const targetB = await createFixtureUser("T07目标B", campusB.id);
      const { suspendCampusMembership } = await import(
        "@/lib/enforcement/membership-enforcement-service"
      );
      await suspendCampusMembership({
        actorId: enforcerA.id,
        targetUserId: targetA.id,
        campusId: campusA.id,
        reasonCode: "POLICY_VIOLATION",
      });
      const appealedEA = (await latestActionFor(targetA.id, "MEMBERSHIP_SUSPEND"))!;
      const { appeal } = await submitFor(appealedEA.id, targetA.id);

      // campus-B 同族动作 seq 更高，但跨 scope 不互相 supersede
      await suspendCampusMembership({
        actorId: enforcerA.id,
        targetUserId: targetB.id,
        campusId: campusB.id,
        reasonCode: "POLICY_VIOLATION",
      });

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      const result = await decideAppeal({
        reviewerId: reviewerFull.id,
        appealId: appeal.id,
        decision: "GRANTED",
      });
      expect(result.outcome).toBe("GRANTED");

      const membership = await rawClient!.campusMembership.findUniqueOrThrow({
        where: { userId_campusId: { userId: targetA.id, campusId: campusA.id } },
      });
      expect(membership.status).toBe("ACTIVE");
      // campus-B 的停用不受影响
      const membershipB = await rawClient!.campusMembership.findUniqueOrThrow({
        where: { userId_campusId: { userId: targetB.id, campusId: campusB.id } },
      });
      expect(membershipB.status).toBe("SUSPENDED");
    });

    // ------------------------------------------------------------------
    // T08 / T09 WATCH 与 NORMAL 精确恢复（绝不硬编码 NORMAL）
    // ------------------------------------------------------------------
    it("T08 WATCH → RESTRICTED 申诉 GRANTED → 恢复为 WATCH", async () => {
      const target = await createFixtureUser("T08目标", campusA.id);
      const { setRiskState } = await import("@/lib/enforcement/risk-service");
      await setRiskState({
        actorId: enforcerA.id,
        targetUserId: target.id,
        campusId: null,
        state: "WATCH",
        reasonCode: "MANUAL_REVIEW",
      });
      await setRiskState({
        actorId: enforcerA.id,
        targetUserId: target.id,
        campusId: null,
        state: "RESTRICTED",
        reasonCode: "FRAUD_CONFIRMED",
      });
      const appealedEA = (await latestActionFor(target.id, "MARKETPLACE_RESTRICT"))!;
      const { appeal } = await submitFor(appealedEA.id, target.id);

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      const result = await decideAppeal({
        reviewerId: reviewerFull.id,
        appealId: appeal.id,
        decision: "GRANTED",
      });
      expect(result.outcome).toBe("GRANTED");

      const risk = await rawClient!.riskState.findUniqueOrThrow({
        where: { userId_scopeKey: { userId: target.id, scopeKey: "GLOBAL" } },
      });
      expect(risk.state).toBe("WATCH");
    });

    it("T09 NORMAL → RESTRICTED 申诉 GRANTED → 恢复为 NORMAL", async () => {
      const target = await createFixtureUser("T09目标", campusA.id);
      const { setRiskState } = await import("@/lib/enforcement/risk-service");
      await setRiskState({
        actorId: enforcerA.id,
        targetUserId: target.id,
        campusId: null,
        state: "RESTRICTED",
        reasonCode: "FRAUD_CONFIRMED",
      });
      const appealedEA = (await latestActionFor(target.id, "MARKETPLACE_RESTRICT"))!;
      const { appeal } = await submitFor(appealedEA.id, target.id);

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      const result = await decideAppeal({
        reviewerId: reviewerFull.id,
        appealId: appeal.id,
        decision: "GRANTED",
      });
      expect(result.outcome).toBe("GRANTED");

      const risk = await rawClient!.riskState.findUniqueOrThrow({
        where: { userId_scopeKey: { userId: target.id, scopeKey: "GLOBAL" } },
      });
      expect(risk.state).toBe("NORMAL");
    });

    // ------------------------------------------------------------------
    // T10 pre-migration legacy punitive → DISMISSED(LEGACY_PROVENANCE_INSUFFICIENT)
    // T11 rollback-compat（seq≥boundary / previousState=null）→ 同样 fail-closed
    //     且仍可 supersede 更早动作
    // ------------------------------------------------------------------
    it("T10/T11 legacy 与 rollback-compat：零自动恢复，compat 仍参与 latest 排序", async () => {
      const actor = await createFixtureUser("T10执法员", campusA.id);
      const legacyTarget = await createFixtureUser("T10legacy目标", campusA.id);
      const compatTarget = await createFixtureUser("T11compat目标", campusA.id);
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      // legacy 行（seq < boundary，previousState 保持 NULL）
      await insertRawAction({
        id: `${RUN_TAG}-t10-legacy`,
        type: "ACCOUNT_SUSPEND",
        actorId: actor.id,
        targetId: legacyTarget.id,
        scopeKey: "GLOBAL",
        previousState: null,
        resultState: "USER:SUSPENDED",
        enforcementSeq: SYNTHETIC_LEGACY_SEQ,
      });
      const legacyAppeal = await submitFor(`${RUN_TAG}-t10-legacy`, legacyTarget.id);
      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      const legacyResult = await decideAppeal({
        reviewerId: reviewerFull.id,
        appealId: legacyAppeal.appeal.id,
        decision: "GRANTED",
      });
      expect(legacyResult).toMatchObject({
        outcome: "DISMISSED",
        reasonCode: "LEGACY_PROVENANCE_INSUFFICIENT",
      });
      // 零恢复：无任何新 EA
      expect(
        await rawClient!.enforcementAction.count({ where: { targetId: legacyTarget.id } }),
      ).toBe(1);

      // rollback-compat：seq >= boundary、previousState = NULL，仍可 supersede 更早动作
      await suspendAccount({ actorId: enforcerA.id, targetUserId: compatTarget.id, reasonCode: "POLICY_VIOLATION" });
      await insertRawAction({
        id: `${RUN_TAG}-t11-earlier`,
        type: "ACCOUNT_SUSPEND",
        actorId: actor.id,
        targetId: compatTarget.id,
        scopeKey: "GLOBAL",
        previousState: "USER:ACTIVE",
        resultState: "USER:SUSPENDED",
        enforcementSeq: SYNTHETIC_EARLIER_AUTH_SEQ,
      });
      await insertRawAction({
        id: `${RUN_TAG}-t11-compat`,
        type: "ACCOUNT_SUSPEND",
        actorId: actor.id,
        targetId: compatTarget.id,
        scopeKey: "GLOBAL",
        previousState: null,
        resultState: "USER:SUSPENDED",
        enforcementSeq: SYNTHETIC_ROLLBACK_COMPAT_SEQ,
      });

      const { latestSameFamilyAction } = await import("@/lib/enforcement/enforcement-sequence");
      const { withTransaction } = await import("@/lib/prisma");
      const latest = await withTransaction((tx) =>
        latestSameFamilyAction(tx, { targetId: compatTarget.id, scopeKey: "GLOBAL", type: "ACCOUNT_SUSPEND" }),
      );
      expect(latest?.id).toBe(`${RUN_TAG}-t11-compat`);

      const compatAppeal = await submitFor(`${RUN_TAG}-t11-compat`, compatTarget.id);
      const compatResult = await decideAppeal({
        reviewerId: reviewerFull.id,
        appealId: compatAppeal.appeal.id,
        decision: "GRANTED",
      });
      expect(compatResult).toMatchObject({
        outcome: "DISMISSED",
        reasonCode: "LEGACY_PROVENANCE_INSUFFICIENT",
      });
    });

    // ------------------------------------------------------------------
    // T12 reviewer == 原执法 actor → ALLOWED + AdminAudit selfReview=true
    // ------------------------------------------------------------------
    it("T12 self-review 允许且强制审计 selfReview=true", async () => {
      const target = await createFixtureUser("T12目标", campusA.id);
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      // 执法者 = 审核者（reviewerFull 自己执法自己审）
      await suspendAccount({ actorId: reviewerFull.id, targetUserId: target.id, reasonCode: "POLICY_VIOLATION" });
      const ea = (await latestActionFor(target.id, "ACCOUNT_SUSPEND"))!;
      const { appeal } = await submitFor(ea.id, target.id);

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      const result = await decideAppeal({
        reviewerId: reviewerFull.id,
        appealId: appeal.id,
        decision: "UPHELD",
      });
      expect(result.outcome).toBe("UPHELD");

      const audit = await rawClient!.adminLog.findFirstOrThrow({
        where: { targetType: "APPEAL", targetId: appeal.id, action: "APPEAL_UPHELD" },
      });
      expect((audit.metadata as Record<string, unknown>).selfReview).toBe(true);
      expect(audit.detail).toBeNull();
    });

    // ------------------------------------------------------------------
    // T13 reviewer == appellant → APPEAL_REVIEWER_IS_APPELLANT（零例外）
    // ------------------------------------------------------------------
    it("T13 appellant 不得审核自己的申诉", async () => {
      // campus 经理被 campus-scoped restrict（账号保持 ACTIVE，可持 appeal.review）
      const managerX = await createFixtureUser("T13经理", campusA.id);
      await grantRole(managerX.id, "T13_REVIEWER", ["appeal.review"], "CAMPUS", campusA.id);
      const { setRiskState } = await import("@/lib/enforcement/risk-service");
      await setRiskState({
        actorId: enforcerA.id,
        targetUserId: managerX.id,
        campusId: campusA.id,
        state: "RESTRICTED",
        reasonCode: "POLICY_VIOLATION",
      });
      const ea = (await latestActionFor(managerX.id, "MARKETPLACE_RESTRICT"))!;
      const { appeal } = await submitFor(ea.id, managerX.id);

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      await expect(
        decideAppeal({ reviewerId: managerX.id, appealId: appeal.id, decision: "UPHELD" }),
      ).rejects.toMatchObject({ code: "APPEAL_REVIEWER_IS_APPELLANT" });
      // 保持非 terminal
      expect((await rawClient!.appeal.findUniqueOrThrow({ where: { id: appeal.id } })).status).toBe(
        "SUBMITTED",
      );
    });

    // ------------------------------------------------------------------
    // T14 campus-A reviewer → campus-B appeal DENY（APPEAL_SCOPE_MISMATCH）
    // T15 campus-only reviewer → ACCOUNT_SUSPEND（GLOBAL）appeal DENY
    // ------------------------------------------------------------------
    it("T14/T15 campus reviewer scope 隔离", async () => {
      const campusReviewerA = await createFixtureUser("T14校区审核员A", campusA.id);
      await grantRole(campusReviewerA.id, "T14_REVIEWER_A", ["appeal.review"], "CAMPUS", campusA.id);

      // campus-B membership appeal
      const targetB = await createFixtureUser("T14目标B", campusB.id);
      const { suspendCampusMembership } = await import(
        "@/lib/enforcement/membership-enforcement-service"
      );
      await suspendCampusMembership({
        actorId: enforcerA.id,
        targetUserId: targetB.id,
        campusId: campusB.id,
        reasonCode: "POLICY_VIOLATION",
      });
      const campusEA = (await latestActionFor(targetB.id, "MEMBERSHIP_SUSPEND"))!;
      const campusAppeal = await submitFor(campusEA.id, targetB.id);

      // T15：campus-only reviewer 审 GLOBAL ACCOUNT_SUSPEND appeal
      const targetGlobal = await createFixtureUser("T15目标", campusA.id);
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      await suspendAccount({
        actorId: enforcerA.id,
        targetUserId: targetGlobal.id,
        reasonCode: "POLICY_VIOLATION",
      });
      const globalEA = (await latestActionFor(targetGlobal.id, "ACCOUNT_SUSPEND"))!;
      const globalAppeal = await submitFor(globalEA.id, targetGlobal.id);

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      await expect(
        decideAppeal({
          reviewerId: campusReviewerA.id,
          appealId: campusAppeal.appeal.id,
          decision: "UPHELD",
        }),
      ).rejects.toMatchObject({ code: "APPEAL_SCOPE_MISMATCH" });
      await expect(
        decideAppeal({
          reviewerId: campusReviewerA.id,
          appealId: globalAppeal.appeal.id,
          decision: "UPHELD",
        }),
      ).rejects.toMatchObject({ code: "APPEAL_SCOPE_MISMATCH" });
      expect(
        (await rawClient!.appeal.findUniqueOrThrow({ where: { id: campusAppeal.appeal.id } })).status,
      ).toBe("SUBMITTED");
      expect(
        (await rawClient!.appeal.findUniqueOrThrow({ where: { id: globalAppeal.appeal.id } })).status,
      ).toBe("SUBMITTED");
    });

    // ------------------------------------------------------------------
    // T16 GLOBAL reviewer → global + campus appeal 全 ALLOWED
    // ------------------------------------------------------------------
    it("T16 GLOBAL reviewer 可审 campus appeal（begin → GRANT 全链路）", async () => {
      const target = await createFixtureUser("T16目标", campusA.id);
      const { suspendCampusMembership } = await import(
        "@/lib/enforcement/membership-enforcement-service"
      );
      await suspendCampusMembership({
        actorId: enforcerA.id,
        targetUserId: target.id,
        campusId: campusA.id,
        reasonCode: "POLICY_VIOLATION",
      });
      const ea = (await latestActionFor(target.id, "MEMBERSHIP_SUSPEND"))!;
      const { appeal } = await submitFor(ea.id, target.id);

      const { beginAppealReview, decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      await beginAppealReview({ reviewerId: reviewerSecond.id, appealId: appeal.id });
      expect(
        (await rawClient!.appeal.findUniqueOrThrow({ where: { id: appeal.id } })).status,
      ).toBe("IN_REVIEW");

      const result = await decideAppeal({
        reviewerId: reviewerFull.id,
        appealId: appeal.id,
        decision: "GRANTED",
      });
      expect(result.outcome).toBe("GRANTED");
      const membership = await rawClient!.campusMembership.findUniqueOrThrow({
        where: { userId_campusId: { userId: target.id, campusId: campusA.id } },
      });
      expect(membership.status).toBe("ACTIVE");
    });

    // ------------------------------------------------------------------
    // T17 appeal GRANT ‖ 新 suspension：subject 串行化，旧 appeal 不覆盖新处罚
    // ------------------------------------------------------------------
    it("T17 GRANT 与新 suspension 线性化：restoration 先提交，新处罚随后生效", async () => {
      const target = await createFixtureUser("T17目标", campusA.id);
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      await suspendAccount({ actorId: enforcerA.id, targetUserId: target.id, reasonCode: "POLICY_VIOLATION" });
      const appealedEA = (await latestActionFor(target.id, "ACCOUNT_SUSPEND"))!;
      const { appeal } = await submitFor(appealedEA.id, target.id);

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      let atBarrier!: () => void;
      const barrier = new Promise<void>((resolve) => {
        atBarrier = resolve;
      });
      let releaseGrant!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGrant = resolve;
      });

      const grantPromise = settled(
        decideAppeal({
          reviewerId: reviewerFull.id,
          appealId: appeal.id,
          decision: "GRANTED",
          racePoint: async () => {
            atBarrier();
            await gate;
          },
        }),
      );
      await barrier;
      // GRANT 持有 USER:target 锁 → 新 suspension 阻塞等待
      const suspendPromise = settled(
        suspendAccount({ actorId: enforcerB.id, targetUserId: target.id, reasonCode: "ACCOUNT_SECURITY" }),
      );
      releaseGrant();

      const grantResult = await grantPromise;
      const suspendResult = await suspendPromise;
      expect(grantResult.fulfilled).toBe(true);
      expect(suspendResult.fulfilled).toBe(true);

      // 线性化证据：restorative seq < 新 suspension seq；最终状态 = 新处罚生效
      const actions = await rawClient!.enforcementAction.findMany({
        where: { targetId: target.id },
        orderBy: { enforcementSeq: "asc" },
      });
      const restore = actions.find((a) => a.type === "ACCOUNT_REINSTATE" && a.sourceType === "APPEAL")!;
      const newestSuspend = actions.filter((a) => a.type === "ACCOUNT_SUSPEND").at(-1)!;
      expect(restore.enforcementSeq < newestSuspend.enforcementSeq).toBe(true);
      expect((await rawClient!.user.findUniqueOrThrow({ where: { id: target.id } })).status).toBe(
        "SUSPENDED",
      );
      expect(
        (await rawClient!.appeal.findUniqueOrThrow({ where: { id: appeal.id } })).status,
      ).toBe("GRANTED");
    });

    // ------------------------------------------------------------------
    // T18 / T19 review 锁序双方向：reviewer < target 与 target < reviewer，均 NO 40P01
    // ------------------------------------------------------------------
    it("T18/T19 锁序双方向并发：无死锁（NO 40P01），两事务均完成", async () => {
      const users = [];
      for (let index = 0; index < 4; index += 1) {
        users.push(await createFixtureUser(`T18用户${index}`, campusA.id));
      }
      const sorted = [...users].sort((a, b) => (a.id < b.id ? -1 : 1));
      // Case1：reviewer id < target id；Case2：reviewer id > target id
      const case1 = { reviewer: sorted[0]!, target: sorted[1]!, enforcer: sorted[2]! };
      const case2 = { reviewer: sorted[3]!, target: sorted[2]!, enforcer: sorted[0]! };
      expect(case1.reviewer.id < case1.target.id).toBe(true);
      expect(case2.reviewer.id > case2.target.id).toBe(true);

      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");

      for (const testCase of [case1, case2]) {
        await grantRole(testCase.reviewer.id, `T18R-${testCase.reviewer.id.slice(-6)}`, ["appeal.review", "user.suspend"], "GLOBAL");
        await suspendAccount({
          actorId: enforcerA.id,
          targetUserId: testCase.target.id,
          reasonCode: "POLICY_VIOLATION",
        });
        const ea = (await latestActionFor(testCase.target.id, "ACCOUNT_SUSPEND"))!;
        const { appeal } = await submitFor(ea.id, testCase.target.id);

        const results = await Promise.allSettled([
          decideAppeal({ reviewerId: testCase.reviewer.id, appealId: appeal.id, decision: "GRANTED" }),
          suspendAccount({
            actorId: enforcerA.id,
            targetUserId: testCase.target.id,
            reasonCode: "ACCOUNT_SECURITY",
          }),
        ]);
        for (const result of results) {
          expect(result.status).toBe("fulfilled");
        }
        const errorText = results
          .filter((r) => r.status === "rejected")
          .map((r) => String((r as PromiseRejectedResult).reason))
          .join("");
        expect(errorText).not.toContain("40P01");
        expect(
          (await rawClient!.appeal.findUniqueOrThrow({ where: { id: appeal.id } })).status,
        ).toBe("GRANTED");
      }
    }, 90_000);

    // ------------------------------------------------------------------
    // T20 / T21 submit ‖ erasure 双向确定性串行化
    // ------------------------------------------------------------------
    it("T20 submission wins：Appeal 保留 + User 随后被擦除（合法历史顺序）", async () => {
      const target = await createFixtureUser("T20目标", campusA.id);
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      await suspendAccount({ actorId: enforcerA.id, targetUserId: target.id, reasonCode: "POLICY_VIOLATION" });
      const ea = (await latestActionFor(target.id, "ACCOUNT_SUSPEND"))!;

      const { submitAppeal } = await import("@/lib/appeals/appeal-service");
      const { eraseAccount } = await import("@/lib/privacy/account-erasure");

      let atBarrier!: () => void;
      const barrier = new Promise<void>((resolve) => {
        atBarrier = resolve;
      });
      let releaseSubmit!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseSubmit = resolve;
      });

      const submitPromise = settled(
        submitAppeal({
          callerUserId: target.id,
          enforcementActionId: ea.id,
          statement: "T20",
          racePoint: async () => {
            atBarrier();
            await gate;
          },
        }),
      );
      await barrier;
      // submit 持有 USER:target 锁 → erasure 阻塞
      const erasePromise = settled(eraseAccount(target.id));
      releaseSubmit();

      const submitResult = await submitPromise;
      const eraseResult = await erasePromise;
      expect(submitResult.fulfilled).toBe(true);
      expect(eraseResult.fulfilled).toBe(true);

      expect(await rawClient!.appeal.count({ where: { enforcementActionId: ea.id } })).toBe(1);
      expect(
        (await rawClient!.user.findUniqueOrThrow({ where: { id: target.id } })).erasedAt,
      ).not.toBeNull();
    });

    it("T21 erasure wins：锁内重读见 erased → 提交拒绝，无 Appeal", async () => {
      const target = await createFixtureUser("T21目标", campusA.id);
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      await suspendAccount({ actorId: enforcerA.id, targetUserId: target.id, reasonCode: "POLICY_VIOLATION" });
      const ea = (await latestActionFor(target.id, "ACCOUNT_SUSPEND"))!;

      const { submitAppeal } = await import("@/lib/appeals/appeal-service");
      const { eraseAccount } = await import("@/lib/privacy/account-erasure");

      let atBarrier!: () => void;
      const barrier = new Promise<void>((resolve) => {
        atBarrier = resolve;
      });
      let releaseErase!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseErase = resolve;
      });

      const erasePromise = settled(
        eraseAccount(target.id, undefined, async () => {
          atBarrier();
          await gate;
        }),
      );
      await barrier;
      // erasure 持有 USER:target 锁 → submit 阻塞
      const submitPromise = settled(
        submitAppeal({ callerUserId: target.id, enforcementActionId: ea.id, statement: "T21" }),
      );
      releaseErase();

      const eraseResult = await erasePromise;
      const submitResult = await submitPromise;
      expect(eraseResult.fulfilled).toBe(true);
      expect(submitResult.fulfilled).toBe(false);
      expect(errorCodeOf(submitResult.error)).toBe("APPEAL_NOT_ALLOWED");
      expect(await rawClient!.appeal.count({ where: { enforcementActionId: ea.id } })).toBe(0);
    });

    // ------------------------------------------------------------------
    // T22 IN_REVIEW 无 claim ownership：reviewedById == 实际 terminal 决策者
    // ------------------------------------------------------------------
    it("T22 A 切 IN_REVIEW、B terminal GRANTED → reviewedById == B", async () => {
      const target = await createFixtureUser("T22目标", campusA.id);
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      await suspendAccount({ actorId: enforcerA.id, targetUserId: target.id, reasonCode: "POLICY_VIOLATION" });
      const ea = (await latestActionFor(target.id, "ACCOUNT_SUSPEND"))!;
      const { appeal } = await submitFor(ea.id, target.id);

      const { beginAppealReview, decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      await beginAppealReview({ reviewerId: reviewerSecond.id, appealId: appeal.id });
      const inReview = await rawClient!.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
      expect(inReview.status).toBe("IN_REVIEW");
      expect(inReview.reviewedById).toBeNull();
      expect(inReview.reviewedAt).toBeNull();

      const result = await decideAppeal({
        reviewerId: reviewerFull.id,
        appealId: appeal.id,
        decision: "GRANTED",
      });
      expect(result.outcome).toBe("GRANTED");
      const terminal = await rawClient!.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
      expect(terminal.reviewedById).toBe(reviewerFull.id);
      expect(terminal.reviewedById).not.toBe(reviewerSecond.id);
    });

    // ------------------------------------------------------------------
    // T24 legacy provenance review：committed DISMISSED + 零 operational restoration
    // ------------------------------------------------------------------
    it("T24 legacy 申诉为提交式 DISMISSED（审计落行 + 零恢复）", async () => {
      const actor = await createFixtureUser("T24执法员", campusA.id);
      const target = await createFixtureUser("T24目标", campusA.id);
      await insertRawAction({
        id: `${RUN_TAG}-t24-legacy`,
        type: "MARKETPLACE_RESTRICT",
        actorId: actor.id,
        targetId: target.id,
        campusId: null,
        scopeKey: "GLOBAL",
        previousState: null,
        resultState: "RISK_STATE:RESTRICTED@GLOBAL",
        enforcementSeq: SYNTHETIC_T24_LEGACY_SEQ,
      });
      const { appeal } = await submitFor(`${RUN_TAG}-t24-legacy`, target.id);

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      const result = await decideAppeal({
        reviewerId: reviewerFull.id,
        appealId: appeal.id,
        decision: "GRANTED",
      });

      expect(result).toMatchObject({ outcome: "DISMISSED", reasonCode: "LEGACY_PROVENANCE_INSUFFICIENT" });
      // 零 operational restoration：无 RiskState 行（无行 = NORMAL 默认，未被创建/改写）、
      // 无 MARKETPLACE_RESTORE 动作
      expect(
        await rawClient!.riskState.count({ where: { userId: target.id } }),
      ).toBe(0);
      expect(
        await rawClient!.enforcementAction.count({
          where: { targetId: target.id, type: "MARKETPLACE_RESTORE" },
        }),
      ).toBe(0);
      const audit = await rawClient!.adminLog.findFirstOrThrow({
        where: { targetType: "APPEAL", targetId: appeal.id, action: "APPEAL_DISMISSED" },
      });
      expect(audit.detail).toBeNull();
      expect((audit.metadata as Record<string, unknown>).decisionReasonCode).toBe(
        "LEGACY_PROVENANCE_INSUFFICIENT",
      );
    });

    // ------------------------------------------------------------------
    // T25–T29 Appeal 导出（v2 / ownership / 内部字段）
    // ------------------------------------------------------------------
    it("T25–T29 self export 包含 own Appeal；reviewer 导出不包含他人 Appeal；内部字段隔离", async () => {
      const target = await createFixtureUser("T25目标", campusA.id);
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      await suspendAccount({ actorId: reviewerFull.id, targetUserId: target.id, reasonCode: "POLICY_VIOLATION" });
      const ea = (await latestActionFor(target.id, "ACCOUNT_SUSPEND"))!;
      const { appeal } = await submitFor(ea.id, target.id);

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      const canary = "APPEAL_EXPORT_INTERNAL_CANARY";
      await decideAppeal({
        reviewerId: reviewerFull.id,
        appealId: appeal.id,
        decision: "UPHELD",
        decisionNote: canary,
      });

      const { buildUserExport, assertNoForbiddenExportFields } = await import(
        "@/lib/privacy/data-export"
      );

      // T25/T29：owner 导出包含 own appeal，格式精确 v2
      const payload = await buildUserExport(target.id);
      expect(payload.format).toBe("campus-marketplace.user-export/v2");
      expect(payload.appeals).toHaveLength(1);
      expect(payload.appeals[0]).toMatchObject({
        id: appeal.id,
        enforcementActionId: ea.id,
        enforcementType: "ACCOUNT_SUSPEND",
        status: "UPHELD",
        decisionReasonCode: "MERIT_VIOLATION_CONFIRMED",
        reviewedAt: expect.any(String),
      });

      // T27：内部字段（decisionNote canary / reviewedById / 审计）绝不序列化
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain(canary);
      expect(serialized).not.toContain("reviewedById");
      expect(serialized).not.toContain("internal-id-");

      // T26：reviewer（非 owner）导出不包含其审核过的他人 Appeal
      const reviewerPayload = await buildUserExport(reviewerFull.id);
      expect(reviewerPayload.appeals).toHaveLength(0);

      // T28：forbidden-key 出口扫描对完整 payload PASS，对注入键 fail closed
      expect(() => assertNoForbiddenExportFields(payload)).not.toThrow();
      expect(() => assertNoForbiddenExportFields({ decisionNote: canary })).toThrow(/decisionNote/);
      expect(() => assertNoForbiddenExportFields({ reviewedById: "internal-id-x" })).toThrow(
        /reviewedById/,
      );
    });

    // ------------------------------------------------------------------
    // T32 / T33 / T34 GRANT restorative provenance 三族矩阵
    // ------------------------------------------------------------------
    it("T32 ACCOUNT GRANT → restorative EA provenance 精确（note=null / detail=null）", async () => {
      const target = await createFixtureUser("T32目标", campusA.id);
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      await suspendAccount({ actorId: enforcerA.id, targetUserId: target.id, reasonCode: "POLICY_VIOLATION" });
      const appealedEA = (await latestActionFor(target.id, "ACCOUNT_SUSPEND"))!;
      const { appeal } = await submitFor(appealedEA.id, target.id);

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      await decideAppeal({ reviewerId: reviewerFull.id, appealId: appeal.id, decision: "GRANTED" });

      const restorative = (await latestActionFor(target.id, "ACCOUNT_REINSTATE"))!;
      expect(restorative.reasonCode).toBe("APPEAL_GRANTED");
      expect(restorative.sourceType).toBe("APPEAL");
      expect(restorative.sourceId).toBe(appeal.id);
      expect(restorative.previousState).toBe("USER:SUSPENDED");
      expect(restorative.resultState).toBe("USER:ACTIVE");
      expect(restorative.enforcementSeq > appealedEA.enforcementSeq).toBe(true);
      expect(restorative.note).toBeNull();
      expect((await rawClient!.user.findUniqueOrThrow({ where: { id: target.id } })).status).toBe(
        "ACTIVE",
      );
      const audit = await rawClient!.adminLog.findFirstOrThrow({
        where: { targetType: "APPEAL", targetId: appeal.id, action: "APPEAL_GRANTED" },
      });
      expect(audit.detail).toBeNull();
      expect(
        (await rawClient!.appeal.findUniqueOrThrow({ where: { id: appeal.id } })).decisionReasonCode,
      ).toBe("MERIT_APPEAL_JUSTIFIED");
    });

    it("T33 MEMBERSHIP GRANT → restorative EA provenance 精确（同 campus）", async () => {
      const target = await createFixtureUser("T33目标", campusA.id);
      const { suspendCampusMembership } = await import(
        "@/lib/enforcement/membership-enforcement-service"
      );
      await suspendCampusMembership({
        actorId: enforcerA.id,
        targetUserId: target.id,
        campusId: campusA.id,
        reasonCode: "POLICY_VIOLATION",
      });
      const appealedEA = (await latestActionFor(target.id, "MEMBERSHIP_SUSPEND"))!;
      const { appeal } = await submitFor(appealedEA.id, target.id);

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      await decideAppeal({ reviewerId: reviewerFull.id, appealId: appeal.id, decision: "GRANTED" });

      const restorative = (await latestActionFor(target.id, "MEMBERSHIP_REINSTATE"))!;
      expect(restorative.reasonCode).toBe("APPEAL_GRANTED");
      expect(restorative.sourceType).toBe("APPEAL");
      expect(restorative.sourceId).toBe(appeal.id);
      expect(restorative.campusId).toBe(campusA.id);
      expect(restorative.previousState).toBe("CAMPUS_MEMBERSHIP:SUSPENDED");
      expect(restorative.resultState).toBe("CAMPUS_MEMBERSHIP:ACTIVE");
      expect(restorative.note).toBeNull();
    });

    it("T34 RISK GRANT（campus WATCH 案例）→ 精确恢复 WATCH + provenance", async () => {
      const target = await createFixtureUser("T34目标", campusA.id);
      const { setRiskState } = await import("@/lib/enforcement/risk-service");
      await setRiskState({
        actorId: enforcerA.id,
        targetUserId: target.id,
        campusId: campusA.id,
        state: "WATCH",
        reasonCode: "MANUAL_REVIEW",
      });
      await setRiskState({
        actorId: enforcerA.id,
        targetUserId: target.id,
        campusId: campusA.id,
        state: "RESTRICTED",
        reasonCode: "FRAUD_CONFIRMED",
      });
      const appealedEA = (await latestActionFor(target.id, "MARKETPLACE_RESTRICT"))!;
      const { appeal } = await submitFor(appealedEA.id, target.id);

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      await decideAppeal({ reviewerId: reviewerFull.id, appealId: appeal.id, decision: "GRANTED" });

      const restorative = (await latestActionFor(target.id, "MARKETPLACE_RESTORE"))!;
      expect(restorative.reasonCode).toBe("APPEAL_GRANTED");
      expect(restorative.sourceType).toBe("APPEAL");
      expect(restorative.sourceId).toBe(appeal.id);
      expect(restorative.previousState).toBe(`RISK_STATE:RESTRICTED@CAMPUS:${campusA.id}`);
      expect(restorative.resultState).toBe(`RISK_STATE:WATCH@CAMPUS:${campusA.id}`);
      expect(restorative.note).toBeNull();
      const risk = await rawClient!.riskState.findUniqueOrThrow({
        where: { userId_scopeKey: { userId: target.id, scopeKey: `CAMPUS:${campusA.id}` } },
      });
      expect(risk.state).toBe("WATCH");
    });

    // ------------------------------------------------------------------
    // T35 withdraw vs erasure 双向；T36 withdraw vs begin-review 双向
    // ------------------------------------------------------------------
    it("T35 WITHDRAW_VS_ERASURE：Case A withdraw 先胜 / Case B erasure 先胜", async () => {
      const { withdrawAppeal } = await import("@/lib/appeals/appeal-service");
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      const { eraseAccount } = await import("@/lib/privacy/account-erasure");

      // ---- Case A：withdraw 持行锁 + USER 锁 → erasure 等待 → WITHDRAWN 提交 ----
      const targetA = await createFixtureUser("T35目标A", campusA.id);
      await suspendAccount({ actorId: enforcerA.id, targetUserId: targetA.id, reasonCode: "POLICY_VIOLATION" });
      const eaA = (await latestActionFor(targetA.id, "ACCOUNT_SUSPEND"))!;
      const appealA = await submitFor(eaA.id, targetA.id);

      let atBarrierA!: () => void;
      const barrierA = new Promise<void>((resolve) => {
        atBarrierA = resolve;
      });
      let releaseA!: () => void;
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const withdrawPromiseA = settled(
        withdrawAppeal({
          callerUserId: targetA.id,
          appealId: appealA.appeal.id,
          racePoint: async () => {
            atBarrierA();
            await gateA;
          },
        }),
      );
      await barrierA;
      const erasePromiseA = settled(eraseAccount(targetA.id));
      releaseA();

      const wA = await withdrawPromiseA;
      const eA = await erasePromiseA;
      expect(wA.fulfilled).toBe(true);
      expect(eA.fulfilled).toBe(true);
      expect(
        (await rawClient!.appeal.findUniqueOrThrow({ where: { id: appealA.appeal.id } })).status,
      ).toBe("WITHDRAWN");
      expect(
        (await rawClient!.user.findUniqueOrThrow({ where: { id: targetA.id } })).erasedAt,
      ).not.toBeNull();

      // ---- Case B：erasure 先持 USER 锁 → withdraw 锁内重读见 erased → DENY ----
      const targetB = await createFixtureUser("T35目标B", campusA.id);
      await suspendAccount({ actorId: enforcerA.id, targetUserId: targetB.id, reasonCode: "POLICY_VIOLATION" });
      const eaB = (await latestActionFor(targetB.id, "ACCOUNT_SUSPEND"))!;
      const appealB = await submitFor(eaB.id, targetB.id);

      let atBarrierB!: () => void;
      const barrierB = new Promise<void>((resolve) => {
        atBarrierB = resolve;
      });
      let releaseB!: () => void;
      const gateB = new Promise<void>((resolve) => {
        releaseB = resolve;
      });
      const erasePromiseB = settled(
        eraseAccount(targetB.id, undefined, async () => {
          atBarrierB();
          await gateB;
        }),
      );
      await barrierB;
      const withdrawPromiseB = settled(
        withdrawAppeal({ callerUserId: targetB.id, appealId: appealB.appeal.id }),
      );
      releaseB();

      const eB = await erasePromiseB;
      const wB = await withdrawPromiseB;
      expect(eB.fulfilled).toBe(true);
      expect(wB.fulfilled).toBe(false);
      expect(errorCodeOf(wB.error)).toBe("APPEAL_NOT_ALLOWED");
      expect(
        (await rawClient!.appeal.findUniqueOrThrow({ where: { id: appealB.appeal.id } })).status,
      ).toBe("SUBMITTED");
      expect(
        (await rawClient!.user.findUniqueOrThrow({ where: { id: targetB.id } })).erasedAt,
      ).not.toBeNull();

      // reviewer 事后走 DISMISSED(APPELLANT_ERASED)（committed 结局）
      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      const dismissed = await decideAppeal({
        reviewerId: reviewerFull.id,
        appealId: appealB.appeal.id,
        decision: "GRANTED",
      });
      expect(dismissed).toMatchObject({ outcome: "DISMISSED", reasonCode: "APPELLANT_ERASED" });
    }, 90_000);

    it("T36 WITHDRAW_VS_BEGIN_REVIEW：恰一状态迁移、恰一胜者", async () => {
      const { withdrawAppeal } = await import("@/lib/appeals/appeal-service");
      const { beginAppealReview } = await import("@/lib/appeals/appeal-review-service");
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");

      // ---- Case 1：withdraw wins → begin review 见 terminal → INVALID_TRANSITION ----
      const targetA = await createFixtureUser("T36目标A", campusA.id);
      await suspendAccount({ actorId: enforcerA.id, targetUserId: targetA.id, reasonCode: "POLICY_VIOLATION" });
      const eaA = (await latestActionFor(targetA.id, "ACCOUNT_SUSPEND"))!;
      const appealA = await submitFor(eaA.id, targetA.id);

      let atBarrier1!: () => void;
      const barrier1 = new Promise<void>((resolve) => {
        atBarrier1 = resolve;
      });
      let release1!: () => void;
      const gate1 = new Promise<void>((resolve) => {
        release1 = resolve;
      });
      const withdrawPromise = settled(
        withdrawAppeal({
          callerUserId: targetA.id,
          appealId: appealA.appeal.id,
          racePoint: async () => {
            atBarrier1();
            await gate1;
          },
        }),
      );
      await barrier1;
      const beginPromise = settled(
        beginAppealReview({ reviewerId: reviewerFull.id, appealId: appealA.appeal.id }),
      );
      release1();

      const w = await withdrawPromise;
      const b = await beginPromise;
      expect(w.fulfilled).toBe(true);
      expect(b.fulfilled).toBe(false);
      expect(errorCodeOf(b.error)).toBe("APPEAL_INVALID_TRANSITION");
      expect(
        (await rawClient!.appeal.findUniqueOrThrow({ where: { id: appealA.appeal.id } })).status,
      ).toBe("WITHDRAWN");

      // ---- Case 2：begin review wins → withdraw 见 IN_REVIEW → INVALID_TRANSITION ----
      const targetB = await createFixtureUser("T36目标B", campusA.id);
      await suspendAccount({ actorId: enforcerA.id, targetUserId: targetB.id, reasonCode: "POLICY_VIOLATION" });
      const eaB = (await latestActionFor(targetB.id, "ACCOUNT_SUSPEND"))!;
      const appealB = await submitFor(eaB.id, targetB.id);

      let atBarrier2!: () => void;
      const barrier2 = new Promise<void>((resolve) => {
        atBarrier2 = resolve;
      });
      let release2!: () => void;
      const gate2 = new Promise<void>((resolve) => {
        release2 = resolve;
      });
      const beginPromise2 = settled(
        beginAppealReview({
          reviewerId: reviewerFull.id,
          appealId: appealB.appeal.id,
          racePoint: async () => {
            atBarrier2();
            await gate2;
          },
        }),
      );
      await barrier2;
      const withdrawPromise2 = settled(
        withdrawAppeal({ callerUserId: targetB.id, appealId: appealB.appeal.id }),
      );
      release2();

      const b2 = await beginPromise2;
      const w2 = await withdrawPromise2;
      expect(b2.fulfilled).toBe(true);
      expect(w2.fulfilled).toBe(false);
      expect(errorCodeOf(w2.error)).toBe("APPEAL_INVALID_TRANSITION");
      expect(
        (await rawClient!.appeal.findUniqueOrThrow({ where: { id: appealB.appeal.id } })).status,
      ).toBe("IN_REVIEW");
    }, 90_000);

    // ------------------------------------------------------------------
    // T37 decisionNote canary 隔离
    // ------------------------------------------------------------------
    it("T37 APPEAL_INTERNAL_NOTE_CANARY 只存在于 Appeal.decisionNote", async () => {
      const target = await createFixtureUser("T37目标", campusA.id);
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      await suspendAccount({ actorId: enforcerA.id, targetUserId: target.id, reasonCode: "POLICY_VIOLATION" });
      const ea = (await latestActionFor(target.id, "ACCOUNT_SUSPEND"))!;
      const { appeal } = await submitFor(ea.id, target.id);

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      const canary = "APPEAL_INTERNAL_NOTE_CANARY";
      await decideAppeal({
        reviewerId: reviewerFull.id,
        appealId: appeal.id,
        decision: "GRANTED",
        decisionNote: canary,
      });

      // present：Appeal.decisionNote
      const row = await rawClient!.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
      expect(row.decisionNote).toBe(canary);

      // absent：EnforcementAction.note（全部行）
      const actions = await rawClient!.enforcementAction.findMany({ where: { targetId: target.id } });
      expect(actions.length).toBeGreaterThanOrEqual(2);
      for (const action of actions) {
        expect(action.note).toBeNull();
      }

      // absent：AdminLog.detail / metadata
      const audits = await rawClient!.adminLog.findMany({
        where: { targetType: "APPEAL", targetId: appeal.id },
      });
      expect(audits.length).toBeGreaterThanOrEqual(1);
      for (const audit of audits) {
        expect(audit.detail).toBeNull();
        expect(JSON.stringify(audit.metadata ?? {})).not.toContain(canary);
      }

      // absent：Notification content（固定文案）
      const notifications = await rawClient!.notification.findMany({
        where: { userId: target.id },
      });
      for (const notification of notifications) {
        expect(notification.content).not.toContain(canary);
        expect(notification.title).not.toContain(canary);
      }
    });

    // ------------------------------------------------------------------
    // T39 malformed non-null provenance → DISMISSED(LEGACY_PROVENANCE_INSUFFICIENT)
    // （seq >= boundary 但 previousState 不是该族合法 pre-state 形状）
    // ------------------------------------------------------------------
    it("T39 ACCOUNT/MEMBERSHIP 损坏的非空 previousState：零恢复 fail closed", async () => {
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      const { suspendCampusMembership } = await import(
        "@/lib/enforcement/membership-enforcement-service"
      );

      // ACCOUNT：canonical 行 + previousState 损坏为 garbage（非 null、非法形状）
      const accountTarget = await createFixtureUser("T39账号目标", campusA.id);
      await suspendAccount({
        actorId: enforcerA.id,
        targetUserId: accountTarget.id,
        reasonCode: "POLICY_VIOLATION",
      });
      const accountEA = (await latestActionFor(accountTarget.id, "ACCOUNT_SUSPEND"))!;
      await rawClient!.$executeRaw`
        UPDATE "EnforcementAction" SET "previousState" = 'garbage' WHERE "id" = ${accountEA.id}`;
      const accountAppeal = await submitFor(accountEA.id, accountTarget.id);

      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      const accountResult = await decideAppeal({
        reviewerId: reviewerFull.id,
        appealId: accountAppeal.appeal.id,
        decision: "GRANTED",
      });
      expect(accountResult).toMatchObject({
        outcome: "DISMISSED",
        reasonCode: "LEGACY_PROVENANCE_INSUFFICIENT",
      });
      expect(
        (await rawClient!.user.findUniqueOrThrow({ where: { id: accountTarget.id } })).status,
      ).toBe("SUSPENDED");
      expect(
        await rawClient!.enforcementAction.count({
          where: { targetId: accountTarget.id, type: "ACCOUNT_REINSTATE" },
        }),
      ).toBe(0);

      // MEMBERSHIP：previousState 损坏为 SUSPENDED（同族但非合法 pre-state）
      const memberTarget = await createFixtureUser("T39成员目标", campusA.id);
      await suspendCampusMembership({
        actorId: enforcerA.id,
        targetUserId: memberTarget.id,
        campusId: campusA.id,
        reasonCode: "POLICY_VIOLATION",
      });
      const memberEA = (await latestActionFor(memberTarget.id, "MEMBERSHIP_SUSPEND"))!;
      await rawClient!.$executeRaw`
        UPDATE "EnforcementAction" SET "previousState" = 'CAMPUS_MEMBERSHIP:SUSPENDED'
        WHERE "id" = ${memberEA.id}`;
      const memberAppeal = await submitFor(memberEA.id, memberTarget.id);

      const memberResult = await decideAppeal({
        reviewerId: reviewerFull.id,
        appealId: memberAppeal.appeal.id,
        decision: "GRANTED",
      });
      expect(memberResult).toMatchObject({
        outcome: "DISMISSED",
        reasonCode: "LEGACY_PROVENANCE_INSUFFICIENT",
      });
      const membership = await rawClient!.campusMembership.findUniqueOrThrow({
        where: { userId_campusId: { userId: memberTarget.id, campusId: campusA.id } },
      });
      expect(membership.status).toBe("SUSPENDED");
      expect(
        await rawClient!.enforcementAction.count({
          where: { targetId: memberTarget.id, type: "MEMBERSHIP_REINSTATE" },
        }),
      ).toBe(0);
    });

    // ------------------------------------------------------------------
    // T40 enforcement scope coherence fail closed（malformed 行无法确立 review scope）
    // ------------------------------------------------------------------
    it("T40 malformed campusId/scopeKey：campus 与 GLOBAL reviewer 一律 DENY；well-formed 不受影响", async () => {
      const campusReviewerA = await createFixtureUser("T40校区审核员", campusA.id);
      await grantRole(campusReviewerA.id, "T40_REVIEWER_A", ["appeal.review"], "CAMPUS", campusA.id);
      const eaTarget = await createFixtureUser("T40目标", campusA.id);

      // malformed ACCOUNT_SUSPEND：campusId 非空 + scopeKey=GLOBAL
      await insertRawAction({
        id: `${RUN_TAG}-t40-account`,
        type: "ACCOUNT_SUSPEND",
        actorId: enforcerA.id,
        targetId: eaTarget.id,
        campusId: campusA.id,
        scopeKey: "GLOBAL",
        previousState: "USER:ACTIVE",
        resultState: "USER:SUSPENDED",
        enforcementSeq: SYNTHETIC_T40_MALFORMED_ACCOUNT_SEQ,
      });
      const malformedAccountAppeal = await submitFor(`${RUN_TAG}-t40-account`, eaTarget.id);

      const { beginAppealReview, decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      await expect(
        beginAppealReview({
          reviewerId: campusReviewerA.id,
          appealId: malformedAccountAppeal.appeal.id,
        }),
      ).rejects.toMatchObject({ code: "APPEAL_REVIEW_FORBIDDEN" });
      await expect(
        decideAppeal({
          reviewerId: reviewerFull.id,
          appealId: malformedAccountAppeal.appeal.id,
          decision: "GRANTED",
        }),
      ).rejects.toMatchObject({ code: "APPEAL_REVIEW_FORBIDDEN" });

      // malformed MARKETPLACE_RESTRICT：campusId=campus-A + scopeKey=CAMPUS:campus-B
      await insertRawAction({
        id: `${RUN_TAG}-t40-risk`,
        type: "MARKETPLACE_RESTRICT",
        actorId: enforcerA.id,
        targetId: eaTarget.id,
        campusId: campusA.id,
        scopeKey: `CAMPUS:${campusB.id}`,
        previousState: `RISK_STATE:NORMAL@CAMPUS:${campusB.id}`,
        resultState: `RISK_STATE:RESTRICTED@CAMPUS:${campusB.id}`,
        enforcementSeq: SYNTHETIC_T40_MALFORMED_RISK_SEQ,
      });
      const malformedRiskAppeal = await submitFor(`${RUN_TAG}-t40-risk`, eaTarget.id);
      await expect(
        decideAppeal({
          reviewerId: reviewerFull.id,
          appealId: malformedRiskAppeal.appeal.id,
          decision: "GRANTED",
        }),
      ).rejects.toMatchObject({ code: "APPEAL_REVIEW_FORBIDDEN" });

      // GLOBAL reviewer 对 well-formed campus appeal 行为不变
      const wellFormedTarget = await createFixtureUser("T40well目标", campusA.id);
      const { suspendCampusMembership } = await import(
        "@/lib/enforcement/membership-enforcement-service"
      );
      await suspendCampusMembership({
        actorId: enforcerA.id,
        targetUserId: wellFormedTarget.id,
        campusId: campusA.id,
        reasonCode: "POLICY_VIOLATION",
      });
      const wellFormedEA = (await latestActionFor(wellFormedTarget.id, "MEMBERSHIP_SUSPEND"))!;
      const wellFormedAppeal = await submitFor(wellFormedEA.id, wellFormedTarget.id);
      await beginAppealReview({ reviewerId: reviewerFull.id, appealId: wellFormedAppeal.appeal.id });
      expect(
        (
          await rawClient!.appeal.findUniqueOrThrow({
            where: { id: wellFormedAppeal.appeal.id },
          })
        ).status,
      ).toBe("IN_REVIEW");
    });

    // ------------------------------------------------------------------
    // T41 ownership anti-enumeration：outsider 无法通过错误码推断 target 状态
    // ------------------------------------------------------------------
    it("T41 outsider 对 active/erased/deleted target 全部 APPEAL_NOT_OWNED/404；owner erased → NOT_ALLOWED", async () => {
      const outsider = await createFixtureUser("T41旁人", campusA.id);
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      const { eraseAccount } = await import("@/lib/privacy/account-erasure");
      const { submitAppeal, withdrawAppeal } = await import("@/lib/appeals/appeal-service");

      // active target：outsider submit → NOT_OWNED
      const activeTarget = await createFixtureUser("T41active", campusA.id);
      await suspendAccount({ actorId: enforcerA.id, targetUserId: activeTarget.id, reasonCode: "POLICY_VIOLATION" });
      const activeEA = (await latestActionFor(activeTarget.id, "ACCOUNT_SUSPEND"))!;
      await expect(
        submitAppeal({
          callerUserId: outsider.id,
          enforcementActionId: activeEA.id,
          statement: "T41",
        }),
      ).rejects.toMatchObject({ code: "APPEAL_NOT_OWNED", status: 404 });

      // erased target：outsider submit → 同样 NOT_OWNED（非 NOT_ALLOWED）
      const erasedTarget = await createFixtureUser("T41erased", campusA.id);
      await suspendAccount({ actorId: enforcerA.id, targetUserId: erasedTarget.id, reasonCode: "POLICY_VIOLATION" });
      const erasedEA = (await latestActionFor(erasedTarget.id, "ACCOUNT_SUSPEND"))!;
      await eraseAccount(erasedTarget.id);
      await expect(
        submitAppeal({
          callerUserId: outsider.id,
          enforcementActionId: erasedEA.id,
          statement: "T41",
        }),
      ).rejects.toMatchObject({ code: "APPEAL_NOT_OWNED", status: 404 });
      // owner 本人 erased 后提交 → NOT_ALLOWED（语义区分仅对 owner 存在）
      await expect(
        submitAppeal({
          callerUserId: erasedTarget.id,
          enforcementActionId: erasedEA.id,
          statement: "T41",
        }),
      ).rejects.toMatchObject({ code: "APPEAL_NOT_ALLOWED" });

      // deleted target：outsider submit → 同样 NOT_OWNED
      const deletedTarget = await createFixtureUser("T41deleted", campusA.id);
      await suspendAccount({ actorId: enforcerA.id, targetUserId: deletedTarget.id, reasonCode: "POLICY_VIOLATION" });
      const deletedEA = (await latestActionFor(deletedTarget.id, "ACCOUNT_SUSPEND"))!;
      await rawClient!.$executeRaw`
        UPDATE "User" SET "deletedAt" = NOW() WHERE "id" = ${deletedTarget.id}`;
      await expect(
        submitAppeal({
          callerUserId: outsider.id,
          enforcementActionId: deletedEA.id,
          statement: "T41",
        }),
      ).rejects.toMatchObject({ code: "APPEAL_NOT_OWNED", status: 404 });

      // withdraw 同合同：owner 的 SUBMITTED appeal 在 target 被 deleted 后，
      // outsider withdraw → NOT_OWNED（不得泄露注销状态）；owner withdraw → NOT_ALLOWED
      const ownerAppeal = await submitFor(deletedEA.id, deletedTarget.id).catch(() => null);
      expect(ownerAppeal).toBeNull(); // deleted target 上 owner 也无法新建
      const liveTarget = await createFixtureUser("T41live", campusA.id);
      await suspendAccount({ actorId: enforcerA.id, targetUserId: liveTarget.id, reasonCode: "POLICY_VIOLATION" });
      const liveEA = (await latestActionFor(liveTarget.id, "ACCOUNT_SUSPEND"))!;
      const liveAppeal = await submitFor(liveEA.id, liveTarget.id);
      await rawClient!.$executeRaw`
        UPDATE "User" SET "deletedAt" = NOW() WHERE "id" = ${liveTarget.id}`;
      await expect(
        withdrawAppeal({ callerUserId: outsider.id, appealId: liveAppeal.appeal.id }),
      ).rejects.toMatchObject({ code: "APPEAL_NOT_OWNED", status: 404 });
      await expect(
        withdrawAppeal({ callerUserId: liveTarget.id, appealId: liveAppeal.appeal.id }),
      ).rejects.toMatchObject({ code: "APPEAL_NOT_ALLOWED" });
      expect(
        (await rawClient!.appeal.findUniqueOrThrow({ where: { id: liveAppeal.appeal.id } })).status,
      ).toBe("SUBMITTED");
    });

    // ------------------------------------------------------------------
    // T38 FK referential action contract（catalog + 破坏性 DELETE）
    // ------------------------------------------------------------------
    it("T38-A/T38-D FK catalog RESTRICT + Prisma/DB drift NONE", async () => {
      // T38-A：真实 DB catalog（非 migration 文本）
      const constraints = await rawClient!.$queryRaw<
        { constraint_name: string; delete_rule: string; update_rule: string }[]
      >`SELECT rc."constraint_name" AS constraint_name, rc."delete_rule" AS delete_rule, rc."update_rule" AS update_rule
         FROM information_schema.referential_constraints rc
         WHERE rc."constraint_name" IN ('Appeal_enforcementActionId_fkey', 'Appeal_reviewedById_fkey')`;
      expect(constraints).toHaveLength(2);
      for (const constraint of constraints) {
        expect(constraint.delete_rule).toBe("RESTRICT");
        expect(constraint.update_rule).toBe("CASCADE");
      }

      // T38-D：Prisma schema vs migration-applied DB drift = NONE（记录真实命令）
      const tempDb = `campus_p6c1b_diff_${randomUUID().slice(0, 8)}`;
      const shadowDb = `campus_p6c1b_shadow_${randomUUID().slice(0, 8)}`;
      await createTempDatabase(tempDb);
      await createTempDatabase(shadowDb);
      try {
        // 以全量 migrations 重建（真实 applied DB）
        runPrismaCli(["migrate", "deploy"], swapDatabaseName(integrationDatabaseUrl!, tempDb));
        const diffOutput = runPrismaCli(
          [
            "migrate", "diff",
            "--from-migrations", "prisma/migrations",
            "--to-schema-datamodel", "prisma/schema.prisma",
            "--shadow-database-url", swapDatabaseName(integrationDatabaseUrl!, shadowDb),
            "--script",
          ],
          integrationDatabaseUrl!,
        );
        expect(diffOutput).toContain("This is an empty migration");
      } finally {
        await dropTempDatabase(tempDb);
        await dropTempDatabase(shadowDb);
      }
    }, 240_000);

    it("T38-B/C 真实 DELETE 被 FK 拒绝：reviewer 与 EA provenance 均保留", async () => {
      const target = await createFixtureUser("T38目标", campusA.id);
      const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
      await suspendAccount({ actorId: enforcerA.id, targetUserId: target.id, reasonCode: "POLICY_VIOLATION" });
      const ea = (await latestActionFor(target.id, "ACCOUNT_SUSPEND"))!;
      const { appeal } = await submitFor(ea.id, target.id);
      const { decideAppeal } = await import("@/lib/appeals/appeal-review-service");
      await decideAppeal({ reviewerId: reviewerFull.id, appealId: appeal.id, decision: "UPHELD" });

      // T38-B：真实 DELETE reviewer User → FK 拒绝（23503）；Appeal/provenance 不变。
      // 注：User 被多个 RESTRICT 子表引用，拒绝可能来自任一 FK——
      // 精确的 Appeal FK 合同由 T38-A catalog 断言负责，本测试负责端到端结果。
      let reviewerDeleteError: unknown = null;
      try {
        await rawClient!.$executeRaw`DELETE FROM "User" WHERE "id" = ${reviewerFull.id}`;
      } catch (error) {
        reviewerDeleteError = error;
      }
      expect(reviewerDeleteError).toBeTruthy();
      expect(String(reviewerDeleteError)).toContain("23503");
      const preservedAppeal = await rawClient!.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
      expect(preservedAppeal.reviewedById).toBe(reviewerFull.id);
      expect(preservedAppeal.status).toBe("UPHELD");

      // T38-C：真实 DELETE 被引用的 EnforcementAction → FK 拒绝；Appeal 引用不变
      let eaDeleteError: unknown = null;
      try {
        await rawClient!.$executeRaw`DELETE FROM "EnforcementAction" WHERE "id" = ${ea.id}`;
      } catch (error) {
        eaDeleteError = error;
      }
      expect(eaDeleteError).toBeTruthy();
      expect(String(eaDeleteError)).toContain("23503");
      const reloaded = await rawClient!.appeal.findUniqueOrThrow({ where: { id: appeal.id } });
      expect(reloaded.enforcementActionId).toBe(ea.id);
    });

    // ------------------------------------------------------------------
    // D-1..D-6 migration 验证全集（真实 PostgreSQL）
    // ------------------------------------------------------------------
    it("D-1/D-2/D-6 fresh migrate deploy ×2（无 pending）+ FK referential action catalog", async () => {
      const tempDb = `campus_p6c1b_d1_${randomUUID().slice(0, 8)}`;
      const tempUrl = await createTempDatabase(tempDb);
      try {
        // D-1：fresh database migrate deploy = PASS
        const deployOutput = runPrismaCli(["migrate", "deploy"], tempUrl);
        expect(deployOutput).not.toContain("error");

        // D-6：FK referential action catalog verification（真实 applied DB）
        const tempClient = new PrismaClient({ datasources: { db: { url: tempUrl } }, log: ["error"] });
        try {
          const constraints = await tempClient.$queryRaw<
            { constraint_name: string; delete_rule: string; update_rule: string }[]
          >`SELECT rc."constraint_name" AS constraint_name, rc."delete_rule" AS delete_rule, rc."update_rule" AS update_rule
             FROM information_schema.referential_constraints rc
             WHERE rc."constraint_name" IN ('Appeal_enforcementActionId_fkey', 'Appeal_reviewedById_fkey')`;
          expect(constraints).toHaveLength(2);
          for (const constraint of constraints) {
            expect(constraint.delete_rule).toBe("RESTRICT");
            expect(constraint.update_rule).toBe("CASCADE");
          }

          // appeal.review permission 已回填且授权 PLATFORM_ADMIN
          const permission = await tempClient.permission.findUnique({ where: { key: "appeal.review" } });
          expect(permission).toBeTruthy();
          const grant = await tempClient.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(*)::int AS count FROM "RolePermission" rp
            JOIN "Permission" p ON p."id" = rp."permissionId"
            JOIN "Role" r ON r."id" = rp."roleId"
            WHERE p."key" = 'appeal.review' AND r."key" = 'PLATFORM_ADMIN'`;
          expect(grant[0]!.count).toBe(1);

          // APPEAL_GRANTED 枚举值存在（migration 已提交）。
          // 双侧转 text：目标值不存在时，text→enum 强转会在解析期报 22P02
          const enumValues = await tempClient.$queryRaw<{ present: boolean }[]>`
            SELECT 'APPEAL_GRANTED'::text = ANY(enum_range(NULL::"EnforcementReasonCode")::text[]) AS present`;
          expect(enumValues[0]!.present).toBe(true);
        } finally {
          await tempClient.$disconnect();
        }

        // D-2：second deploy = No pending migrations
        const secondOutput = runPrismaCli(["migrate", "deploy"], tempUrl);
        expect(secondOutput).toContain("No pending migrations");
      } finally {
        await dropTempDatabase(tempDb);
      }
    }, 240_000);

    it("D-3 pre-6C-1B schema upgrade → 新 migration = PASS", async () => {
      const tempDb = `campus_p6c1b_d3_${randomUUID().slice(0, 8)}`;
      const tempUrl = await createTempDatabase(tempDb);
      try {
        const migrationsDir = path.resolve("prisma", "migrations");
        const preMigrations = readdirSync(migrationsDir)
          .filter((name) => /^\d{14}_/.test(name) && name !== NEW_MIGRATION)
          .sort();
        expect(preMigrations.length).toBeGreaterThan(0);
        const preSql = preMigrations
          .map((name) => readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8"))
          .join("\n\n");
        runPrismaDbExecute(preSql, tempUrl);

        const newSql = readFileSync(
          path.resolve("prisma", "migrations", NEW_MIGRATION, "migration.sql"),
          "utf8",
        );
        // 显式 BEGIN/COMMIT 合同：升级路径同样在事务中完成
        expect(newSql).toContain("BEGIN;");
        expect(newSql).toContain("COMMIT;");
        runPrismaDbExecute(newSql, tempUrl);

        const tempClient = new PrismaClient({ datasources: { db: { url: tempUrl } }, log: ["error"] });
        try {
          expect(await tempClient.appeal.count()).toBe(0);
          expect(await tempClient.permission.findUnique({ where: { key: "appeal.review" } })).toBeTruthy();
        } finally {
          await tempClient.$disconnect();
        }
      } finally {
        await dropTempDatabase(tempDb);
      }
    }, 240_000);

    it("D-4 失败注入：事务回滚，零 partial state（Appeal 表 / permission / enum 值）", async () => {
      const tempDb = `campus_p6c1b_d4_${randomUUID().slice(0, 8)}`;
      const tempUrl = await createTempDatabase(tempDb);
      try {
        const migrationsDir = path.resolve("prisma", "migrations");
        const preMigrations = readdirSync(migrationsDir)
          .filter((name) => /^\d{14}_/.test(name) && name !== NEW_MIGRATION)
          .sort();
        const preSql = preMigrations
          .map((name) => readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8"))
          .join("\n\n");
        runPrismaDbExecute(preSql, tempUrl);

        // 失败注入：COMMIT 之前插入违反 FK 的语句
        // （updatedAt 显式提供——确保触发的是真正的 FK violation 而非 NOT NULL violation）
        const newSql = readFileSync(
          path.resolve("prisma", "migrations", NEW_MIGRATION, "migration.sql"),
          "utf8",
        );
        const injected = newSql.replace(
          "COMMIT;",
          `INSERT INTO "Appeal" ("id", "enforcementActionId", "statement", "updatedAt") VALUES ('d4-inject-fail', 'missing-ea', 'x', CURRENT_TIMESTAMP);\nCOMMIT;`,
        );
        expect(injected).not.toBe(newSql);

        let failed = false;
        let failureOutput = "";
        try {
          runPrismaDbExecute(injected, tempUrl);
        } catch (error) {
          failed = true;
          failureOutput = String(error);
        }
        expect(failed).toBe(true);
        // 真实 FK violation 证据：Prisma CLI 输出不含原始 SQLSTATE（23503），
        // 但给出精确约束名——断言命中的正是我们的 Appeal_enforcementActionId_fkey
        expect(failureOutput).toContain(
          'violates foreign key constraint "Appeal_enforcementActionId_fkey"',
        );

        // 零 partial state：Appeal 表 / permission / RolePermission / enum 值全部不存在
        const tempClient = new PrismaClient({ datasources: { db: { url: tempUrl } }, log: ["error"] });
        try {
          const appealTable = await tempClient.$queryRaw<{ exists: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'Appeal'
            ) AS exists`;
          expect(appealTable[0]!.exists).toBe(false);

          // 双侧转 text：目标值不存在时，text→enum 强转会在解析期报 22P02
          const enumValues = await tempClient.$queryRaw<{ present: boolean }[]>`
            SELECT 'APPEAL_GRANTED'::text = ANY(enum_range(NULL::"EnforcementReasonCode")::text[]) AS present`;
          expect(enumValues[0]!.present).toBe(false);

          const appealStatusType = await tempClient.$queryRaw<{ exists: boolean }[]>`
            SELECT to_regtype('"AppealStatus"') IS NOT NULL AS exists`;
          expect(appealStatusType[0]!.exists).toBe(false);

          const permission = await tempClient.permission.findUnique({ where: { key: "appeal.review" } });
          expect(permission).toBeNull();
        } finally {
          await tempClient.$disconnect();
        }
      } finally {
        await dropTempDatabase(tempDb);
      }
    }, 240_000);

    it("D-5 Prisma schema vs migrations drift = NONE（真实 diff 命令与输出）", async () => {
      const shadowDb = `campus_p6c1b_d5_${randomUUID().slice(0, 8)}`;
      const shadowUrl = await createTempDatabase(shadowDb);
      try {
        const output = runPrismaCli(
          [
            "migrate", "diff",
            "--from-migrations", "prisma/migrations",
            "--to-schema-datamodel", "prisma/schema.prisma",
            "--shadow-database-url", shadowUrl,
            "--script",
          ],
          integrationDatabaseUrl!,
        );
        expect(output).toContain("This is an empty migration");
      } finally {
        await dropTempDatabase(shadowDb);
      }
    }, 240_000);
  },
);
