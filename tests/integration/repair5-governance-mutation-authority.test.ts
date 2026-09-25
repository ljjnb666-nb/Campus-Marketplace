import { randomUUID } from "node:crypto";
import { waitForAdvisoryLockWaiter } from "./helpers/lock-barrier";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * RB-05 Governance Mutation Authority 集成测试（真实 PostgreSQL）。
 *
 * 在生产 canonical 服务路径（真实 withTransaction + USER 治理 advisory 锁 +
 * loadAuthorizationContext 锁内 fresh 复核 + same-tx recordAdminAudit）上证明：
 *
 *  - CATEGORY-RACE-01 revoke wins：T1 entry auth 后、取锁前挂起（beforeLock
 *    seam）→ T2 生产 revokeRole 撤回 targetAdmin 的 PLATFORM_ADMIN 并提交 →
 *    T1 恢复后锁内 fresh 复核失败（AUTH_PERMISSION_DENIED）→ 分类零变更、
 *    零新增分类审计。
 *  - CATEGORY-RACE-02 mutation wins：T1 持 USER 锁、fresh category.manage
 *    通过后挂起（afterCheck seam）→ T2 revokeRole 真实进入锁等待队列
 *    （pg_locks barrier，零 sleep）→ T1 域写 + 审计同事务提交 → T2 随后完成
 *    ——mutation 与 revoke 严格线性化，审计恰一条。
 *  - KEYWORD-RACE-01：同 RACE-01，域 = ModerationKeyword，fresh permission =
 *    moderation.keyword.manage；cache reset 不调用的证明在 action/unit seam
 *    （admin.test.ts RB-05 用例）。
 *  - CATEGORY/KEYWORD-ATOMIC-01：beforeAudit seam 注入确定性错误 → 整体回滚
 *    ——域写与审计写同一事务，无审计不提交。
 *
 * revokeRole 为生产路径（不 mock 锁、不 mock 授权）。
 */

vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const prisma = integrationDatabaseUrl ? (await import("@/lib/prisma")).prisma : null;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `rb05it-${randomUUID().slice(0, 8)}`;
const RB05_CAMPUS_SLUG = "rb05-governance-mutation-it";
const PLATFORM_ADMIN_ROLE_KEY = "PLATFORM_ADMIN";

describe.skipIf(!integrationDatabaseUrl)("governance mutation authority (RB-05, real PostgreSQL)", () => {
  let campusId = "";
  let platformAdminRoleId = "";
  let categoryId = "";
  let categorySlug = "";
  let keywordId = "";
  const userIds: string[] = [];
  const assignmentIds: string[] = [];
  const adHocRoleIds: string[] = [];

  async function createFixtureUser(name: string) {
    const user = await rawClient!.user.create({
      data: {
        email: `${RUN_TAG}-${userIds.length}-${name}@it.local`,
        name,
        passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
        schoolName: "集成测试大学",
        campusId,
        role: "STUDENT",
        status: "ACTIVE",
      },
    });
    userIds.push(user.id);
    await rawClient!.campusMembership.create({
      data: { userId: user.id, campusId, status: "ACTIVE" },
    });
    return user;
  }

  /** targetAdmin：ACTIVE + PLATFORM_ADMIN assignment（含 category/keyword 权限）。 */
  async function createCategoryAdmin(name: string) {
    const admin = await createFixtureUser(name);
    const assignment = await rawClient!.userRoleAssignment.create({
      data: { userId: admin.id, roleId: platformAdminRoleId, campusId: null, scopeKey: "GLOBAL" },
    });
    assignmentIds.push(assignment.id);
    return admin;
  }

  /** 合法撤销者：GLOBAL rbac.role.assign（生产 revokeRole 合同）。 */
  async function createRoleRevoker(name: string) {
    const revoker = await createFixtureUser(name);
    const role = await rawClient!.role.create({
      data: {
        key: `${RUN_TAG}_REVOKER_${adHocRoleIds.length}`,
        name: `${RUN_TAG}_REVOKER_${adHocRoleIds.length}`,
        scope: "GLOBAL",
        isSystem: false,
        rolePermissions: {
          create: [{ permission: { connect: { key: "rbac.role.assign" } } }],
        },
      },
    });
    adHocRoleIds.push(role.id);
    const assignment = await rawClient!.userRoleAssignment.create({
      data: { userId: revoker.id, roleId: role.id, campusId: null, scopeKey: "GLOBAL" },
    });
    assignmentIds.push(assignment.id);
    return revoker;
  }

  beforeAll(async () => {
    const campus = await rawClient!.campus.upsert({
      where: { slug: RB05_CAMPUS_SLUG },
      create: { name: "RB05 集成校区", slug: RB05_CAMPUS_SLUG, schoolName: "集成测试大学" },
      update: {},
    });
    campusId = campus.id;

    // 系统角色行由 migration/bootstrap 收敛；缺失即环境错误
    const platformAdminRole = await rawClient!.role.findUnique({
      where: { key: PLATFORM_ADMIN_ROLE_KEY },
    });
    if (!platformAdminRole) {
      throw new Error("系统角色缺失：请先执行 prisma migrate deploy / ensureRbacFoundation");
    }
    platformAdminRoleId = platformAdminRole.id;

    categorySlug = `${RUN_TAG}-product`;
    const category = await rawClient!.productCategory.create({
      data: { name: `${RUN_TAG} 原始分类`, slug: categorySlug, sortOrder: 1, isActive: true },
    });
    categoryId = category.id;

    const keyword = await rawClient!.moderationKeyword.create({
      data: { keyword: `${RUN_TAG}-敏感词`, targetType: "GLOBAL", isEnabled: true },
    });
    keywordId = keyword.id;
  });

  afterAll(async () => {
    await rawClient!.userRoleAssignment.deleteMany({ where: { id: { in: assignmentIds } } });
    await rawClient!.rolePermission.deleteMany({ where: { roleId: { in: adHocRoleIds } } });
    await rawClient!.role.deleteMany({ where: { id: { in: adHocRoleIds } } });
    await rawClient!.adminLog.deleteMany({ where: { adminId: { in: userIds } } });
    await rawClient!.moderationKeyword.deleteMany({ where: { id: keywordId } });
    await rawClient!.productCategory.deleteMany({ where: { id: categoryId } });
    await rawClient!.campusMembership.deleteMany({ where: { userId: { in: userIds } } });
    await rawClient!.user.deleteMany({ where: { id: { in: userIds } } });
    // 不删除 Campus 行（稳定 slug 复用）
    await rawClient!.$disconnect();
    await prisma?.$disconnect();
  });

  it("CATEGORY-RACE-01 revoke wins：revoke 先提交 → stale 分类 mutation 锁内被拒，零写入零审计", async () => {
    const { upsertCategoryInGovernance } = await import(
      "@/lib/governance/admin-configuration-service"
    );
    const { revokeRole } = await import("@/lib/rbac/assignment-service");

    const targetAdmin = await createCategoryAdmin("RB05 分类管理员A");
    const revoker = await createRoleRevoker("RB05 撤回员A");

    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    // T1：entry auth（requireAdmin 等价快照）已成立，取锁前挂起
    const t1 = upsertCategoryInGovernance({
      actorId: targetAdmin.id,
      kind: "PRODUCT",
      categoryId,
      name: "竞态窗口内的过期写入",
      slug: categorySlug,
      description: null,
      sortOrder: 1,
      isActive: true,
      seams: {
        beforeLock: async () => {
          signalEntered();
          await t1Gate;
        },
      },
    });
    await entered;

    // T2：生产 revokeRole 撤回 targetAdmin 的 PLATFORM_ADMIN（T1 未持锁 → 无竞争）
    const revokeResult = await revokeRole({
      actorId: revoker.id,
      targetUserId: targetAdmin.id,
      roleKey: PLATFORM_ADMIN_ROLE_KEY,
    });
    expect(revokeResult.removed).toBe(true);

    releaseT1();
    // T1 恢复：USER 锁内 fresh category.manage 已失去 → 拒绝
    await expect(t1).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });

    // 分类零变更
    const row = await rawClient!.productCategory.findUniqueOrThrow({ where: { id: categoryId } });
    expect(row.name).toBe(`${RUN_TAG} 原始分类`);
    // 零新增分类审计
    const auditCount = await rawClient!.adminLog.count({
      where: { adminId: targetAdmin.id, targetType: "PRODUCT_CATEGORY" },
    });
    expect(auditCount).toBe(0);
  });

  it("CATEGORY-RACE-02 mutation wins：T1 持锁提交（域写+审计同事务）→ revoke 排队后执行", async () => {
    const { upsertCategoryInGovernance } = await import(
      "@/lib/governance/admin-configuration-service"
    );
    const { revokeRole } = await import("@/lib/rbac/assignment-service");

    const targetAdmin = await createCategoryAdmin("RB05 分类管理员B");
    const revoker = await createRoleRevoker("RB05 撤回员B");

    let signalLockedChecked!: () => void;
    const lockedChecked = new Promise<void>((resolve) => {
      signalLockedChecked = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    // T1：已持 USER 锁 + fresh category.manage 通过，首个域写前挂起
    const t1 = upsertCategoryInGovernance({
      actorId: targetAdmin.id,
      kind: "PRODUCT",
      categoryId,
      name: "先提交的分类更新",
      slug: categorySlug,
      description: null,
      sortOrder: 1,
      isActive: true,
      seams: {
        afterCheck: async () => {
          signalLockedChecked();
          await t1Gate;
        },
      },
    });
    await lockedChecked;

    // T2：revokeRole 需要同一 USER 锁 → 真实进入等待队列（pg_locks barrier）
    const t2 = revokeRole({
      actorId: revoker.id,
      targetUserId: targetAdmin.id,
      roleKey: PLATFORM_ADMIN_ROLE_KEY,
    });
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${targetAdmin.id}`]);

    releaseT1();
    const mutationResult = await t1;
    expect(mutationResult.categoryId).toBe(categoryId);

    // T2 在 T1 提交后完成
    const revokeResult = await t2;
    expect(revokeResult.removed).toBe(true);

    // mutation 存在
    const row = await rawClient!.productCategory.findUniqueOrThrow({ where: { id: categoryId } });
    expect(row.name).toBe("先提交的分类更新");
    // 审计恰一条（UPDATE，与域写同事务）
    const audits = await rawClient!.adminLog.findMany({
      where: { adminId: targetAdmin.id, targetType: "PRODUCT_CATEGORY" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "UPDATE_PRODUCT_CATEGORY",
      targetId: categoryId,
      detail: "先提交的分类更新",
    });
    // PLATFORM_ADMIN assignment 最终被撤回——严格线性化
    const assignment = await rawClient!.userRoleAssignment.findFirst({
      where: { userId: targetAdmin.id, roleId: platformAdminRoleId },
    });
    expect(assignment).toBeNull();
  });

  it("KEYWORD-RACE-01 revoke wins：revoke 先提交 → stale 敏感词 mutation 被拒，零写入零审计", async () => {
    const { toggleModerationKeywordStatusInGovernance } = await import(
      "@/lib/governance/admin-configuration-service"
    );
    const { revokeRole } = await import("@/lib/rbac/assignment-service");

    const targetAdmin = await createCategoryAdmin("RB05 敏感词管理员C");
    const revoker = await createRoleRevoker("RB05 撤回员C");

    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    const t1 = toggleModerationKeywordStatusInGovernance({
      actorId: targetAdmin.id,
      keywordId,
      isEnabled: false,
      seams: {
        beforeLock: async () => {
          signalEntered();
          await t1Gate;
        },
      },
    });
    await entered;

    const revokeResult = await revokeRole({
      actorId: revoker.id,
      targetUserId: targetAdmin.id,
      roleKey: PLATFORM_ADMIN_ROLE_KEY,
    });
    expect(revokeResult.removed).toBe(true);

    releaseT1();
    await expect(t1).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });

    // keyword 零变更、零审计
    const row = await rawClient!.moderationKeyword.findUniqueOrThrow({ where: { id: keywordId } });
    expect(row.isEnabled).toBe(true);
    const auditCount = await rawClient!.adminLog.count({
      where: { adminId: targetAdmin.id, targetType: "MODERATION_KEYWORD" },
    });
    expect(auditCount).toBe(0);
  });

  it("CATEGORY-ATOMIC-01：审计写失败 → 整体回滚（有写必有审计）", async () => {
    const { upsertCategoryInGovernance } = await import(
      "@/lib/governance/admin-configuration-service"
    );

    const targetAdmin = await createCategoryAdmin("RB05 分类管理员D");

    // 基线：此前测试可能已合法提交过更新，以当前行值为回滚断言基线
    const before = await rawClient!.productCategory.findUniqueOrThrow({
      where: { id: categoryId },
    });

    // fresh permission PASS → 域写发生 → beforeAudit 确定性失败 → 回滚
    await expect(
      upsertCategoryInGovernance({
        actorId: targetAdmin.id,
        kind: "PRODUCT",
        categoryId,
        name: "不应留存的更新",
        slug: categorySlug,
        description: null,
        sortOrder: 1,
        isActive: true,
        seams: {
          beforeAudit: async () => {
            throw new Error("ATOMIC_TEST_DETERMINISTIC_FAILURE");
          },
        },
      }),
    ).rejects.toThrow("ATOMIC_TEST_DETERMINISTIC_FAILURE");

    // 域写回滚
    const row = await rawClient!.productCategory.findUniqueOrThrow({ where: { id: categoryId } });
    expect(row.name).toBe(before.name);
    expect(row.name).not.toBe("不应留存的更新");
    // 审计为 0
    const auditCount = await rawClient!.adminLog.count({
      where: { adminId: targetAdmin.id, targetType: "PRODUCT_CATEGORY" },
    });
    expect(auditCount).toBe(0);
  });

  it("KEYWORD-ATOMIC-01：审计写失败 → 敏感词变更整体回滚", async () => {
    const { toggleModerationKeywordStatusInGovernance } = await import(
      "@/lib/governance/admin-configuration-service"
    );

    const targetAdmin = await createCategoryAdmin("RB05 敏感词管理员E");

    const before = await rawClient!.moderationKeyword.findUniqueOrThrow({
      where: { id: keywordId },
    });

    await expect(
      toggleModerationKeywordStatusInGovernance({
        actorId: targetAdmin.id,
        keywordId,
        isEnabled: false,
        seams: {
          beforeAudit: async () => {
            throw new Error("ATOMIC_TEST_DETERMINISTIC_FAILURE");
          },
        },
      }),
    ).rejects.toThrow("ATOMIC_TEST_DETERMINISTIC_FAILURE");

    const row = await rawClient!.moderationKeyword.findUniqueOrThrow({ where: { id: keywordId } });
    expect(row.isEnabled).toBe(before.isEnabled);
    const auditCount = await rawClient!.adminLog.count({
      where: { adminId: targetAdmin.id, targetType: "MODERATION_KEYWORD" },
    });
    expect(auditCount).toBe(0);
  });
});
