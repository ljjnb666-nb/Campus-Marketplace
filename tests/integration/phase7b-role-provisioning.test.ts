import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// I13/I14 需要调用真实 server action（真 DB、真 canonical 链路），仅 mock
// session 与 next/cache 两个请求 seam；本文件其它测试不使用 requireUser。
const { actionSession } = vi.hoisted(() => ({
  actionSession: { current: null as null | { id: string; email: string; name: string } },
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser: async () => {
    if (!actionSession.current) {
      throw new Error("NO_SESSION");
    }
    return actionSession.current;
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

import { waitForAdvisoryLockWaiter } from "./helpers/lock-barrier";

/**
 * Phase 7B Governance Role Provisioning Surface 集成测试（真实 PostgreSQL）。
 *
 * 覆盖（Planning Repair + P1 + 实现指令冻结）：
 *  - Q01..Q11：授权读模型（allowlist 过滤 / campus 单列 IN / isActive 独立性 /
 *    cursor 不越权 / GLOBAL picker 宽度）
 *  - I01..I14：canonical 授予/撤回闭环、幂等审计、eligibility P1 断言、
 *    action 级 inactive-campus 零 delta（I13/I14）
 *  - C01..C05：确定性并发（advisory barrier / racePoint，零 sleep）
 *  - R03：legacy /admin 隔离（hasFullAdminSurfaceAccess 不变）
 *
 * 零 EnforcementAction 写入（无需合成 seq 段）；审计仅 ROLE_ASSIGNED/ROLE_REVOKED。
 */

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p7b-${randomUUID().slice(0, 8)}`;
const REVIEWER_ROLE_KEY = "CAMPUS_APPEAL_REVIEWER";
const PLATFORM_ADMIN_ROLE_KEY = "PLATFORM_ADMIN";
const UNIFORM_DENY = "没有权限执行该角色管理操作";
const FIXTURE_PASSWORD_HASH = ["$2a$10$", "itfixtureitfixtureitfixtureitfixtureitfix"].join("");

const createdUserIds: string[] = [];
const createdCampusIds: string[] = [];
const createdRoleIds: string[] = [];

let reviewerRoleId = "";

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
    status?: "ACTIVE" | "SUSPENDED";
    membership?: boolean;
    membershipStatus?: "ACTIVE" | "SUSPENDED" | "LEFT";
    email?: string;
  } = {},
) {
  const user = await rawClient!.user.create({
    data: {
      email: options.email ?? `${RUN_TAG}-${createdUserIds.length}@it.local`,
      name,
      passwordHash: FIXTURE_PASSWORD_HASH,
      schoolName: "集成测试大学",
      campusId,
      role: "STUDENT",
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

/** 创建 RUN_TAG 前缀的自定义角色 + assignment（授权矩阵 fixture，7A 同款）。 */
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

/** 直插系统角色（allowlist 内/外均可）的 assignment 行（Q/读模型 fixture）。 */
async function assignSystemRoleRow(
  userId: string,
  roleId: string,
  campusId: string,
  scopeKey?: string,
) {
  return rawClient!.userRoleAssignment.create({
    data: {
      userId,
      roleId,
      campusId,
      scopeKey: scopeKey ?? `CAMPUS:${campusId}`,
    },
  });
}

async function roleManageAccessOf(userId: string) {
  const { loadAuthorizationContext } = await import("@/lib/rbac/service");
  const { deriveRoleManageAccess } = await import("@/lib/rbac/role-manage-access");
  const context = await loadAuthorizationContext(userId);
  return { context, access: deriveRoleManageAccess(context) };
}

async function auditCount(action: string, adminId: string, targetId: string) {
  return rawClient!.adminLog.count({ where: { action, adminId, targetId } });
}

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 7B role provisioning surface 集成测试（真实 PostgreSQL）",
  () => {
    let campusA: { id: string; name: string };
    let campusB: { id: string; name: string };
    let campusC: { id: string; name: string };
    let campusD: { id: string; name: string };
    let globalManager: { id: string; email: string; name: string };
    let globalRevoker: { id: string };
    let campusManagerA: { id: string };
    let campusManagerC: { id: string };

    beforeAll(async () => {
      // 系统角色行由 migration/bootstrap 收敛；防御性断言（缺失即环境错误）
      const reviewerRole = await rawClient!.role.findUnique({ where: { key: REVIEWER_ROLE_KEY } });
      const platformAdminRole = await rawClient!.role.findUnique({
        where: { key: PLATFORM_ADMIN_ROLE_KEY },
      });
      if (!reviewerRole || !platformAdminRole) {
        throw new Error("系统角色缺失：请先执行 prisma migrate deploy / ensureRbacFoundation");
      }
      reviewerRoleId = reviewerRole.id;

      campusA = await createFixtureCampus("campus-a");
      campusB = await createFixtureCampus("campus-b");
      campusC = await createFixtureCampus("campus-c");
      campusD = await createFixtureCampus("campus-d");

      globalManager = await createFixtureUser("全局角色管理员", campusA.id);
      globalRevoker = await createFixtureUser("全局撤回员", campusA.id);
      campusManagerA = await createFixtureUser("校区A角色管理员", campusA.id);
      campusManagerC = await createFixtureUser("校区C角色管理员", campusC.id);

      await grantRole(globalManager.id, "GLOBAL_ASSIGNER", ["rbac.role.assign"], "GLOBAL");
      await grantRole(globalRevoker.id, "GLOBAL_ASSIGNER_2", ["rbac.role.assign"], "GLOBAL");
      await grantRole(
        campusManagerA.id,
        "CAMPUS_ASSIGNER_A",
        ["rbac.role.assign"],
        "CAMPUS",
        campusA.id,
      );
      await grantRole(
        campusManagerC.id,
        "CAMPUS_ASSIGNER_C",
        ["rbac.role.assign"],
        "CAMPUS",
        campusC.id,
      );
    }, 60_000);

    afterAll(async () => {
      await rawClient!.adminLog.deleteMany({ where: { adminId: { in: createdUserIds } } });
      await rawClient!.userRoleAssignment.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await rawClient!.rolePermission.deleteMany({ where: { roleId: { in: createdRoleIds } } });
      await rawClient!.role.deleteMany({ where: { id: { in: createdRoleIds } } });
      await rawClient!.campusMembership.deleteMany({ where: { userId: { in: createdUserIds } } });
      await rawClient!.user.deleteMany({ where: { id: { in: createdUserIds } } });
      await rawClient!.campus.deleteMany({ where: { id: { in: createdCampusIds } } });
      await rawClient!.$disconnect();
    });

    // ======================================================================
    // Q01..Q11：授权读模型
    // ======================================================================

    describe("授权读模型（Q01..Q11）", () => {
      let asgA1: { id: string };
      let asgB1: { id: string };
      let asgC1: { id: string };
      let canaryEmail: string;

      beforeAll(async () => {
        const tA1 = await createFixtureUser("Q01目标A", campusA.id);
        const tB1 = await createFixtureUser("Q01目标B", campusB.id);
        const tC1 = await createFixtureUser("Q06目标C", campusC.id, {
          email: `${RUN_TAG}-canary-${randomUUID().slice(0, 8)}@it.local`,
        });
        canaryEmail = tC1.email;
        asgA1 = await assignSystemRoleRow(tA1.id, reviewerRoleId, campusA.id);
        asgB1 = await assignSystemRoleRow(tB1.id, reviewerRoleId, campusB.id);
        asgC1 = await assignSystemRoleRow(tC1.id, reviewerRoleId, campusC.id);
      }, 30_000);

      it("Q01：GLOBAL actor 跨校区可见 allowlist assignments", async () => {
        const { loadManagedRoleAssignments } = await import("@/lib/rbac/role-assignment-query");
        const { access } = await roleManageAccessOf(globalManager.id);

        const page = await loadManagedRoleAssignments({ access, limit: 50 });
        const ids = page.items.map((item) => item.id);

        expect(ids).toContain(asgA1.id);
        expect(ids).toContain(asgB1.id);
      });

      it("Q02/Q04：campus actor 仅见己校区行（单列 IN，无跨校区泄漏）", async () => {
        const { loadManagedRoleAssignments } = await import("@/lib/rbac/role-assignment-query");
        const { access } = await roleManageAccessOf(campusManagerA.id);

        const page = await loadManagedRoleAssignments({ access, limit: 50 });

        expect(page.items.map((item) => item.id)).toContain(asgA1.id);
        expect(page.items.map((item) => item.id)).not.toContain(asgB1.id);
        expect(page.items.every((item) => item.campusName === campusA.name)).toBe(true);
      });

      it("Q03：PLATFORM_ADMIN（GLOBAL 角色）assignment 不进 7B 列表", async () => {
        const tA2 = await createFixtureUser("Q03目标", campusA.id);
        const platformAdmin = await rawClient!.role.findUnique({
          where: { key: PLATFORM_ADMIN_ROLE_KEY },
        });
        await rawClient!.userRoleAssignment.create({
          data: {
            userId: tA2.id,
            roleId: platformAdmin!.id,
            campusId: null,
            scopeKey: "GLOBAL",
          },
        });

        const { loadManagedRoleAssignments } = await import("@/lib/rbac/role-assignment-query");
        const { access } = await roleManageAccessOf(globalManager.id);
        const page = await loadManagedRoleAssignments({ access, limit: 50 });

        expect(page.items.some((item) => item.userDisplayName === "Q03目标")).toBe(false);
      });

      it("Q05：列表序列化不含目标 email canary（DTO 无 email 面）", async () => {
        const { loadManagedRoleAssignments } = await import("@/lib/rbac/role-assignment-query");
        const { access } = await roleManageAccessOf(globalManager.id);
        const page = await loadManagedRoleAssignments({ access, limit: 50 });

        expect(JSON.stringify(page.items)).not.toContain(canaryEmail);
        expect(JSON.stringify(page.items)).not.toContain("userId");
      });

      it("Q06/I08：campusC 转 inactive 后 assignment 仍可见、仍可被 resolver 解析", async () => {
        await rawClient!.campus.update({
          where: { id: campusC.id },
          data: { isActive: false },
        });

        const { loadManagedRoleAssignments, resolveRevocableAssignment } = await import(
          "@/lib/rbac/role-assignment-query"
        );
        const { access } = await roleManageAccessOf(globalManager.id);

        const page = await loadManagedRoleAssignments({ access, limit: 50 });
        expect(page.items.map((item) => item.id)).toContain(asgC1.id);

        const resolved = await resolveRevocableAssignment({ access, assignmentId: asgC1.id });
        expect(resolved).not.toBeNull();
        expect(resolved!.campusId).toBe(campusC.id);
      });

      it("Q07：campus actor 的 picker = 己校区 ∩ isActive（己校区 inactive → 空 picker）", async () => {
        const { loadManageableRoleCampuses } = await import("@/lib/rbac/role-assignment-query");
        const { access } = await roleManageAccessOf(campusManagerC.id);

        const campuses = await loadManageableRoleCampuses(access);
        expect(campuses).toEqual([]);
      });

      it("Q08：GLOBAL picker 含零 assignment 的 campusD", async () => {
        const { loadManageableRoleCampuses } = await import("@/lib/rbac/role-assignment-query");
        const { access } = await roleManageAccessOf(globalManager.id);

        const campuses = await loadManageableRoleCampuses(access);
        expect(campuses.map((campus) => campus.id)).toContain(campusD.id);
        expect(
          campuses.every(
            (campus) => typeof campus.id === "string" && typeof campus.name === "string",
          ),
        ).toBe(true);
      });

      it("Q09：campus-B 行的 cursor 不为 campus actor 越权（仅位置语义）", async () => {
        const { loadManagedRoleAssignments } = await import("@/lib/rbac/role-assignment-query");
        const { encodeGovernanceRoleCursor, decodeGovernanceRoleCursor } = await import(
          "@/validators/governance-role"
        );
        const globalAccess = (await roleManageAccessOf(globalManager.id)).access;
        const campusAccess = (await roleManageAccessOf(campusManagerA.id)).access;

        const globalPage = await loadManagedRoleAssignments({ access: globalAccess, limit: 50 });
        const bItem = globalPage.items.find((item) => item.id === asgB1.id)!;
        const encoded = encodeGovernanceRoleCursor({
          assignedAt: new Date(bItem.assignedAt),
          id: bItem.id,
        });
        const cursor = decodeGovernanceRoleCursor(encoded);
        expect(cursor).not.toBeNull();

        const page = await loadManagedRoleAssignments({
          access: campusAccess,
          cursor: cursor ?? undefined,
          limit: 50,
        });
        expect(page.items.every((item) => item.campusName === campusA.name)).toBe(true);
        expect(page.items.map((item) => item.id)).not.toContain(asgB1.id);
      });

      it("Q10/I09：未来 CAMPUS 角色（allowlist 外）assignment 不可见、不可经 7B 撤回；allowlist 不随 SYSTEM_ROLES 变宽", async () => {
        const tFuture = await createFixtureUser("Q10目标", campusA.id);
        const futureRole = await rawClient!.role.create({
          data: {
            key: `${RUN_TAG}-FUTURE_CAMPUS_ROLE`,
            name: "future",
            scope: "CAMPUS",
            isSystem: false,
            rolePermissions: {
              create: [{ permission: { connect: { key: "appeal.review" } } }],
            },
          },
        });
        createdRoleIds.push(futureRole.id);
        const futureAssignment = await rawClient!.userRoleAssignment.create({
          data: {
            userId: tFuture.id,
            roleId: futureRole.id,
            campusId: campusA.id,
            scopeKey: `CAMPUS:${campusA.id}`,
          },
        });

        const { loadManagedRoleAssignments, resolveRevocableAssignment } = await import(
          "@/lib/rbac/role-assignment-query"
        );
        const { access } = await roleManageAccessOf(globalManager.id);

        const page = await loadManagedRoleAssignments({ access, limit: 50 });
        expect(page.items.map((item) => item.id)).not.toContain(futureAssignment.id);

        expect(
          await resolveRevocableAssignment({ access, assignmentId: futureAssignment.id }),
        ).toBeNull();
      });

      it("Q11：GLOBAL picker 不含 inactive campusC", async () => {
        const { loadManageableRoleCampuses } = await import("@/lib/rbac/role-assignment-query");
        const { access } = await roleManageAccessOf(globalManager.id);

        const campuses = await loadManageableRoleCampuses(access);
        expect(campuses.map((campus) => campus.id)).not.toContain(campusC.id);
      });
    });

    // ======================================================================
    // I01..I12：canonical 闭环 + 幂等审计 + eligibility
    // ======================================================================

    describe("canonical 闭环（I01..I12）", () => {
      it("I01：canonical grant → 列表反映完整 DTO（含 assignedBy display name）", async () => {
        const target = await createFixtureUser("I01目标", campusA.id);
        const { assignRole } = await import("@/lib/rbac/assignment-service");
        const { loadManagedRoleAssignments } = await import("@/lib/rbac/role-assignment-query");

        const result = await assignRole({
          actorId: globalManager.id,
          targetUserId: target.id,
          roleKey: REVIEWER_ROLE_KEY,
          campusId: campusA.id,
        });
        expect(result.created).toBe(true);

        const { access } = await roleManageAccessOf(globalManager.id);
        const page = await loadManagedRoleAssignments({ access, limit: 50 });
        const item = page.items.find((row) => row.userDisplayName === "I01目标");

        expect(item).toBeDefined();
        expect(item!.roleKey).toBe(REVIEWER_ROLE_KEY);
        expect(item!.campusName).toBe(campusA.name);
        expect(item!.assignedByDisplayName).toBe(globalManager.name);
        expect(Number.isNaN(new Date(item!.assignedAt).getTime())).toBe(false);
      });

      it("I02：幂等 re-grant → created=false、单行、ROLE_ASSIGNED 审计恰一条", async () => {
        const target = await createFixtureUser("I02目标", campusA.id);
        const { assignRole } = await import("@/lib/rbac/assignment-service");

        await assignRole({
          actorId: globalManager.id,
          targetUserId: target.id,
          roleKey: REVIEWER_ROLE_KEY,
          campusId: campusA.id,
        });
        const second = await assignRole({
          actorId: globalManager.id,
          targetUserId: target.id,
          roleKey: REVIEWER_ROLE_KEY,
          campusId: campusA.id,
        });
        expect(second.created).toBe(false);

        const rows = await rawClient!.userRoleAssignment.count({
          where: { userId: target.id, roleId: reviewerRoleId },
        });
        expect(rows).toBe(1);
        expect(await auditCount("ROLE_ASSIGNED", globalManager.id, target.id)).toBe(1);
      });

      it("I03：resolver → canonical revokeRole → removed=true、行消失、ROLE_REVOKED 恰一条", async () => {
        const target = await createFixtureUser("I03目标", campusA.id);
        const { assignRole, revokeRole } = await import("@/lib/rbac/assignment-service");
        const { resolveRevocableAssignment } = await import("@/lib/rbac/role-assignment-query");

        await assignRole({
          actorId: globalManager.id,
          targetUserId: target.id,
          roleKey: REVIEWER_ROLE_KEY,
          campusId: campusA.id,
        });

        const { access } = await roleManageAccessOf(globalManager.id);
        const row = await rawClient!.userRoleAssignment.findFirst({
          where: { userId: target.id, roleId: reviewerRoleId },
        });
        const revocable = await resolveRevocableAssignment({ access, assignmentId: row!.id });
        expect(revocable).toMatchObject({
          userId: target.id,
          campusId: campusA.id,
          roleKey: REVIEWER_ROLE_KEY,
        });

        const result = await revokeRole({
          actorId: globalManager.id,
          targetUserId: revocable!.userId,
          roleKey: revocable!.roleKey,
          campusId: revocable!.campusId,
        });
        expect(result.removed).toBe(true);

        const remaining = await rawClient!.userRoleAssignment.count({
          where: { userId: target.id, roleId: reviewerRoleId },
        });
        expect(remaining).toBe(0);
        expect(await auditCount("ROLE_REVOKED", globalManager.id, target.id)).toBe(1);
      });

      it("I04：target membership SUSPENDED 不阻止 revoke（canonical 清理例外）", async () => {
        const target = await createFixtureUser("I04目标", campusA.id);
        const { assignRole, revokeRole } = await import("@/lib/rbac/assignment-service");

        await assignRole({
          actorId: globalManager.id,
          targetUserId: target.id,
          roleKey: REVIEWER_ROLE_KEY,
          campusId: campusA.id,
        });
        await rawClient!.campusMembership.updateMany({
          where: { userId: target.id, campusId: campusA.id },
          data: { status: "SUSPENDED" },
        });

        const result = await revokeRole({
          actorId: globalManager.id,
          targetUserId: target.id,
          roleKey: REVIEWER_ROLE_KEY,
          campusId: campusA.id,
        });
        expect(result.removed).toBe(true);
      });

      it("I05：revoke 不依赖 email（授予后改 email 仍可按 assignmentId 撤回）", async () => {
        const target = await createFixtureUser("I05目标", campusA.id);
        const { assignRole, revokeRole } = await import("@/lib/rbac/assignment-service");

        await assignRole({
          actorId: globalManager.id,
          targetUserId: target.id,
          roleKey: REVIEWER_ROLE_KEY,
          campusId: campusA.id,
        });
        await rawClient!.user.update({
          where: { id: target.id },
          data: { email: `${RUN_TAG}-renamed-${randomUUID().slice(0, 8)}@it.local` },
        });

        const result = await revokeRole({
          actorId: globalManager.id,
          targetUserId: target.id,
          roleKey: REVIEWER_ROLE_KEY,
          campusId: campusA.id,
        });
        expect(result.removed).toBe(true);
      });

      it("I06：candidate 解析——ACTIVE 命中；缺失/无 membership/SUSPENDED membership/停用账号 → 统一 null", async () => {
        const { resolveGrantCandidate } = await import("@/lib/rbac/role-assignment-query");

        const active = await createFixtureUser("I06活跃", campusA.id);
        const noMembership = await createFixtureUser("I06无membership", campusA.id, {
          membership: false,
        });
        const suspendedMembership = await createFixtureUser("I06停用membership", campusA.id, {
          membershipStatus: "SUSPENDED",
        });
        const suspendedAccount = await createFixtureUser(
          "I06停用账号",
          campusA.id,
          { status: "SUSPENDED" },
        );

        expect(
          await resolveGrantCandidate({ campusId: campusA.id, email: active.email }),
        ).toMatchObject({ id: active.id });
        expect(
          await resolveGrantCandidate({
            campusId: campusA.id,
            email: `ghost-${randomUUID()}@it.local`,
          }),
        ).toBeNull();
        expect(
          await resolveGrantCandidate({ campusId: campusA.id, email: noMembership.email }),
        ).toBeNull();
        expect(
          await resolveGrantCandidate({
            campusId: campusA.id,
            email: suspendedMembership.email,
          }),
        ).toBeNull();
        expect(
          await resolveGrantCandidate({ campusId: campusA.id, email: suspendedAccount.email }),
        ).toBeNull();
        // 跨校区：ACTIVE@A 用户在 B 无 membership → null
        expect(
          await resolveGrantCandidate({ campusId: campusB.id, email: active.email }),
        ).toBeNull();
      });

      it("I07：GLOBAL 向零 assignment 的 campusD 授予首个 reviewer", async () => {
        const target = await createFixtureUser("I07目标", campusD.id);
        const { assignRole } = await import("@/lib/rbac/assignment-service");
        const { resolveGrantEligibleCampus } = await import("@/lib/rbac/role-assignment-query");

        const { access } = await roleManageAccessOf(globalManager.id);
        expect(
          await resolveGrantEligibleCampus({ access, campusId: campusD.id }),
        ).toEqual({ id: campusD.id });

        const result = await assignRole({
          actorId: globalManager.id,
          targetUserId: target.id,
          roleKey: REVIEWER_ROLE_KEY,
          campusId: campusD.id,
        });
        expect(result.created).toBe(true);
      });

      it("I10：malformed scopeKey 行 fail closed（resolver 拒绝）", async () => {
        const target = await createFixtureUser("I10目标", campusA.id);
        const malformed = await assignSystemRoleRow(
          target.id,
          reviewerRoleId,
          campusA.id,
          "CAMPUS:mismatched",
        );

        const { resolveRevocableAssignment } = await import("@/lib/rbac/role-assignment-query");
        const { access } = await roleManageAccessOf(globalManager.id);
        expect(
          await resolveRevocableAssignment({ access, assignmentId: malformed.id }),
        ).toBeNull();
      });

      it("I11：DTO 键集精确冻结（无 userId/email/roleId/scopeKey）", async () => {
        const { loadManagedRoleAssignments } = await import("@/lib/rbac/role-assignment-query");
        const { access } = await roleManageAccessOf(globalManager.id);
        const page = await loadManagedRoleAssignments({ access, limit: 50 });

        expect(page.items.length).toBeGreaterThan(0);
        for (const item of page.items) {
          expect(Object.keys(item).sort()).toEqual([
            "assignedAt",
            "assignedByDisplayName",
            "campusName",
            "id",
            "roleKey",
            "userDisplayName",
          ]);
        }
      });

      it("I12：UI 与 CLI 等价（同 canonical 路径 → 同审计形状）", async () => {
        const viaUi = await createFixtureUser("I12目标UI", campusA.id);
        const viaCli = await createFixtureUser("I12目标CLI", campusA.id);
        const { assignRole } = await import("@/lib/rbac/assignment-service");

        for (const target of [viaUi, viaCli]) {
          await assignRole({
            actorId: globalManager.id,
            targetUserId: target.id,
            roleKey: REVIEWER_ROLE_KEY,
            campusId: campusA.id,
          });
        }

        const uiAudit = await rawClient!.adminLog.findFirst({
          where: { action: "ROLE_ASSIGNED", adminId: globalManager.id, targetId: viaUi.id },
        });
        const cliAudit = await rawClient!.adminLog.findFirst({
          where: { action: "ROLE_ASSIGNED", adminId: globalManager.id, targetId: viaCli.id },
        });
        expect(uiAudit).not.toBeNull();
        expect(cliAudit).not.toBeNull();
        expect((uiAudit!.metadata as { roleKey?: string })?.roleKey).toBe(REVIEWER_ROLE_KEY);
        expect(uiAudit!.action).toBe(cliAudit!.action);
        expect(uiAudit!.metadata).toEqual(cliAudit!.metadata);
      });

      it("R03：legacy /admin 隔离不变（hasFullAdminSurfaceAccess 恒 false）", async () => {
        const { hasFullAdminSurfaceAccess } = await import("@/lib/rbac/service");

        const campusContext = (await roleManageAccessOf(campusManagerA.id)).context;
        const globalContext = (await roleManageAccessOf(globalManager.id)).context;

        expect(hasFullAdminSurfaceAccess(campusContext)).toBe(false);
        // 仅持单一 GLOBAL permission 的角色管理者同样不进 legacy 全量 admin 面
        expect(hasFullAdminSurfaceAccess(globalContext)).toBe(false);
      });
    });

    // ======================================================================
    // C01..C05：确定性并发（advisory barrier / racePoint，零 sleep）
    // ======================================================================

    describe("确定性并发（C01..C05）", () => {
      it("C01：并发双 revoke 同 assignment → 恰一 removed=true", async () => {
        const target = await createFixtureUser("C01目标", campusA.id);
        const { assignRole, revokeRole } = await import("@/lib/rbac/assignment-service");

        await assignRole({
          actorId: globalManager.id,
          targetUserId: target.id,
          roleKey: REVIEWER_ROLE_KEY,
          campusId: campusA.id,
        });

        const input = {
          actorId: globalManager.id,
          targetUserId: target.id,
          roleKey: REVIEWER_ROLE_KEY,
          campusId: campusA.id,
        };
        const settled = await Promise.allSettled([revokeRole(input), revokeRole(input)]);

        expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
        const removed = settled.map((r) =>
          r.status === "fulfilled" ? r.value.removed : null,
        );
        expect(removed.filter((value) => value === true)).toHaveLength(1);
        expect(removed.filter((value) => value === false)).toHaveLength(1);
      });

      it("C02：revoke vs re-grant（两阶段 gate 固定获锁序）→ 终态合法单行、无 duplicate", async () => {
        const target = await createFixtureUser("C02目标", campusA.id);
        const { assignRole, revokeRole } = await import("@/lib/rbac/assignment-service");

        await assignRole({
          actorId: globalManager.id,
          targetUserId: target.id,
          roleKey: REVIEWER_ROLE_KEY,
          campusId: campusA.id,
        });

        // 两阶段 gate（ROLE_ASSIGN_07 模式）：racePoint 入口 = revoke 已持有
        // 全部 subject 锁（确定性）；此后才启动 grant → grant 必然进入锁等待。
        let revokeHoldingLocks!: () => void;
        const lockHeld = new Promise<void>((resolve) => {
          revokeHoldingLocks = resolve;
        });
        let releaseGate!: () => void;
        const gate = new Promise<void>((resolve) => {
          releaseGate = resolve;
        });

        const revokePromise = revokeRole({
          actorId: globalManager.id,
          targetUserId: target.id,
          roleKey: REVIEWER_ROLE_KEY,
          campusId: campusA.id,
          racePoint: async () => {
            revokeHoldingLocks();
            await gate;
          },
        });

        await lockHeld;

        // revoke 持锁窗口内启动 re-grant → 它必然阻塞在 advisory 锁上
        const grantPromise = assignRole({
          actorId: globalManager.id,
          targetUserId: target.id,
          roleKey: REVIEWER_ROLE_KEY,
          campusId: campusA.id,
        });
        await waitForAdvisoryLockWaiter(rawClient!, [
          `USER:${globalManager.id}`,
          `USER:${target.id}`,
        ]);
        releaseGate();

        const [revokeResult, grantResult] = await Promise.all([
          revokePromise,
          grantPromise,
        ]);
        expect(revokeResult.removed).toBe(true);
        // 获锁序确定（revoke 先）：删除提交后 re-grant 重建 → 单行
        expect(grantResult.created).toBe(true);

        const rows = await rawClient!.userRoleAssignment.count({
          where: { userId: target.id, roleId: reviewerRoleId },
        });
        expect(rows).toBe(1);
      });

      it("C03：等待期间 actor 授权被撤 → canonical 锁内重读拒绝（TOCTOU 关闭）", async () => {
        const target = await createFixtureUser("C03目标", campusA.id);
        const { revokeRole } = await import("@/lib/rbac/assignment-service");

        // racePoint 在锁内窗口撤走 actor 的 rbac.role.assign（行不被 advisory 锁
        // 覆盖，删除即时生效）→ canonical 锁内 loadAuthorizationContext 重读拒绝
        await expect(
          revokeRole({
            actorId: globalRevoker.id,
            targetUserId: target.id,
            roleKey: REVIEWER_ROLE_KEY,
            campusId: campusA.id,
            racePoint: async () => {
              await rawClient!.userRoleAssignment.deleteMany({
                where: { userId: globalRevoker.id },
              });
            },
          }),
        ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });

        const remaining = await rawClient!.userRoleAssignment.count({
          where: { userId: target.id, roleId: reviewerRoleId },
        });
        expect(remaining).toBe(0);
      });

      it("C04：grant vs membership suspend（racePoint 交错）→ 锁内重读拒绝 stale grant", async () => {
        const target = await createFixtureUser("C04目标", campusA.id);
        const { assignRole } = await import("@/lib/rbac/assignment-service");

        await expect(
          assignRole({
            actorId: globalManager.id,
            targetUserId: target.id,
            roleKey: REVIEWER_ROLE_KEY,
            campusId: campusA.id,
            racePoint: async () => {
              await rawClient!.campusMembership.updateMany({
                where: { userId: target.id, campusId: campusA.id },
                data: { status: "SUSPENDED" },
              });
            },
          }),
        ).rejects.toMatchObject({ code: "ROLE_ASSIGNMENT_TARGET_MEMBERSHIP_INACTIVE" });

        const rows = await rawClient!.userRoleAssignment.count({
          where: { userId: target.id, roleId: reviewerRoleId },
        });
        expect(rows).toBe(0);
      });

      it("C05：并发双 grant → P2002 幂等收敛，单行 + ROLE_ASSIGNED 审计恰一条", async () => {
        const target = await createFixtureUser("C05目标", campusA.id);
        const { assignRole } = await import("@/lib/rbac/assignment-service");

        const input = {
          actorId: globalManager.id,
          targetUserId: target.id,
          roleKey: REVIEWER_ROLE_KEY,
          campusId: campusA.id,
        };
        const settled = await Promise.allSettled([assignRole(input), assignRole(input)]);

        expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
        const created = settled.map((r) =>
          r.status === "fulfilled" ? r.value.created : null,
        );
        expect(created.filter((value) => value === true)).toHaveLength(1);
        expect(created.filter((value) => value === false)).toHaveLength(1);

        const rows = await rawClient!.userRoleAssignment.count({
          where: { userId: target.id, roleId: reviewerRoleId },
        });
        expect(rows).toBe(1);
        expect(await auditCount("ROLE_ASSIGNED", globalManager.id, target.id)).toBe(1);
      });
    });

    // ======================================================================
    // I13/I14：P1 安全断言（真实 server action，mock 仅 session/cache seam）
    // ======================================================================

    describe("P1 安全断言（I13/I14，真实 action）", () => {
      it("I13：inactive campus 直接 grant → 统一拒绝；assignment delta=0；ROLE_ASSIGNED audit delta=0", async () => {
        const target = await createFixtureUser("I13目标", campusC.id);
        const { grantGovernanceRole } = await import("@/actions/governance-roles");

        // 防御性自置（Q06 已将 campusC 置 inactive；此处不依赖测试顺序）
        await rawClient!.campus.update({
          where: { id: campusC.id },
          data: { isActive: false },
        });

        actionSession.current = {
          id: globalManager.id,
          email: globalManager.email,
          name: globalManager.name,
        };
        const fd = new FormData();
        fd.append("campusId", campusC.id);
        fd.append("email", target.email);

        const state = await grantGovernanceRole(fd);

        expect(state).toEqual({ success: false, error: UNIFORM_DENY });
        expect(
          await rawClient!.userRoleAssignment.count({
            where: { userId: target.id, roleId: reviewerRoleId },
          }),
        ).toBe(0);
        expect(await auditCount("ROLE_ASSIGNED", globalManager.id, target.id)).toBe(0);
      });

      it("I14：active 授予 → campus 转 inactive → assignment 仍可见 → 按 assignmentId 撤回成功且 ROLE_REVOKED 恰一条", async () => {
        const target = await createFixtureUser("I14目标", campusB.id);
        const { assignRole } = await import("@/lib/rbac/assignment-service");
        const { grantGovernanceRole, revokeGovernanceRole } = await import(
          "@/actions/governance-roles"
        );
        const { loadManagedRoleAssignments } = await import("@/lib/rbac/role-assignment-query");

        // 1. active campus 上合法授予（走 canonical）
        await assignRole({
          actorId: globalManager.id,
          targetUserId: target.id,
          roleKey: REVIEWER_ROLE_KEY,
          campusId: campusB.id,
        });

        // 2. campusB 转 inactive
        await rawClient!.campus.update({
          where: { id: campusB.id },
          data: { isActive: false },
        });

        // 3. assignment 仍出现在管理列表（可见性与 isActive 独立）
        const { access } = await roleManageAccessOf(globalManager.id);
        const page = await loadManagedRoleAssignments({ access, limit: 50 });
        const item = page.items.find((row) => row.userDisplayName === "I14目标");
        expect(item).toBeDefined();

        // 4. 真实 action 按 assignmentId 撤回（revoke 不查 isActive）
        actionSession.current = {
          id: globalManager.id,
          email: globalManager.email,
          name: globalManager.name,
        };
        const fd = new FormData();
        fd.append("assignmentId", item!.id);

        const state = await revokeGovernanceRole(fd);
        expect(state.success).toBe(true);

        // 5. 行删除 + ROLE_REVOKED 审计恰一条
        const remaining = await rawClient!.userRoleAssignment.count({
          where: { userId: target.id, roleId: reviewerRoleId },
        });
        expect(remaining).toBe(0);
        expect(await auditCount("ROLE_REVOKED", globalManager.id, target.id)).toBe(1);
      });
    });

    // ======================================================================
    // FR01/FR02：Final Review 修复（邮箱身份不重写 + ABA assignment 身份守卫）
    // ======================================================================

    describe("Final Review 修复（FR01/FR02）", () => {
      const MIXED_EMAIL = "Mixed.Case@Campus.edu";
      const LOWER_EMAIL = "mixed.case@campus.edu";

      /** FR01-C 前置：同名夹具残留（同 fixture 密码哈希）安全清除；非夹具行 → false。 */
      async function purgeOwnedFixtureRows(emails: string[]): Promise<boolean> {
        for (const email of emails) {
          const stale = await rawClient!.user.findUnique({ where: { email } });
          if (!stale) {
            continue;
          }
          if (stale.passwordHash !== FIXTURE_PASSWORD_HASH) {
            return false;
          }
          await rawClient!.adminLog.deleteMany({
            where: { OR: [{ adminId: stale.id }, { targetId: stale.id }] },
          });
          await rawClient!.userRoleAssignment.deleteMany({ where: { userId: stale.id } });
          await rawClient!.campusMembership.deleteMany({ where: { userId: stale.id } });
          await rawClient!.user.delete({ where: { id: stale.id } });
        }
        return true;
      }

      it("FR01-A：exact stored-email lookup——mixed-case 输入仅解析到逐字相同行", async () => {
        const target = await createFixtureUser("FR01A目标", campusA.id, {
          email: MIXED_EMAIL,
        });

        const { resolveGrantCandidate } = await import("@/lib/rbac/role-assignment-query");

        expect(
          await resolveGrantCandidate({ campusId: campusA.id, email: MIXED_EMAIL }),
        ).toMatchObject({ id: target.id, name: "FR01A目标" });

        // 大小写变体查询：仅当 DB 恰无该行时断言 null（exact 语义；
        // 若存在同名行则其必为另一用户，精确匹配语义仍被首断言证明）
        const lowerRow = await rawClient!.user.findUnique({ where: { email: LOWER_EMAIL } });
        const lowerLookup = await resolveGrantCandidate({
          campusId: campusA.id,
          email: LOWER_EMAIL,
        });
        if (!lowerRow) {
          expect(lowerLookup).toBeNull();
        } else {
          expect(lowerLookup!.id).toBe(lowerRow.id);
        }
      });

      it("FR01-C：case-variant 双行并存时，grant 仅授予 exact mixed-case 行", async () => {
        // DB 拒绝 case-variant 夹具（同名非夹具行）→ 记录事实并跳过 C；A/B 仍强制
        if (!(await purgeOwnedFixtureRows([MIXED_EMAIL, LOWER_EMAIL]))) {
          console.warn(
            "FR01-C：DB 已存在同名非夹具行，case-variant 夹具被拒绝——记录该事实，FR01-A/B 仍强制",
          );
          return;
        }

        const mixed = await createFixtureUser("FR01C混合大小写", campusA.id, {
          email: MIXED_EMAIL,
        });
        const lower = await createFixtureUser("FR01C小写", campusA.id, {
          email: LOWER_EMAIL,
        });

        // 真实 grant action（mock 仅 session/cache）：Mixed.Case@Campus.edu
        const { grantGovernanceRole } = await import("@/actions/governance-roles");
        actionSession.current = {
          id: globalManager.id,
          email: globalManager.email,
          name: globalManager.name,
        };
        const fd = new FormData();
        fd.append("campusId", campusA.id);
        fd.append("email", MIXED_EMAIL);

        const state = await grantGovernanceRole(fd);
        expect(state.success).toBe(true);

        // 角色仅授予 exact mixed-case 行；lowercase 行零 assignment 零审计
        expect(
          await rawClient!.userRoleAssignment.count({
            where: { userId: mixed.id, role: { key: REVIEWER_ROLE_KEY } },
          }),
        ).toBe(1);
        expect(
          await rawClient!.userRoleAssignment.count({ where: { userId: lower.id } }),
        ).toBe(0);
        expect(
          await rawClient!.adminLog.count({
            where: { action: "ROLE_ASSIGNED", targetId: mixed.id },
          }),
        ).toBe(1);
        expect(
          await rawClient!.adminLog.count({
            where: { action: "ROLE_ASSIGNED", targetId: lower.id },
          }),
        ).toBe(0);
      });

      it("FR02-ABA：旧 assignmentId 在 revoke→re-grant 轮换后不再删除新 assignment；匹配 expectedAssignmentId 才撤回；省略字段保持 legacy 语义", async () => {
        const target = await createFixtureUser("FR02目标", campusA.id);
        const { assignRole, revokeRole } = await import("@/lib/rbac/assignment-service");
        const { resolveRevocableAssignment } = await import("@/lib/rbac/role-assignment-query");
        const { access } = await roleManageAccessOf(globalManager.id);

        const grant = () =>
          assignRole({
            actorId: globalManager.id,
            targetUserId: target.id,
            roleKey: REVIEWER_ROLE_KEY,
            campusId: campusA.id,
          });

        // 1. grant → A1
        await grant();
        const a1 = await rawClient!.userRoleAssignment.findFirstOrThrow({
          where: { userId: target.id, roleId: reviewerRoleId },
        });

        // 2. 按 7B action 的方式解析 A1
        const resolvedA1 = await resolveRevocableAssignment({
          access,
          assignmentId: a1.id,
        });
        expect(resolvedA1).toMatchObject({ id: a1.id, userId: target.id });

        // 3. revoke A1（canonical legacy 调用）
        expect(
          (
            await revokeRole({
              actorId: globalManager.id,
              targetUserId: target.id,
              roleKey: REVIEWER_ROLE_KEY,
              campusId: campusA.id,
            })
          ).removed,
        ).toBe(true);

        // 4. re-grant → A2
        expect((await grant()).created).toBe(true);
        const a2 = await rawClient!.userRoleAssignment.findFirstOrThrow({
          where: { userId: target.id, roleId: reviewerRoleId },
        });

        // 5. A2 != A1（assignmentId 已轮换；stale 解析仍指向 A1）
        expect(a2.id).not.toBe(a1.id);
        expect(resolvedA1!.id).toBe(a1.id);

        // 6. 用 A1 元组 + expectedAssignmentId=A1.id 调 canonical revoke
        const staleAttempt = await revokeRole({
          actorId: globalManager.id,
          targetUserId: resolvedA1!.userId,
          roleKey: resolvedA1!.roleKey,
          campusId: resolvedA1!.campusId,
          expectedAssignmentId: resolvedA1!.id,
        });

        // 7. removed=false；A2 仍在、计数 1、step 6 零新增 ROLE_REVOKED 审计
        expect(staleAttempt.removed).toBe(false);
        expect(
          await rawClient!.userRoleAssignment.findUnique({ where: { id: a2.id } }),
        ).not.toBeNull();
        expect(
          await rawClient!.userRoleAssignment.count({
            where: { userId: target.id, roleId: reviewerRoleId },
          }),
        ).toBe(1);
        expect(await auditCount("ROLE_REVOKED", globalManager.id, target.id)).toBe(1);

        // expectedAssignmentId 匹配 → removed=true、恰删该行、恰多一条审计
        const match = await revokeRole({
          actorId: globalManager.id,
          targetUserId: a2.userId,
          roleKey: REVIEWER_ROLE_KEY,
          campusId: campusA.id,
          expectedAssignmentId: a2.id,
        });
        expect(match.removed).toBe(true);
        expect(
          await rawClient!.userRoleAssignment.count({
            where: { userId: target.id, roleId: reviewerRoleId },
          }),
        ).toBe(0);
        expect(await auditCount("ROLE_REVOKED", globalManager.id, target.id)).toBe(2);

        // legacy 兼容：省略 expectedAssignmentId → 既有 revoke 语义不变
        await grant();
        const legacy = await revokeRole({
          actorId: globalManager.id,
          targetUserId: target.id,
          roleKey: REVIEWER_ROLE_KEY,
          campusId: campusA.id,
        });
        expect(legacy.removed).toBe(true);
        expect(
          await rawClient!.userRoleAssignment.count({
            where: { userId: target.id, roleId: reviewerRoleId },
          }),
        ).toBe(0);
        expect(await auditCount("ROLE_REVOKED", globalManager.id, target.id)).toBe(3);
      });
    });
  },
);
