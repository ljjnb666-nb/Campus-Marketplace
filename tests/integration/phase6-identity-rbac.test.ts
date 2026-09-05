import { randomUUID } from "node:crypto";
import { PrismaClient, type VerificationStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Phase 6A 身份 / 校园成员 / 认证 / RBAC 集成测试（真实 PostgreSQL）。
 *
 * 覆盖（constraints / transactions / advisory locks / concurrency 必须真实 PG）：
 *  1. membership 唯一约束与中央 resolver
 *  2. verification policy 版本顺序 invariant 与 current 解析
 *  3. 认证状态机提交 → 决定（含 policy 证据快照与审计）
 *  4. 并发双审核决定：恰好一个合法最终决定
 *  5. 并发重复角色授予：唯一约束兜底幂等
 *  6. 认证决定 vs 账号注销竞态：subject 治理锁串行化，无"注销后 VERIFIED"
 *  7. 跨校区 scope 拒绝（campus-scoped reviewer）
 *  8. self-approval 拒绝
 *  9. legacy admin 同步 → 中央授权上下文可判定
 *
 * 服务层经 @/lib/prisma 单例访问 DATABASE_URL（CI job 级已设置并指向
 * INTEGRATION_DATABASE_URL 同库）；清理走独立裸客户端硬删除。
 */

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const prisma = integrationDatabaseUrl ? (await import("@/lib/prisma")).prisma : null;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p6it-${randomUUID().slice(0, 8)}`;
const createdUserIds: string[] = [];
const createdPolicyIds: string[] = [];
const createdRoleIds: string[] = [];
const createdCampusIds: string[] = [];

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

/** 通过服务层创建 PENDING 认证（真实状态机 + policy 证据） */
async function createPendingVerification(userId: string) {
  const { submitMembershipVerification } = await import("@/lib/campus/verification-service");

  await rawClient!.user.update({
    where: { id: userId },
    data: { verificationStatus: "UNVERIFIED" },
  });
  await rawClient!.userVerification.deleteMany({ where: { userId } });

  return submitMembershipVerification({
    userId,
    schoolName: "集成测试大学",
    campusName: "集成校区",
    studentIdLast4: "1234",
    studentCardImageToken: `it-ref-${RUN_TAG}`,
  });
}

/** 授予用户全局/校区角色（绕过 assignment service 的 fixture helper） */
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
        create: permissionKeys.map((key) => ({
          permission: { connect: { key } },
        })),
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

describe.skipIf(!integrationDatabaseUrl)("Phase 6A 身份/成员/认证/RBAC 集成测试（真实 PostgreSQL）", () => {
  let campusA: { id: string };
  let campusB: { id: string };
  let student: { id: string };
  let reviewer: { id: string };

  beforeAll(async () => {
    campusA = await createFixtureCampus("campus-a");
    campusB = await createFixtureCampus("campus-b");
    student = await createFixtureUser("学生", campusA.id);
    reviewer = await createFixtureUser("审核员", campusA.id, { role: "ADMIN" });

    // 与 seed/e2e-setup 相同的 bootstrap 语义：role=ADMIN 不会自动获得权限，
    // 必须经 RBAC foundation + legacy 同步（单一授权来源）
    const { ensureRbacFoundation, syncLegacyAdminRoles, ensureCampusMemberships } = await import(
      "@/lib/rbac/bootstrap"
    );
    await ensureRbacFoundation(prisma!);
    await syncLegacyAdminRoles(prisma!);
    await ensureCampusMemberships(prisma!);
  });

  afterAll(async () => {
    await rawClient!.userVerification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await rawClient!.campusVerificationPolicy.deleteMany({
      where: { id: { in: createdPolicyIds } },
    });
    await rawClient!.campusMembership.deleteMany({ where: { userId: { in: createdUserIds } } });
    await rawClient!.userRoleAssignment.deleteMany({ where: { userId: { in: createdUserIds } } });
    await rawClient!.rolePermission.deleteMany({ where: { roleId: { in: createdRoleIds } } });
    await rawClient!.role.deleteMany({ where: { id: { in: createdRoleIds } } });
    await rawClient!.uploadedAsset.deleteMany({ where: { ownerId: { in: createdUserIds } } });
    await rawClient!.policyAcceptance.deleteMany({ where: { userId: { in: createdUserIds } } });
    await rawClient!.privacyRequest.deleteMany({ where: { userId: { in: createdUserIds } } });
    await rawClient!.adminLog.deleteMany({ where: { adminId: { in: createdUserIds } } });
    await rawClient!.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await rawClient!.campus.deleteMany({ where: { id: { in: createdCampusIds } } });
    await rawClient!.$disconnect();
    await prisma?.$disconnect();
  });

  it("membership：(userId, campusId) 唯一约束 + resolver 只认 ACTIVE", async () => {
    await expect(
      rawClient!.campusMembership.create({
        data: { userId: student.id, campusId: campusA.id, status: "ACTIVE" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    const { resolveActiveCampusMembership } = await import("@/lib/campus/membership-service");
    await expect(resolveActiveCampusMembership(student.id)).resolves.toMatchObject({
      campusId: campusA.id,
      status: "ACTIVE",
    });

    // 非 ACTIVE 状态对 resolver 不可见
    await rawClient!.campusMembership.updateMany({
      where: { userId: student.id },
      data: { status: "SUSPENDED" },
    });
    await expect(resolveActiveCampusMembership(student.id)).resolves.toBeNull();

    await rawClient!.campusMembership.updateMany({
      where: { userId: student.id },
      data: { status: "ACTIVE" },
    });
  });

  it("policy：版本顺序 invariant + current 解析 + 发布即不可变", async () => {
    const { createVerificationPolicy, publishVerificationPolicy, getCurrentVerificationPolicy } =
      await import("@/lib/campus/verification-policy-service");

    const v1 = await createVerificationPolicy({
      campusId: campusA.id,
      version: 1,
      title: `认证规则 v1 ${RUN_TAG}`,
      instructions: `v1 指引 ${RUN_TAG}`,
    });
    createdPolicyIds.push(v1.id);

    const publishedV1 = await publishVerificationPolicy(v1.id);
    expect(publishedV1.status).toBe("PUBLISHED");
    expect(publishedV1.publishedAt).toBeTruthy();

    // 已发布策略幂等重发布：不产生第二个 published 版本
    const republished = await publishVerificationPolicy(v1.id);
    expect(republished.id).toBe(v1.id);

    // 低于最高已发布版本的发布请求被拒（版本顺序 invariant）
    const v0 = await createVerificationPolicy({
      campusId: campusA.id,
      version: 0,
      title: `认证规则 v0 ${RUN_TAG}`,
      instructions: `v0 指引 ${RUN_TAG}`,
    });
    createdPolicyIds.push(v0.id);
    await expect(publishVerificationPolicy(v0.id)).rejects.toMatchObject({
      code: "CAMPUS_VERIFICATION_POLICY_ALREADY_PUBLISHED",
    });

    // 更高版本可发布并成为 current
    const v2 = await createVerificationPolicy({
      campusId: campusA.id,
      version: 2,
      title: `认证规则 v2 ${RUN_TAG}`,
      instructions: `v2 指引 ${RUN_TAG}`,
    });
    createdPolicyIds.push(v2.id);
    await publishVerificationPolicy(v2.id);

    const current = await getCurrentVerificationPolicy(campusA.id, new Date());
    expect(current?.version).toBe(2);

    // 其他校区不受影响
    const otherCampus = await getCurrentVerificationPolicy(campusB.id, new Date());
    expect(otherCampus).toBeNull();
  });

  it("verification：提交 → 批准，policy 证据与审计落库", async () => {
    const { createVerificationPolicy, publishVerificationPolicy } = await import(
      "@/lib/campus/verification-policy-service"
    );
    const policy = await createVerificationPolicy({
      campusId: campusA.id,
      version: 901,
      title: `流程策略 ${RUN_TAG}`,
      instructions: `流程指引 ${RUN_TAG}`,
    });
    createdPolicyIds.push(policy.id);
    await publishVerificationPolicy(policy.id);

    const verification = await createPendingVerification(student.id);

    expect(verification.status).toBe("PENDING");
    expect(verification.policyId).toBe(policy.id);
    expect(verification.policyVersion).toBe(901);
    expect(verification.policyHash).toBeTruthy();

    const { decideMembershipVerification } = await import("@/lib/campus/verification-service");
    const decided = await decideMembershipVerification({
      actorId: reviewer.id,
      verificationId: verification.id,
      decision: "VERIFIED",
      reviewNote: "集成测试通过",
    });

    expect(decided.status).toBe("VERIFIED");
    expect(decided.reviewedById).toBe(reviewer.id);

    const dbUser = await rawClient!.user.findUnique({ where: { id: student.id } });
    expect(dbUser?.verificationStatus).toBe("VERIFIED");

    const audits = await rawClient!.adminLog.findMany({
      where: { targetType: "USER_VERIFICATION", targetId: verification.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("APPROVE_VERIFICATION");
    expect(audits[0]!.adminId).toBe(reviewer.id);
    expect(audits[0]!.campusId).toBe(campusA.id);
  });

  it("self-approval 被拒绝（self-escalation 面）", async () => {
    const verification = await createPendingVerification(reviewer.id);

    const { decideMembershipVerification } = await import("@/lib/campus/verification-service");
    await expect(
      decideMembershipVerification({
        actorId: reviewer.id,
        verificationId: verification.id,
        decision: "VERIFIED",
      }),
    ).rejects.toMatchObject({ code: "VERIFICATION_SELF_REVIEW_DENIED" });

    const unchanged = await rawClient!.userVerification.findUnique({
      where: { id: verification.id },
    });
    expect(unchanged?.status).toBe("PENDING");
  });

  it("并发双审核决定：恰好一个合法最终决定（真实 PG advisory lock）", async () => {
    const verification = await createPendingVerification(student.id);
    const { decideMembershipVerification } = await import("@/lib/campus/verification-service");

    const [approve, reject] = await Promise.allSettled([
      decideMembershipVerification({
        actorId: reviewer.id,
        verificationId: verification.id,
        decision: "VERIFIED",
      }),
      decideMembershipVerification({
        actorId: reviewer.id,
        verificationId: verification.id,
        decision: "REJECTED",
      }),
    ]);

    const outcomes = [approve, reject];
    const fulfilled = outcomes.filter((r) => r.status === "fulfilled");
    const rejected = outcomes.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "VERIFICATION_INVALID_TRANSITION",
    });

    const final = await rawClient!.userVerification.findUnique({
      where: { id: verification.id },
    });
    const finalStatus = final?.status as VerificationStatus;
    expect(["VERIFIED", "REJECTED"]).toContain(finalStatus);
    expect(finalStatus).toBe((fulfilled[0] as PromiseFulfilledResult<{ status: VerificationStatus }>).value.status);

    // 恰好一条审计（成功决定），失败决定不产生审计行
    const audits = await rawClient!.adminLog.findMany({
      where: { targetType: "USER_VERIFICATION", targetId: verification.id },
    });
    expect(audits).toHaveLength(1);

    // 清理：把用户认证状态归位，避免污染后续用例
    await rawClient!.user.update({
      where: { id: student.id },
      data: { verificationStatus: "UNVERIFIED" },
    });
    await rawClient!.userVerification.deleteMany({ where: { userId: student.id } });
  });

  it("并发重复角色授予：恰好一行（唯一约束兜底幂等）", async () => {
    const { assignRole } = await import("@/lib/rbac/assignment-service");
    const target = await createFixtureUser("待授角色用户", campusA.id);

    // 全局授权：reviewer 通过 legacy 同步获得 PLATFORM_ADMIN（见下一条用例前的 fixture）
    const [first, second] = await Promise.allSettled([
      assignRole({
        actorId: reviewer.id,
        targetUserId: target.id,
        roleKey: "PLATFORM_ADMIN",
      }),
      assignRole({
        actorId: reviewer.id,
        targetUserId: target.id,
        roleKey: "PLATFORM_ADMIN",
      }),
    ]);

    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("fulfilled");
    const createdFlags = [first, second].map(
      (r) => (r as PromiseFulfilledResult<{ created: boolean }>).value.created,
    );
    expect(createdFlags.filter(Boolean)).toHaveLength(1);

    const rows = await rawClient!.userRoleAssignment.findMany({
      where: { userId: target.id },
    });
    expect(rows).toHaveLength(1);

    const audits = await rawClient!.adminLog.findMany({
      where: { action: "ROLE_ASSIGNED", targetId: target.id },
    });
    expect(audits).toHaveLength(1);
  });

  it("认证决定 vs 账号注销竞态：subject 锁串行化，无'注销后 VERIFIED'", async () => {
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");
    const { decideMembershipVerification, submitMembershipVerification } = await import(
      "@/lib/campus/verification-service"
    );

    /** 轮询直到存在未授予锁（显式屏障：第二个事务已进入锁等待队列） */
    async function waitForLockWaiter(): Promise<void> {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const locks = await rawClient!.$queryRaw<{ count: bigint }[]>`
          SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted`;
        if (Number(locks[0]?.count ?? BigInt(0)) > 0) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("10 秒内未观察到锁等待（屏障失效）");
    }

    // ---- Case A：注销先赢（racePoint 信号确认持锁后决定才启动）→ 决定被拒绝 ----
    const userA = await createFixtureUser("竞态A", campusA.id);
    const verificationA = await submitMembershipVerification({
      userId: userA.id,
      schoolName: "集成测试大学",
      campusName: "集成校区",
      studentIdLast4: "4321",
      studentCardImageToken: `it-ref-${RUN_TAG}-a`,
    });

    let erasureHoldingLock!: () => void;
    const erasureLocked = new Promise<void>((resolve) => {
      erasureHoldingLock = resolve;
    });
    let releaseErasure!: () => void;
    const erasureGate = new Promise<void>((resolve) => {
      releaseErasure = resolve;
    });

    const erasurePromise = eraseAccount(userA.id, undefined, async () => {
      erasureHoldingLock();
      await erasureGate;
    });

    await erasureLocked;

    const decisionAPromise = decideMembershipVerification({
      actorId: reviewer.id,
      verificationId: verificationA.id,
      decision: "VERIFIED",
    }).then(
      () => "fulfilled" as const,
      (error) => ({ rejected: true as const, code: error.code as string }),
    );

    await waitForLockWaiter();

    releaseErasure();
    await erasurePromise;

    // 注销已把 membership 闭环为 LEFT：决定在锁内重读 membership 即 fail closed
    // （MEMBERSHIP_NOT_ACTIVE 先于账号状态检查——两个检查均为 fail closed）
    await expect(decisionAPromise).resolves.toMatchObject({
      rejected: true,
      code: "MEMBERSHIP_NOT_ACTIVE",
    });

    const erasedUser = await rawClient!.user.findUnique({ where: { id: userA.id } });
    expect(erasedUser?.erasedAt).toBeTruthy();
    expect(erasedUser?.verificationStatus).toBe("UNVERIFIED");

    // ---- Case B：决定先赢（racePoint 信号确认持锁后注销才启动）→ 两者都合法 ----
    const userB = await createFixtureUser("竞态B", campusA.id);
    const verificationB = await submitMembershipVerification({
      userId: userB.id,
      schoolName: "集成测试大学",
      campusName: "集成校区",
      studentIdLast4: "5678",
      studentCardImageToken: `it-ref-${RUN_TAG}-b`,
    });

    let decisionHoldingLock!: () => void;
    const decisionLocked = new Promise<void>((resolve) => {
      decisionHoldingLock = resolve;
    });
    let releaseDecision!: () => void;
    const decisionGate = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });

    const decisionBPromise = decideMembershipVerification({
      actorId: reviewer.id,
      verificationId: verificationB.id,
      decision: "VERIFIED",
      racePoint: async () => {
        decisionHoldingLock();
        await decisionGate;
      },
    });

    await decisionLocked;

    const erasureBPromise = eraseAccount(userB.id).then(
      () => "fulfilled" as const,
      (error) => ({ rejected: true as const, code: error.code as string }),
    );

    await waitForLockWaiter();

    releaseDecision();
    const decisionB = await decisionBPromise;
    expect(decisionB.status).toBe("VERIFIED");

    const erasureB = await erasureBPromise;
    expect(erasureB).toBe("fulfilled");

    // 注销在决定之后执行：最终状态由注销合同决定（UNVERIFIED + LEFT），
    // 顺序历史保留在审计/时间线中，不存在"注销后变为 VERIFIED"的最终态
    const finalB = await rawClient!.user.findUnique({ where: { id: userB.id } });
    expect(finalB?.erasedAt).toBeTruthy();
    expect(finalB?.verificationStatus).toBe("UNVERIFIED");

    const membershipB = await rawClient!.campusMembership.findFirst({
      where: { userId: userB.id },
    });
    expect(membershipB?.status).toBe("LEFT");
  });

  it("跨校区 scope 拒绝：campus-B reviewer 不能决定 campus-A 的认证", async () => {
    const verification = await createPendingVerification(student.id);
    const campusBReviewer = await createFixtureUser("B校区审核员", campusB.id);

    await grantRole(
      campusBReviewer.id,
      "CAMPUS_REVIEWER",
      ["verification.review"],
      "CAMPUS",
      campusB.id,
    );

    const { decideMembershipVerification } = await import("@/lib/campus/verification-service");
    await expect(
      decideMembershipVerification({
        actorId: campusBReviewer.id,
        verificationId: verification.id,
        decision: "VERIFIED",
      }),
    ).rejects.toMatchObject({ code: "AUTH_CAMPUS_SCOPE_MISMATCH" });

    // campus-A scoped reviewer 可以决定
    const campusAReviewer = await createFixtureUser("A校区审核员", campusA.id);
    await grantRole(
      campusAReviewer.id,
      "CAMPUS_REVIEWER_A",
      ["verification.review"],
      "CAMPUS",
      campusA.id,
    );

    const decided = await decideMembershipVerification({
      actorId: campusAReviewer.id,
      verificationId: verification.id,
      decision: "REJECTED",
    });
    expect(decided.status).toBe("REJECTED");
  });

  it("legacy admin 同步 → 中央授权上下文可判定（migration/seed 等价语义）", async () => {
    const { ensureRbacFoundation, syncLegacyAdminRoles } = await import("@/lib/rbac/bootstrap");
    await ensureRbacFoundation(prisma!);

    const legacyAdmin = await rawClient!.user.create({
      data: {
        email: `${RUN_TAG}-legacy-admin@it.local`,
        name: "legacy 管理员",
        passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
        schoolName: "集成测试大学",
        campusId: campusA.id,
        role: "ADMIN",
      },
    });
    createdUserIds.push(legacyAdmin.id);

    // 同步前：role=ADMIN 但无授权 → 中央上下文不认
    const before = await import("@/lib/rbac/service").then((m) =>
      m.loadAuthorizationContext(legacyAdmin.id),
    );
    expect(before?.grants).toEqual([]);

    const created = await syncLegacyAdminRoles(prisma!);
    expect(created).toBeGreaterThanOrEqual(1);

    // 幂等：再次同步不产生新行
    const again = await syncLegacyAdminRoles(prisma!);
    expect(again).toBe(0);

    const { loadAuthorizationContext, hasPermission } = await import("@/lib/rbac/service");
    const context = await loadAuthorizationContext(legacyAdmin.id);
    expect(hasPermission(context, "verification.review")).toBe(true);

    // 缺失 membership 的用户由 ensureCampusMemberships 补齐
    const { ensureCampusMemberships } = await import("@/lib/rbac/bootstrap");
    await ensureCampusMemberships(prisma!);
    const membership = await rawClient!.campusMembership.findFirst({
      where: { userId: legacyAdmin.id },
    });
    expect(membership?.status).toBe("ACTIVE");

    // 停用账号：即使持有授权也 DENY（active-account enforcement 集成）
    await rawClient!.user.update({
      where: { id: legacyAdmin.id },
      data: { status: "SUSPENDED" },
    });
    const suspended = await loadAuthorizationContext(legacyAdmin.id);
    expect(hasPermission(suspended, "verification.review")).toBe(false);
  });

  // ============================================================
  // Repair 1：CAMPUS 权限必须要求 ACTIVE membership
  // ============================================================

  it("CAMPUS permission membership matrix：仅 ACTIVE membership 放行（context 级）", async () => {
    const { loadAuthorizationContext, hasPermission } = await import("@/lib/rbac/service");

    const reviewerA = await createFixtureUser("校区审核员M", campusA.id);
    await grantRole(reviewerA.id, "CAMPUS_REVIEWER_M", ["verification.review"], "CAMPUS", campusA.id);

    const membership = await rawClient!.campusMembership.findFirstOrThrow({
      where: { userId: reviewerA.id },
    });

    // ACTIVE → ALLOW
    const active = await loadAuthorizationContext(reviewerA.id);
    expect(active?.activeCampusIds).toEqual([campusA.id]);
    expect(hasPermission(active, "verification.review", campusA.id)).toBe(true);

    // PENDING / REJECTED / SUSPENDED / LEFT → 全部 DENY
    for (const status of ["PENDING", "REJECTED", "SUSPENDED", "LEFT"] as const) {
      await rawClient!.campusMembership.update({
        where: { id: membership.id },
        data: { status },
      });
      const context = await loadAuthorizationContext(reviewerA.id);
      expect(context?.activeCampusIds).toEqual([]);
      expect(hasPermission(context, "verification.review", campusA.id)).toBe(false);
    }

    // 恢复 ACTIVE → ALLOW
    await rawClient!.campusMembership.update({
      where: { id: membership.id },
      data: { status: "ACTIVE" },
    });
    const restored = await loadAuthorizationContext(reviewerA.id);
    expect(hasPermission(restored, "verification.review", campusA.id)).toBe(true);
  });

  it("CAMPUS reviewer 无 ACTIVE membership → 真实 decide DENY；GLOBAL 审核员无 membership → ALLOW", async () => {
    const { decideMembershipVerification } = await import("@/lib/campus/verification-service");

    // campus reviewer + membership SUSPENDED → deny
    const suspendedReviewer = await createFixtureUser("停用成员审核员", campusA.id);
    await grantRole(
      suspendedReviewer.id,
      "CAMPUS_REVIEWER_SUSP",
      ["verification.review"],
      "CAMPUS",
      campusA.id,
    );
    await rawClient!.campusMembership.updateMany({
      where: { userId: suspendedReviewer.id },
      data: { status: "SUSPENDED" },
    });

    const verificationA = await createPendingVerification(student.id);
    await expect(
      decideMembershipVerification({
        actorId: suspendedReviewer.id,
        verificationId: verificationA.id,
        decision: "VERIFIED",
      }),
    ).rejects.toMatchObject({ code: "AUTH_CAMPUS_SCOPE_MISMATCH" });

    // GLOBAL reviewer 完全没有 membership → 仍可工作（GLOBAL 不受 membership 限制）
    const globalNoMembership = await rawClient!.user.create({
      data: {
        email: `${RUN_TAG}-global-nomembership@it.local`,
        name: "无成员关系全局审核员",
        passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
        schoolName: "集成测试大学",
        campusId: campusA.id,
      },
    });
    createdUserIds.push(globalNoMembership.id);
    await grantRole(
      globalNoMembership.id,
      "GLOBAL_REVIEWER_NOM",
      ["verification.review"],
      "GLOBAL",
    );

    const decided = await decideMembershipVerification({
      actorId: globalNoMembership.id,
      verificationId: verificationA.id,
      decision: "REJECTED",
    });
    expect(decided.status).toBe("REJECTED");
  });

  it("verification 所属 membership 非 ACTIVE → 决定 fail closed（MEMBERSHIP_NOT_ACTIVE）", async () => {
    const { decideMembershipVerification } = await import("@/lib/campus/verification-service");

    const inactiveStudent = await createFixtureUser("非活跃成员学生", campusA.id);
    const verification = await createPendingVerification(inactiveStudent.id);

    for (const status of ["SUSPENDED", "LEFT", "REJECTED"] as const) {
      await rawClient!.campusMembership.updateMany({
        where: { userId: inactiveStudent.id },
        data: { status },
      });

      await expect(
        decideMembershipVerification({
          actorId: reviewer.id,
          verificationId: verification.id,
          decision: "VERIFIED",
        }),
      ).rejects.toMatchObject({ code: "MEMBERSHIP_NOT_ACTIVE" });
    }

    const unchanged = await rawClient!.userVerification.findUnique({
      where: { id: verification.id },
    });
    expect(unchanged?.status).toBe("PENDING");
  });

  it("membership A→B 后重新提交：verification 重绑 B + policy B；A 审核员 DENY、B 审核员 ALLOW", async () => {
    const { createVerificationPolicy, publishVerificationPolicy, getCurrentVerificationPolicy } =
      await import("@/lib/campus/verification-policy-service");
    const { submitMembershipVerification, decideMembershipVerification } = await import(
      "@/lib/campus/verification-service"
    );

    async function nextPolicyVersion(campusId: string): Promise<number> {
      const highest = await rawClient!.campusVerificationPolicy.findFirst({
        where: { campusId },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      return (highest?.version ?? 900) + 1;
    }

    const abStudent = await createFixtureUser("AB学生", campusA.id);
    const membershipA = await rawClient!.campusMembership.findFirstOrThrow({
      where: { userId: abStudent.id },
    });

    const versionA = await nextPolicyVersion(campusA.id);
    const policyA = await createVerificationPolicy({
      campusId: campusA.id,
      version: versionA,
      title: `A 规则 ${RUN_TAG} v${versionA}`,
      instructions: `A 指引 ${RUN_TAG} v${versionA}`,
    });
    createdPolicyIds.push(policyA.id);
    await publishVerificationPolicy(policyA.id);

    // 首次提交：绑定 membership A + policy A
    const first = await submitMembershipVerification({
      userId: abStudent.id,
      schoolName: "集成测试大学",
      campusName: "集成校区A",
      studentIdLast4: "1111",
      studentCardImageToken: `it-ref-${RUN_TAG}-ab1`,
    });
    expect(first.membershipId).toBe(membershipA.id);
    expect(first.policyId).toBe(policyA.id);
    expect(first.policyVersion).toBe(versionA);
    // 不变量：policy.campusId == membership.campusId
    const policyARow = await rawClient!.campusVerificationPolicy.findUniqueOrThrow({
      where: { id: policyA.id },
      select: { campusId: true },
    });
    expect(policyARow.campusId).toBe(campusA.id);

    // membership A → LEFT；membership B（campusB）→ ACTIVE
    await rawClient!.campusMembership.update({
      where: { id: membershipA.id },
      data: { status: "LEFT" },
    });
    const membershipB = await rawClient!.campusMembership.create({
      data: { userId: abStudent.id, campusId: campusB.id, status: "ACTIVE" },
    });

    const versionB = await nextPolicyVersion(campusB.id);
    const policyB = await createVerificationPolicy({
      campusId: campusB.id,
      version: versionB,
      title: `B 规则 ${RUN_TAG} v${versionB}`,
      instructions: `B 指引 ${RUN_TAG} v${versionB}`,
    });
    createdPolicyIds.push(policyB.id);
    await publishVerificationPolicy(policyB.id);

    // 重新提交：membershipId 重绑 B，policy 证据来自 B
    const resubmitted = await submitMembershipVerification({
      userId: abStudent.id,
      schoolName: "集成测试大学",
      campusName: "集成校区B",
      studentIdLast4: "2222",
      studentCardImageToken: `it-ref-${RUN_TAG}-ab2`,
    });

    expect(resubmitted.membershipId).toBe(membershipB.id);
    expect(resubmitted.policyId).toBe(policyB.id);
    expect(resubmitted.policyVersion).toBe(versionB);
    expect(resubmitted.policyHash).toBe(policyB.contentHash);

    // campus-A reviewer → DENY（scope 与 membership 都不在 A）
    const reviewerA = await createFixtureUser("A侧审核员AB", campusA.id);
    await grantRole(reviewerA.id, "CAMPUS_REVIEWER_AB_A", ["verification.review"], "CAMPUS", campusA.id);
    await expect(
      decideMembershipVerification({
        actorId: reviewerA.id,
        verificationId: resubmitted.id,
        decision: "VERIFIED",
      }),
    ).rejects.toMatchObject({ code: "AUTH_CAMPUS_SCOPE_MISMATCH" });

    // campus-B reviewer → ALLOW
    const reviewerB = await createFixtureUser("B侧审核员AB", campusB.id);
    await grantRole(reviewerB.id, "CAMPUS_REVIEWER_AB_B", ["verification.review"], "CAMPUS", campusB.id);
    const decided = await decideMembershipVerification({
      actorId: reviewerB.id,
      verificationId: resubmitted.id,
      decision: "VERIFIED",
    });
    expect(decided.status).toBe("VERIFIED");

    // current policy 解析仍各自独立
    const currentA = await getCurrentVerificationPolicy(campusA.id, new Date());
    const currentB = await getCurrentVerificationPolicy(campusB.id, new Date());
    expect(currentB?.id).toBe(policyB.id);
    expect(currentA?.id).not.toBe(policyB.id);
  });

  // ============================================================
  // Repair 1：Actor authorization serialization（真实 PG 竞态）
  // ============================================================

  it("actor 注销 vs 审核决定竞态：双方向确定性，无 40P01，无'已注销 actor 完成决定'", async () => {
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");
    const { decideMembershipVerification } = await import("@/lib/campus/verification-service");

    /** 显式屏障：轮询直到存在未授予锁（第二个事务已进入锁等待队列） */
    async function waitForLockWaiter(): Promise<void> {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const locks = await rawClient!.$queryRaw<{ count: bigint }[]>`
          SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted`;
        if (Number(locks[0]?.count ?? BigInt(0)) > 0) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("10 秒内未观察到锁等待（屏障失效）");
    }

    // Direction A：actor 注销先赢 → 决定在锁上阻塞 → 注销提交 → 决定 AUTH_ACCOUNT_INACTIVE
    const actorA = await createFixtureUser("竞态ActorA", campusA.id, { role: "ADMIN" });
    await grantRole(actorA.id, "RACE_REVIEWER_A", ["verification.review"], "GLOBAL");
    const targetA = await createFixtureUser("竞态目标A", campusA.id);
    const verificationA = await createPendingVerificationFor(targetA.id);

    let erasureLockedA!: () => void;
    const erasureLockedPromiseA = new Promise<void>((resolve) => {
      erasureLockedA = resolve;
    });
    let releaseErasureA!: () => void;
    const erasureGateA = new Promise<void>((resolve) => {
      releaseErasureA = resolve;
    });

    const erasurePromiseA = eraseAccount(actorA.id, undefined, async () => {
      erasureLockedA();
      await erasureGateA;
    });
    await erasureLockedPromiseA;

    const decisionPromiseA = decideMembershipVerification({
      actorId: actorA.id,
      verificationId: verificationA.id,
      decision: "VERIFIED",
    }).then(
      () => "fulfilled" as const,
      (error) => ({ rejected: true as const, code: error.code as string }),
    );

    await waitForLockWaiter();
    releaseErasureA();
    await erasurePromiseA;

    await expect(decisionPromiseA).resolves.toMatchObject({
      rejected: true,
      code: "AUTH_ACCOUNT_INACTIVE",
    });
    const untouchedA = await rawClient!.userVerification.findUnique({
      where: { id: verificationA.id },
    });
    expect(untouchedA?.status).toBe("PENDING");
    const auditsA = await rawClient!.adminLog.findMany({
      where: { targetType: "USER_VERIFICATION", targetId: verificationA.id },
    });
    expect(auditsA).toHaveLength(0);

    // Direction B：决定先锁 {actor, target} → actor 注销阻塞 → 决定提交 → 注销完成
    const actorB = await createFixtureUser("竞态ActorB", campusA.id);
    await grantRole(actorB.id, "RACE_REVIEWER_B", ["verification.review"], "GLOBAL");
    const targetB = await createFixtureUser("竞态目标B", campusA.id);
    const verificationB = await createPendingVerificationFor(targetB.id);

    let decisionLockedB!: () => void;
    const decisionLockedPromiseB = new Promise<void>((resolve) => {
      decisionLockedB = resolve;
    });
    let releaseDecisionB!: () => void;
    const decisionGateB = new Promise<void>((resolve) => {
      releaseDecisionB = resolve;
    });

    const decisionPromiseB = decideMembershipVerification({
      actorId: actorB.id,
      verificationId: verificationB.id,
      decision: "VERIFIED",
      racePoint: async () => {
        decisionLockedB();
        await decisionGateB;
      },
    });
    await decisionLockedPromiseB;

    const erasurePromiseB = eraseAccount(actorB.id).then(
      () => "fulfilled" as const,
      (error) => ({ rejected: true as const, code: error.code as string }),
    );

    await waitForLockWaiter();
    releaseDecisionB();

    const decidedB = await decisionPromiseB;
    expect(decidedB.status).toBe("VERIFIED");
    await expect(erasurePromiseB).resolves.toBe("fulfilled");

    const erasedActor = await rawClient!.user.findUnique({ where: { id: actorB.id } });
    expect(erasedActor?.erasedAt).toBeTruthy();
    const decidedTarget = await rawClient!.userVerification.findUnique({
      where: { id: verificationB.id },
    });
    expect(decidedTarget?.status).toBe("VERIFIED");
  });

  it("actor 被撤权 vs 审核决定竞态：撤权先提交 → 后续决定 DENY（真实 PG，无死锁）", async () => {
    const { decideMembershipVerification } = await import("@/lib/campus/verification-service");
    const { revokeRole } = await import("@/lib/rbac/assignment-service");

    async function waitForLockWaiter(): Promise<void> {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const locks = await rawClient!.$queryRaw<{ count: bigint }[]>`
          SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted`;
        if (Number(locks[0]?.count ?? BigInt(0)) > 0) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("10 秒内未观察到锁等待（屏障失效）");
    }

    // 另一位持有 rbac.role.assign 的平台管理员（不由业务服务绕道，符合撤权路径）
    const revoker = await createFixtureUser("撤权管理员", campusA.id);
    await grantRole(revoker.id, "RACE_ASSIGNER", ["rbac.role.assign"], "GLOBAL");

    // 待撤权的审核 actor（GLOBAL verification.review）
    const actor = await createFixtureUser("被撤权审核员", campusA.id);
    const actorRole = await grantRole(actor.id, "RACE_REVIEWER_C", ["verification.review"], "GLOBAL");

    const target = await createFixtureUser("撤权竞态目标", campusA.id);
    const verification = await createPendingVerificationFor(target.id);

    let revokerLocked!: () => void;
    const revokerLockedPromise = new Promise<void>((resolve) => {
      revokerLocked = resolve;
    });
    let releaseRevoker!: () => void;
    const revokerGate = new Promise<void>((resolve) => {
      releaseRevoker = resolve;
    });

    // 撤权事务：锁 {USER:revoker, USER:actor} → racePoint 信号 → 等待放行
    const revokerPromise = revokeRole({
      actorId: revoker.id,
      targetUserId: actor.id,
      roleKey: actorRole.key,
      racePoint: async () => {
        revokerLocked();
        await revokerGate;
      },
    }).then(
      () => "fulfilled" as const,
      (error) => ({ rejected: true as const, code: error.code as string }),
    );
    await revokerLockedPromise;

    // 决定事务在撤权持锁期间启动 → 在 {USER:actor,...} 锁上阻塞
    const decisionPromise = decideMembershipVerification({
      actorId: actor.id,
      verificationId: verification.id,
      decision: "VERIFIED",
    }).then(
      () => "fulfilled" as const,
      (error) => ({ rejected: true as const, code: error.code as string }),
    );

    await waitForLockWaiter();
    releaseRevoker();

    // 撤权先提交 → 决定唤醒后 actor 已无 permission → DENY
    await expect(revokerPromise).resolves.toBe("fulfilled");
    await expect(decisionPromise).resolves.toMatchObject({
      rejected: true,
      code: "AUTH_PERMISSION_DENIED",
    });

    const untouched = await rawClient!.userVerification.findUnique({
      where: { id: verification.id },
    });
    expect(untouched?.status).toBe("PENDING");
    const audits = await rawClient!.adminLog.findMany({
      where: { targetType: "USER_VERIFICATION", targetId: verification.id },
    });
    expect(audits).toHaveLength(0);
  });

  // ============================================================
  // Repair 1：高权限目标保护以 RBAC 判定（User.role 不再参与授权）
  // ============================================================

  it("privileged target 保护以 RBAC full-admin 等价判定（role 字段不参与）", async () => {
    const { isPrivilegedTarget, hasPermission, loadAuthorizationContext } = await import(
      "@/lib/rbac/service"
    );
    const { PERMISSION_KEYS } = await import("@/lib/rbac/permissions");

    // role=STUDENT + PLATFORM_ADMIN 等价授权（全量 permission 的 GLOBAL 角色）→ 受保护
    const rbacAdmin = await createFixtureUser("RBAC管理员", campusA.id);
    await grantRole(rbacAdmin.id, "FULL_ADMIN_EQUIV", [...PERMISSION_KEYS], "GLOBAL");
    await expect(isPrivilegedTarget(rbacAdmin.id)).resolves.toBe(true);

    // role=ADMIN 但无任何授权（未同步/已撤回）→ 不再受保护
    const bareAdmin = await rawClient!.user.create({
      data: {
        email: `${RUN_TAG}-bare-admin@it.local`,
        name: "裸 role 管理员",
        passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
        schoolName: "集成测试大学",
        campusId: campusA.id,
        role: "ADMIN",
      },
    });
    createdUserIds.push(bareAdmin.id);
    await expect(isPrivilegedTarget(bareAdmin.id)).resolves.toBe(false);

    // 细粒度 GLOBAL 角色（仅 report.review）：具备该 permission，但不构成 legacy 超管
    const limited = await createFixtureUser("受限全局审核", campusA.id);
    await grantRole(limited.id, "GLOBAL_REPORT_REVIEWER_IT", ["report.review"], "GLOBAL");
    await expect(isPrivilegedTarget(limited.id)).resolves.toBe(false);
    const limitedContext = await loadAuthorizationContext(limited.id);
    expect(hasPermission(limitedContext, "report.review")).toBe(true);
  });

  // ============================================================
  // Repair 1：私有资产治理访问的 membership 回归
  // ============================================================

  it("campus sensitive reader 需 ACTIVE membership；GLOBAL reader 不需要（私有资产）", async () => {
    const { resolvePrivateAssetAccess } = await import("@/lib/asset-service");

    // 资产属主：campusA 成员 + PENDING 认证（VERIFICATION 材料绑定 membership）
    const assetOwner = await createFixtureUser("资产属主", campusA.id);
    const verification = await createPendingVerification(assetOwner.id);
    const asset = await rawClient!.uploadedAsset.create({
      data: {
        ownerId: assetOwner.id,
        category: "VERIFICATION",
        access: "PRIVATE",
        bucket: "campus-private",
        objectKey: `it/${RUN_TAG}/asset-${randomUUID()}`,
        mimeType: "image/jpeg",
        sizeBytes: 128,
        status: "ATTACHED",
        verificationId: verification.id,
      },
    });

    // campus-A sensitive reader + ACTIVE membership → ALLOW
    const readerA = await createFixtureUser("校区敏感读取员", campusA.id);
    await grantRole(readerA.id, "CAMPUS_SENSITIVE_A", ["asset.sensitive.read"], "CAMPUS", campusA.id);
    const granted = await resolvePrivateAssetAccess(asset.id, { id: readerA.id });
    expect(granted.ok).toBe(true);
    if (granted.ok) {
      expect(granted.grantedBy).toBe("permission");
    }

    // membership SUSPENDED → DENY
    const membership = await rawClient!.campusMembership.findFirstOrThrow({
      where: { userId: readerA.id },
    });
    await rawClient!.campusMembership.update({
      where: { id: membership.id },
      data: { status: "SUSPENDED" },
    });
    await expect(resolvePrivateAssetAccess(asset.id, { id: readerA.id })).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });

    // membership LEFT → DENY
    await rawClient!.campusMembership.update({
      where: { id: membership.id },
      data: { status: "LEFT" },
    });
    await expect(resolvePrivateAssetAccess(asset.id, { id: readerA.id })).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });

    // 恢复 ACTIVE → ALLOW
    await rawClient!.campusMembership.update({
      where: { id: membership.id },
      data: { status: "ACTIVE" },
    });
    await expect(resolvePrivateAssetAccess(asset.id, { id: readerA.id })).resolves.toMatchObject({
      ok: true,
    });

    // GLOBAL reader 完全无 membership → ALLOW（不受 membership 限制）
    const globalReader = await rawClient!.user.create({
      data: {
        email: `${RUN_TAG}-global-reader@it.local`,
        name: "全局敏感读取员",
        passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
        schoolName: "集成测试大学",
        campusId: campusA.id,
      },
    });
    createdUserIds.push(globalReader.id);
    await grantRole(globalReader.id, "GLOBAL_SENSITIVE_NOM", ["asset.sensitive.read"], "GLOBAL");
    await expect(resolvePrivateAssetAccess(asset.id, { id: globalReader.id })).resolves.toMatchObject({
      ok: true,
      grantedBy: "permission",
    });
  });
});

/** 为指定用户创建 PENDING 认证（与 createPendingVerification 相同，语义命名区分竞态用例） */
async function createPendingVerificationFor(userId: string) {
  return createPendingVerification(userId);
}
