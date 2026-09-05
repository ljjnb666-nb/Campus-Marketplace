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

    await expect(decisionAPromise).resolves.toMatchObject({
      rejected: true,
      code: "AUTH_ACCOUNT_INACTIVE",
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
});
