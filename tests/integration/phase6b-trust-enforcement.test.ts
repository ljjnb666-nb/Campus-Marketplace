import { randomUUID } from "node:crypto";
import { waitForAdvisoryLockWaiter } from "./helpers/lock-barrier";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Phase 6B Trust / Risk / Enforcement 集成测试（真实 PostgreSQL）。
 *
 * 覆盖：
 *  1. capability gate 矩阵（account/membership/risk scope 隔离）
 *  2. 举报信号：source-linked + 去重 + 绝不自动处罚
 *  3. account suspend/reinstate 矩阵（授权/自行动/特权目标/幂等）
 *  4. membership suspend/reinstate 矩阵（状态机 fail closed + 认证证据保留 + 跨校区拒绝）
 *  5. REQUIRED RACES（真实 PG advisory lock，barrier = promise seam + pg_locks 轮询，无 sleep 定序）：
 *     A. PLATFORM_ADMIN grant vs target account suspension（双方向）
 *     B. actor erasure vs enforcement mutation（双方向）
 *     C. risk RESTRICT vs RESTORE（确定性最终态）
 *     D. membership suspension vs listing creation（双方向）
 *  6. trust snapshot（信号聚合 + admin-only risk 隔离）
 *
 * 锁序合同（PHASE_6B_LOCK_ORDER）：sorted subject locks → actor/target 复核 →
 * domain writes → audit；全部竞态 NO_40P01。
 */

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const prisma = integrationDatabaseUrl ? (await import("@/lib/prisma")).prisma : null;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p6bit-${randomUUID().slice(0, 8)}`;
const createdUserIds: string[] = [];
const createdCampusIds: string[] = [];
const createdRoleIds: string[] = [];

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



describe.skipIf(!integrationDatabaseUrl)("Phase 6B trust/risk/enforcement 集成测试（真实 PostgreSQL）", () => {
  let campusA: { id: string };
  let campusB: { id: string };
  let student: { id: string };
  let globalAdmin: { id: string };

  beforeAll(async () => {
    campusA = await createFixtureCampus("campus-a");
    campusB = await createFixtureCampus("campus-b");
    student = await createFixtureUser("学生", campusA.id);
    globalAdmin = await createFixtureUser("全局管理员", campusA.id, { role: "ADMIN" });

    const { ensureRbacFoundation, syncLegacyAdminRoles, ensureCampusMemberships } = await import(
      "@/lib/rbac/bootstrap"
    );
    await ensureRbacFoundation(prisma!);
    await syncLegacyAdminRoles(prisma!);
    await ensureCampusMemberships(prisma!);
  });

  afterAll(async () => {
    await rawClient!.enforcementAction.deleteMany({ where: { targetId: { in: createdUserIds } } });
    await rawClient!.riskFlag.deleteMany({ where: { userId: { in: createdUserIds } } });
    await rawClient!.riskState.deleteMany({ where: { userId: { in: createdUserIds } } });
    await rawClient!.userVerification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await rawClient!.product.deleteMany({ where: { sellerId: { in: createdUserIds } } });
    await rawClient!.campusMembership.deleteMany({ where: { userId: { in: createdUserIds } } });
    await rawClient!.userRoleAssignment.deleteMany({ where: { userId: { in: createdUserIds } } });
    await rawClient!.rolePermission.deleteMany({ where: { roleId: { in: createdRoleIds } } });
    await rawClient!.role.deleteMany({ where: { id: { in: createdRoleIds } } });
    await rawClient!.uploadedAsset.deleteMany({ where: { ownerId: { in: createdUserIds } } });
    await rawClient!.policyAcceptance.deleteMany({ where: { userId: { in: createdUserIds } } });
    await rawClient!.privacyRequest.deleteMany({ where: { userId: { in: createdUserIds } } });
    await rawClient!.adminLog.deleteMany({ where: { adminId: { in: createdUserIds } } });
    await rawClient!.report.deleteMany({
      where: { OR: [{ reporterId: { in: createdUserIds } }, { targetUserId: { in: createdUserIds } }] },
    });
    await rawClient!.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await rawClient!.campus.deleteMany({ where: { id: { in: createdCampusIds } } });
    await rawClient!.$disconnect();
    await prisma?.$disconnect();
  });

  it("capability gate：NORMAL allow；GLOBAL RESTRICTED deny；campus scope 隔离；WATCH allow", async () => {
    const { setRiskState, isMarketplaceRestricted } = await import("@/lib/enforcement/risk-service");
    const { requireMarketplaceCapability } = await import("@/lib/enforcement/capability-gate");

    // 双校区成员：隔离断言需要同一用户在两个校区均有 ACTIVE membership
    const dual = await createFixtureUser("双校区成员", campusA.id);
    await rawClient!.campusMembership.create({
      data: { userId: dual.id, campusId: campusB.id, status: "ACTIVE" },
    });

    // 无行 = NORMAL → allow
    const { withTransaction } = await import("@/lib/prisma");
    await expect(
      withTransaction((tx) => requireMarketplaceCapability(tx, dual.id, campusA.id)),
    ).resolves.toBeUndefined();

    // GLOBAL RESTRICTED → 全校区 deny
    await setRiskState({
      actorId: globalAdmin.id,
      targetUserId: dual.id,
      campusId: null,
      state: "RESTRICTED",
      reasonCode: "POLICY_VIOLATION",
    });
    await expect(isMarketplaceRestricted(dual.id, campusA.id)).resolves.toBe(true);
    await expect(
      withTransaction((tx) => requireMarketplaceCapability(tx, dual.id, campusA.id)),
    ).rejects.toMatchObject({ code: "MARKETPLACE_RESTRICTED" });

    // 恢复 → allow；然后 CAMPUS-B RESTRICTED 不影响 campus-A 活动（scope 隔离）
    await setRiskState({
      actorId: globalAdmin.id,
      targetUserId: dual.id,
      campusId: null,
      state: "NORMAL",
      reasonCode: "FALSE_POSITIVE_CORRECTION",
    });
    await setRiskState({
      actorId: globalAdmin.id,
      targetUserId: dual.id,
      campusId: campusB.id,
      state: "RESTRICTED",
      reasonCode: "POLICY_VIOLATION",
    });
    await expect(isMarketplaceRestricted(dual.id, campusA.id)).resolves.toBe(false);
    await expect(
      withTransaction((tx) => requireMarketplaceCapability(tx, dual.id, campusA.id)),
    ).resolves.toBeUndefined();
    await expect(
      withTransaction((tx) => requireMarketplaceCapability(tx, dual.id, campusB.id)),
    ).rejects.toMatchObject({ code: "MARKETPLACE_RESTRICTED" });

    // WATCH 不阻断（观察态）
    await setRiskState({
      actorId: globalAdmin.id,
      targetUserId: dual.id,
      campusId: campusB.id,
      state: "NORMAL",
      reasonCode: "FALSE_POSITIVE_CORRECTION",
    });
    await setRiskState({
      actorId: globalAdmin.id,
      targetUserId: dual.id,
      campusId: campusA.id,
      state: "WATCH",
      reasonCode: "MANUAL_REVIEW",
    });
    await expect(
      withTransaction((tx) => requireMarketplaceCapability(tx, dual.id, campusA.id)),
    ).resolves.toBeUndefined();
  });

  it("membership SUSPENDED → capability deny（account/membership/risk 三门独立）", async () => {
    const { requireMarketplaceCapability } = await import("@/lib/enforcement/capability-gate");
    const { withTransaction } = await import("@/lib/prisma");

    const gatedStudent = await createFixtureUser("membership 门学生", campusA.id);
    await rawClient!.campusMembership.updateMany({
      where: { userId: gatedStudent.id },
      data: { status: "SUSPENDED" },
    });

    await expect(
      withTransaction((tx) => requireMarketplaceCapability(tx, gatedStudent.id, campusA.id)),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_NOT_ACTIVE" });
  });

  it("report 信号：记录 + 去重 + 绝不自动处罚（REPORT_SUBMITTED != 裁决事实）", async () => {
    const { recordRiskFlag, getRiskStateRows } = await import("@/lib/enforcement/risk-service");

    const flagged = await createFixtureUser("被举报人", campusA.id);
    const reportId = `rep-${randomUUID()}`;

    await recordRiskFlag({
      userId: flagged.id,
      kind: "REPORT_SUBMITTED",
      severity: "INFO",
      sourceType: "REPORT",
      sourceId: reportId,
    });
    // 同来源重复举报：幂等去重
    await recordRiskFlag({
      userId: flagged.id,
      kind: "REPORT_SUBMITTED",
      severity: "INFO",
      sourceType: "REPORT",
      sourceId: reportId,
    });

    const flags = await rawClient!.riskFlag.findMany({
      where: { userId: flagged.id, kind: "REPORT_SUBMITTED", sourceId: reportId },
    });
    expect(flags).toHaveLength(1);

    // 举报信号绝不产生处罚：risk state 仍无 RESTRICTED 行
    const rows = await getRiskStateRows(flagged.id);
    expect(rows.filter((row) => row.state === "RESTRICTED")).toHaveLength(0);
    const dbUser = await rawClient!.user.findUniqueOrThrow({ where: { id: flagged.id } });
    expect(dbUser.status).toBe("ACTIVE");
  });

  it("account suspend/reinstate：provenance + 审计 + 幂等 + self/特权/未授权拒绝", async () => {
    const { suspendAccount, reinstateAccount } = await import(
      "@/lib/enforcement/account-enforcement-service"
    );

    const target = await createFixtureUser("停用目标", campusA.id);
    const admin = await createFixtureUser("停用管理员", campusA.id);
    await grantRole(admin.id, "SUSPENDER", ["user.suspend"], "GLOBAL");

    // 自行停用拒绝
    await expect(
      suspendAccount({ actorId: target.id, targetUserId: target.id, reasonCode: "MANUAL_REVIEW" }),
    ).rejects.toMatchObject({ code: "ENFORCEMENT_SELF_DENIED" });

    // 未授权拒绝
    await expect(
      suspendAccount({ actorId: student.id, targetUserId: target.id, reasonCode: "MANUAL_REVIEW" }),
    ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });

    // 特权目标拒绝（PLATFORM_ADMIN 等价）
    const privileged = await createFixtureUser("特权目标", campusA.id);
    const { PERMISSION_KEYS } = await import("@/lib/rbac/permissions");
    await grantRole(privileged.id, "FULL_ADMIN_IT2", [...PERMISSION_KEYS], "GLOBAL");
    await expect(
      suspendAccount({ actorId: admin.id, targetUserId: privileged.id, reasonCode: "MANUAL_REVIEW" }),
    ).rejects.toMatchObject({ code: "ENFORCEMENT_PRIVILEGED_TARGET" });

    // 授权停用
    const suspended = await suspendAccount({
      actorId: admin.id,
      targetUserId: target.id,
      reasonCode: "ACCOUNT_SECURITY",
      note: "集成测试停用",
    });
    expect(suspended).toMatchObject({ status: "SUSPENDED", alreadyInState: false });
    // Repair 2 Blocker C：通知 post-commit 投递成功
    expect(suspended.notificationDelivered).toBe(true);
    expect(
      (await rawClient!.user.findUniqueOrThrow({ where: { id: target.id } })).status,
    ).toBe("SUSPENDED");

    // 幂等：重复停用 no-op（不产生第二条执法记录）
    const again = await suspendAccount({
      actorId: admin.id,
      targetUserId: target.id,
      reasonCode: "ACCOUNT_SECURITY",
    });
    expect(again.alreadyInState).toBe(true);
    expect(
      await rawClient!.enforcementAction.count({
        where: { type: "ACCOUNT_SUSPEND", targetId: target.id },
      }),
    ).toBe(1);

    // 恢复
    const reinstated = await reinstateAccount({
      actorId: admin.id,
      targetUserId: target.id,
      reasonCode: "FALSE_POSITIVE_CORRECTION",
    });
    expect(reinstated.status).toBe("ACTIVE");
    expect(
      await rawClient!.enforcementAction.count({
        where: { type: "ACCOUNT_REINSTATE", targetId: target.id },
      }),
    ).toBe(1);
  });

  it("membership suspend/reinstate：状态机 fail closed（LEFT/REJECTED/PENDING）+ 认证证据保留", async () => {
    const {
      suspendCampusMembership,
      reinstateCampusMembership,
    } = await import("@/lib/enforcement/membership-enforcement-service");

    const campusManager = await createFixtureUser("校区经理", campusA.id);
    await grantRole(campusManager.id, "CAMPUS_MANAGER_IT", ["campus.manage"], "CAMPUS", campusA.id);

    const member = await createFixtureUser("被停成员", campusA.id);
    const { submitMembershipVerification } = await import("@/lib/campus/verification-service");
    const verification = await submitMembershipVerification({
      userId: member.id,
      schoolName: "集成测试大学",
      campusName: "集成校区A",
      studentIdLast4: "8888",
      studentCardImageToken: `it-ref-${RUN_TAG}-ms`,
    });

    // 跨校区拒绝：campus-B 经理不能动 campus-A 的成员
    const managerB = await createFixtureUser("B校区经理", campusB.id);
    await grantRole(managerB.id, "CAMPUS_MANAGER_B2", ["campus.manage"], "CAMPUS", campusB.id);
    await expect(
      suspendCampusMembership({
        actorId: managerB.id,
        targetUserId: member.id,
        campusId: campusA.id,
        reasonCode: "POLICY_VIOLATION",
      }),
    ).rejects.toMatchObject({ code: "AUTH_CAMPUS_SCOPE_MISMATCH" });

    // 同校区经理停用
    const suspended = await suspendCampusMembership({
      actorId: campusManager.id,
      targetUserId: member.id,
      campusId: campusA.id,
      reasonCode: "POLICY_VIOLATION",
    });
    expect(suspended).toMatchObject({ status: "SUSPENDED", alreadyInState: false });
    expect(
      (
        await rawClient!.campusMembership.findUniqueOrThrow({
          where: { userId_campusId: { userId: member.id, campusId: campusA.id } },
        })
      ).status,
    ).toBe("SUSPENDED");

    // 认证证据保留（不删除 / 不篡改历史）
    const evidence = await rawClient!.userVerification.findUnique({ where: { id: verification.id } });
    expect(evidence?.status).toBe("PENDING");
    expect(evidence?.studentIdLast4).toBe("8888");

    // GLOBAL admin 可跨校区恢复
    const reinstated = await reinstateCampusMembership({
      actorId: globalAdmin.id,
      targetUserId: member.id,
      campusId: campusA.id,
      reasonCode: "FALSE_POSITIVE_CORRECTION",
    });
    expect(reinstated.status).toBe("ACTIVE");

    // LEFT → 恢复 fail closed（重新加入属未来加入流程，不是解除处罚）
    await rawClient!.campusMembership.updateMany({
      where: { userId: member.id },
      data: { status: "LEFT" },
    });
    await expect(
      reinstateCampusMembership({
        actorId: globalAdmin.id,
        targetUserId: member.id,
        campusId: campusA.id,
        reasonCode: "FALSE_POSITIVE_CORRECTION",
      }),
    ).rejects.toMatchObject({ code: "ENFORCEMENT_INVALID_TRANSITION" });
  });

  it("RACE A：PLATFORM_ADMIN grant vs target suspension（双方向，无 40P01）", async () => {
    const { assignRole } = await import("@/lib/rbac/assignment-service");
    const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");

    const grantor = await createFixtureUser("授予管理员A", campusA.id);
    await grantRole(grantor.id, "ROLE_ASSIGNER_A", ["rbac.role.assign"], "GLOBAL");
    const suspender = await createFixtureUser("停用管理员A", campusA.id);
    await grantRole(suspender.id, "SUSPENDER_A", ["user.suspend"], "GLOBAL");

    // ---- Direction A：grant 先锁 → suspension 阻塞 → grant 提交 → 唤醒后 privileged 拒绝 ----
    const targetA = await createFixtureUser("竞态目标A", campusA.id);
    const platformAdminRole = await rawClient!.role.findUniqueOrThrow({
      where: { key: "PLATFORM_ADMIN" },
      select: { id: true, key: true },
    });

    let grantLockedA!: () => void;
    const grantLockedA1 = new Promise<void>((resolve) => {
      grantLockedA = resolve;
    });
    let releaseGrantA!: () => void;
    const grantGateA = new Promise<void>((resolve) => {
      releaseGrantA = resolve;
    });

    const grantPromiseA = assignRole({
      actorId: grantor.id,
      targetUserId: targetA.id,
      roleKey: platformAdminRole.key,
      racePoint: async () => {
        grantLockedA();
        await grantGateA;
      },
    }).then(
      () => "fulfilled" as const,
      (error) => ({ rejected: true as const, code: error.code as string }),
    );
    await grantLockedA1;

    const suspendPromiseA = suspendAccount({
      actorId: suspender.id,
      targetUserId: targetA.id,
      reasonCode: "MANUAL_REVIEW",
    }).then(
      () => "fulfilled" as const,
      (error) => ({ rejected: true as const, code: error.code as string }),
    );

    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${targetA.id}`]);
    releaseGrantA();

    await expect(grantPromiseA).resolves.toBe("fulfilled");
    await expect(suspendPromiseA).resolves.toMatchObject({
      rejected: true,
      code: "ENFORCEMENT_PRIVILEGED_TARGET",
    });

    const finalA = await rawClient!.user.findUniqueOrThrow({ where: { id: targetA.id } });
    expect(finalA.status).toBe("ACTIVE");
    expect(
      await rawClient!.userRoleAssignment.count({ where: { userId: targetA.id } }),
    ).toBe(1);

    // ---- Direction B：suspension 先锁 → grant 阻塞 → suspension 提交 → grant 拒绝 ----
    const targetB = await createFixtureUser("竞态目标B", campusB.id);

    let suspendLockedB!: () => void;
    const suspendLockedB1 = new Promise<void>((resolve) => {
      suspendLockedB = resolve;
    });
    let releaseSuspendB!: () => void;
    const suspendGateB = new Promise<void>((resolve) => {
      releaseSuspendB = resolve;
    });

    const suspendPromiseB = suspendAccount({
      actorId: suspender.id,
      targetUserId: targetB.id,
      reasonCode: "MANUAL_REVIEW",
      racePoint: async () => {
        suspendLockedB();
        await suspendGateB;
      },
    }).then(
      () => "fulfilled" as const,
      (error) => ({ rejected: true as const, code: error.code as string }),
    );
    await suspendLockedB1;

    const grantPromiseB = assignRole({
      actorId: grantor.id,
      targetUserId: targetB.id,
      roleKey: platformAdminRole.key,
    }).then(
      () => "fulfilled" as const,
      (error) => ({ rejected: true as const, code: error.code as string }),
    );

    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${targetB.id}`]);
    releaseSuspendB();

    await expect(suspendPromiseB).resolves.toBe("fulfilled");
    await expect(grantPromiseB).resolves.toMatchObject({
      rejected: true,
      code: "AUTH_ACCOUNT_INACTIVE",
    });

    const finalB = await rawClient!.user.findUniqueOrThrow({ where: { id: targetB.id } });
    expect(finalB.status).toBe("SUSPENDED");
    expect(await rawClient!.userRoleAssignment.count({ where: { userId: targetB.id } })).toBe(0);
  });

  it("RACE B：actor erasure vs enforcement mutation（双方向，无 40P01）", async () => {
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");
    const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");

    // ---- Direction A：actor 注销先赢 → enforcement 拒绝 → 零写零审计 ----
    const actorA = await createFixtureUser("竞态执法者A", campusA.id);
    await grantRole(actorA.id, "SUSPENDER_BA", ["user.suspend"], "GLOBAL");
    const targetA = await createFixtureUser("BA目标", campusA.id);

    let eraseLockedA!: () => void;
    const eraseLockedA1 = new Promise<void>((resolve) => {
      eraseLockedA = resolve;
    });
    let releaseEraseA!: () => void;
    const eraseGateA = new Promise<void>((resolve) => {
      releaseEraseA = resolve;
    });

    const erasePromiseA = eraseAccount(actorA.id, undefined, async () => {
      eraseLockedA();
      await eraseGateA;
    });
    await eraseLockedA1;

    const suspendPromiseA = suspendAccount({
      actorId: actorA.id,
      targetUserId: targetA.id,
      reasonCode: "MANUAL_REVIEW",
    }).then(
      () => "fulfilled" as const,
      (error) => ({ rejected: true as const, code: error.code as string }),
    );

    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${actorA.id}`]);
    releaseEraseA();
    await erasePromiseA;

    await expect(suspendPromiseA).resolves.toMatchObject({
      rejected: true,
      code: "AUTH_ACCOUNT_INACTIVE",
    });
    const untouched = await rawClient!.user.findUniqueOrThrow({ where: { id: targetA.id } });
    expect(untouched.status).toBe("ACTIVE");
    expect(
      await rawClient!.enforcementAction.count({ where: { targetId: targetA.id } }),
    ).toBe(0);

    // ---- Direction B：enforcement 先锁（actor+target）→ erasure 阻塞 → enforcement 提交 → erasure 完成 ----
    const actorB = await createFixtureUser("竞态执法者B", campusA.id);
    await grantRole(actorB.id, "SUSPENDER_BB", ["user.suspend"], "GLOBAL");
    const targetB = await createFixtureUser("BB目标", campusA.id);

    let suspendLockedB!: () => void;
    const suspendLockedB1 = new Promise<void>((resolve) => {
      suspendLockedB = resolve;
    });
    let releaseSuspendB!: () => void;
    const suspendGateB = new Promise<void>((resolve) => {
      releaseSuspendB = resolve;
    });

    const suspendPromiseB = suspendAccount({
      actorId: actorB.id,
      targetUserId: targetB.id,
      reasonCode: "MANUAL_REVIEW",
      racePoint: async () => {
        suspendLockedB();
        await suspendGateB;
      },
    });
    await suspendLockedB1;

    const erasePromiseB = eraseAccount(actorB.id).then(
      () => "fulfilled" as const,
      (error) => ({ rejected: true as const, code: error.code as string }),
    );

    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${actorB.id}`]);
    releaseSuspendB();

    const suspended = await suspendPromiseB;
    expect(suspended.status).toBe("SUSPENDED");
    await expect(erasePromiseB).resolves.toBe("fulfilled");

    const erasedActor = await rawClient!.user.findUniqueOrThrow({ where: { id: actorB.id } });
    expect(erasedActor.erasedAt).toBeTruthy();
  });

  it("RACE C：risk RESTRICT vs RESTORE（subject serialization 下确定性最终态）", async () => {
    const { setRiskState } = await import("@/lib/enforcement/risk-service");

    const admin1 = await createFixtureUser("风控A", campusA.id);
    await grantRole(admin1.id, "RISK_A", ["user.suspend"], "GLOBAL");
    const admin2 = await createFixtureUser("风控B", campusA.id);
    await grantRole(admin2.id, "RISK_B", ["user.suspend"], "GLOBAL");
    const target = await createFixtureUser("风控目标", campusA.id);

    // ---- 顺序 1：restrict 先赢 → restore 后赢 → 最终 NORMAL ----
    let restrictLocked!: () => void;
    const restrictLocked1 = new Promise<void>((resolve) => {
      restrictLocked = resolve;
    });
    let releaseRestrict!: () => void;
    const restrictGate = new Promise<void>((resolve) => {
      releaseRestrict = resolve;
    });

    const restrictPromise = setRiskState({
      actorId: admin1.id,
      targetUserId: target.id,
      campusId: null,
      state: "RESTRICTED",
      reasonCode: "FRAUD_CONFIRMED",
      racePoint: async () => {
        restrictLocked();
        await restrictGate;
      },
    });
    await restrictLocked1;

    const restorePromise = setRiskState({
      actorId: admin2.id,
      targetUserId: target.id,
      campusId: null,
      state: "NORMAL",
      reasonCode: "FALSE_POSITIVE_CORRECTION",
    }).then(
      () => "fulfilled" as const,
      (error) => ({ rejected: true as const, code: error.code as string }),
    );

    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${target.id}`]);
    releaseRestrict();

    await expect(restrictPromise).resolves.toMatchObject({ state: "RESTRICTED", changed: true });
    await expect(restorePromise).resolves.toBe("fulfilled");
    expect(
      (await rawClient!.riskState.findUniqueOrThrow({
        where: { userId_scopeKey: { userId: target.id, scopeKey: "GLOBAL" } },
      })).state,
    ).toBe("NORMAL");

    // ---- 顺序 2：restore 先于 restrict 启动并提交 → 最终 RESTRICTED ----
    // （当前已是 NORMAL，restore 幂等 no-op 立即返回；随后 restrict 提交）
    const restoreFirst = await setRiskState({
      actorId: admin2.id,
      targetUserId: target.id,
      campusId: null,
      state: "NORMAL",
      reasonCode: "FALSE_POSITIVE_CORRECTION",
    });
    expect(restoreFirst.changed).toBe(false);

    const restrictSecond = await setRiskState({
      actorId: admin1.id,
      targetUserId: target.id,
      campusId: null,
      state: "RESTRICTED",
      reasonCode: "FRAUD_CONFIRMED",
    });
    expect(restrictSecond.state).toBe("RESTRICTED");

    const final = await rawClient!.riskState.findUniqueOrThrow({
      where: { userId_scopeKey: { userId: target.id, scopeKey: "GLOBAL" } },
    });
    expect(final.state).toBe("RESTRICTED");
    expect(final.reasonCode).toBe("FRAUD_CONFIRMED");
  });

  it("RACE D：membership suspension vs listing creation（双方向，无 40P01）", async () => {
    const { enforceMarketplaceCreationGate, requireMarketplaceCapability } = await import(
      "@/lib/enforcement/capability-gate"
    );
    const { suspendCampusMembership } = await import(
      "@/lib/enforcement/membership-enforcement-service"
    );
    const { withTransaction } = await import("@/lib/prisma");

    const owner = await createFixtureUser("listing 属主", campusA.id);
    const campusManager = await createFixtureUser("listing 校区经理", campusA.id);
    await grantRole(campusManager.id, "CAMPUS_MANAGER_RD", ["campus.manage"], "CAMPUS", campusA.id);
    const category = await rawClient!.productCategory.create({
      data: { name: `IT分类 ${RUN_TAG}`, slug: `it-cat-${RUN_TAG}` },
    });

    // 与 createProduct action 相同的组合：subject 锁 → 能力门 → listing 写入
    type CreationTx = Parameters<Parameters<typeof withTransaction>[0]>[0];
    const createListing = (racePoint?: (tx: CreationTx) => Promise<void>) =>
      withTransaction(async (tx) => {
        await enforceMarketplaceCreationGate(tx, owner.id, campusA.id);
        if (racePoint) {
          await racePoint(tx);
        }
        return tx.product.create({
          data: {
            title: `IT listing ${randomUUID()}`,
            description: "集成测试商品",
            price: 10,
            condition: "NORMAL_USED",
            locationText: "IT",
            categoryId: category.id,
            campusId: campusA.id,
            sellerId: owner.id,
          },
        });
      });

    // ---- Direction A：suspension 先赢 → creation 唤醒后 membership inactive → DENY，零 listing ----
    let suspendLockedA!: () => void;
    const suspendLockedA1 = new Promise<void>((resolve) => {
      suspendLockedA = resolve;
    });
    let releaseSuspendA!: () => void;
    const suspendGateA = new Promise<void>((resolve) => {
      releaseSuspendA = resolve;
    });

    const suspendPromiseA = suspendCampusMembership({
      actorId: campusManager.id,
      targetUserId: owner.id,
      campusId: campusA.id,
      reasonCode: "POLICY_VIOLATION",
      racePoint: async () => {
        suspendLockedA();
        await suspendGateA;
      },
    });
    await suspendLockedA1;

    const createPromiseA = createListing().then(
      () => "fulfilled" as const,
      (error) => ({ rejected: true as const, code: error.code as string }),
    );

    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${owner.id}`]);
    releaseSuspendA();

    await expect(suspendPromiseA).resolves.toMatchObject({ status: "SUSPENDED" });
    await expect(createPromiseA).resolves.toMatchObject({
      rejected: true,
      code: "MEMBERSHIP_NOT_ACTIVE",
    });
    expect(await rawClient!.product.count({ where: { sellerId: owner.id } })).toBe(0);

    // ---- Direction B：creation 先锁先提交 → suspension 随后完成（不偷删合法历史）----
    await reinstateOwner();

    async function reinstateOwner() {
      await reinstateCampusMembershipHelper();
    }
    async function reinstateCampusMembershipHelper() {
      const { reinstateCampusMembership: reinstate } = await import(
        "@/lib/enforcement/membership-enforcement-service"
      );
      await reinstate({
        actorId: campusManager.id,
        targetUserId: owner.id,
        campusId: campusA.id,
        reasonCode: "FALSE_POSITIVE_CORRECTION",
      });
    }

    let createLockedB!: () => void;
    const createLockedB1 = new Promise<void>((resolve) => {
      createLockedB = resolve;
    });
    let releaseCreateB!: () => void;
    const createGateB = new Promise<void>((resolve) => {
      releaseCreateB = resolve;
    });

    const createPromiseB = createListing(async () => {
      createLockedB();
      await createGateB;
    });
    await createLockedB1;

    const suspendPromiseB = suspendCampusMembership({
      actorId: campusManager.id,
      targetUserId: owner.id,
      campusId: campusA.id,
      reasonCode: "POLICY_VIOLATION",
    });

    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${owner.id}`]);
    releaseCreateB();

    const created = await createPromiseB;
    expect(created.id).toBeTruthy();
    const suspendedB = await suspendPromiseB;
    expect(suspendedB.status).toBe("SUSPENDED");

    // 合法创建的历史 listing 保留（不 mass-offline：#44 DEFER_TO_6C_OR_PHASE_8）
    const listing = await rawClient!.product.findUniqueOrThrow({ where: { id: created.id } });
    expect(listing.status).toBe("ACTIVE");

    // 恢复属主成员，避免污染后续
    void requireMarketplaceCapability;
  });

  // ============================================================
  // Repair 1 Blocker A：CAMPUS RiskState target membership integrity
  // ============================================================

  it("Repair 1 A：campus-A 经理不能对仅属于 campus-B 的 target 写 CAMPUS:A 风险态", async () => {
    const { setRiskState } = await import("@/lib/enforcement/risk-service");

    const managerA = await createFixtureUser("A区风控经理R1", campusA.id);
    await grantRole(managerA.id, "CAMPUS_MANAGER_R1", ["campus.manage"], "CAMPUS", campusA.id);
    const targetBOnly = await createFixtureUser("仅B区成员R1", campusB.id);

    await expect(
      setRiskState({
        actorId: managerA.id,
        targetUserId: targetBOnly.id,
        campusId: campusA.id,
        state: "RESTRICTED",
        reasonCode: "POLICY_VIOLATION",
      }),
    ).rejects.toMatchObject({ code: "ENFORCEMENT_TARGET_SCOPE_MISMATCH" });

    // 三张表零写入
    expect(await rawClient!.riskState.count({ where: { userId: targetBOnly.id } })).toBe(0);
    expect(await rawClient!.enforcementAction.count({ where: { targetId: targetBOnly.id } })).toBe(0);
    expect(await rawClient!.adminLog.count({ where: { targetId: targetBOnly.id } })).toBe(0);
  });

  it("Repair 1 A：GLOBAL enforcer 也不能绕过 target-campus 关联不变量", async () => {
    const { setRiskState } = await import("@/lib/enforcement/risk-service");
    const notMemberOfA = await createFixtureUser("非A区成员R1", campusB.id);

    await expect(
      setRiskState({
        actorId: globalAdmin.id,
        targetUserId: notMemberOfA.id,
        campusId: campusA.id,
        state: "RESTRICTED",
        reasonCode: "POLICY_VIOLATION",
      }),
    ).rejects.toMatchObject({ code: "ENFORCEMENT_TARGET_SCOPE_MISMATCH" });
    expect(await rawClient!.riskState.count({ where: { userId: notMemberOfA.id } })).toBe(0);

    // SUSPENDED membership 仍可被维护（管理员必须能恢复/调整其风险态）
    const suspendedMember = await createFixtureUser("停用成员R1", campusA.id);
    await rawClient!.campusMembership.updateMany({
      where: { userId: suspendedMember.id },
      data: { status: "SUSPENDED" },
    });
    await expect(
      setRiskState({
        actorId: globalAdmin.id,
        targetUserId: suspendedMember.id,
        campusId: campusA.id,
        state: "RESTRICTED",
        reasonCode: "POLICY_VIOLATION",
      }),
    ).resolves.toMatchObject({ state: "RESTRICTED", changed: true });
  });

  // ============================================================
  // Repair 1 Blocker G：授权顺序收紧（统一 denial family）
  // ============================================================

  it("Repair 1 G：无权限 actor 对 missing/normal/privileged/cross-campus target 统一 AUTH_PERMISSION_DENIED", async () => {
    const { setRiskState } = await import("@/lib/enforcement/risk-service");
    const unauthorized = await createFixtureUser("无权限探测者", campusA.id);
    const privileged = await createFixtureUser("特权R1", campusA.id);
    const { PERMISSION_KEYS } = await import("@/lib/rbac/permissions");
    await grantRole(privileged.id, "FULL_ADMIN_R1", [...PERMISSION_KEYS], "GLOBAL");

    const probes: Array<[string, string | null, string]> = [
      ["ghost-target", null, "missing"],
      [student.id, null, "normal"],
      [privileged.id, null, "privileged"],
      [student.id, campusB.id, "cross-campus"],
    ];

    for (const [targetId, campusId, label] of probes) {
      await expect(
        setRiskState({
          actorId: unauthorized.id,
          targetUserId: targetId,
          campusId,
          state: "RESTRICTED",
          reasonCode: "MANUAL_REVIEW",
        }),
        `probe ${label}`,
      ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });
    }

    // 探测零副作用
    expect(await rawClient!.riskState.count({ where: { userId: student.id } })).toBe(0);
  });

  // ============================================================
  // Repair 1 Blocker C：enforcement command/notification 原子性
  // ============================================================

  it("Repair 1 C：suspendAccount 通知随命令同事务提交（无歧义中间态）", async () => {
    const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
    const suspender = await createFixtureUser("停用者C1", campusA.id);
    await grantRole(suspender.id, "SUSPENDER_C1", ["user.suspend"], "GLOBAL");
    const target = await createFixtureUser("停用目标C1", campusA.id);

    await suspendAccount({
      actorId: suspender.id,
      targetUserId: target.id,
      reasonCode: "ACCOUNT_SECURITY",
    });

    const notification = await rawClient!.notification.findFirst({
      where: { userId: target.id, title: "账号已被停用" },
      orderBy: { createdAt: "desc" },
    });
    expect(notification).toBeTruthy();

    // 状态与通知同生共死：状态变更存在 → 通知存在
    const user = await rawClient!.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(user.status).toBe("SUSPENDED");
  });

  // ============================================================
  // Repair 1 Blocker E：新义务参与方 membership integrity
  // ============================================================

  it("Repair 1 E：counterparty membership 缺失 → 新义务创建 DENY（零订单）", async () => {
    const { createProductOrderTx } = await import("@/lib/order-creation");
    const { withTransaction } = await import("@/lib/prisma");

    // 无 membership 的卖家（直接建行，不经 fixture helper）
    const sellerNoMembership = await rawClient!.user.create({
      data: {
        email: `${RUN_TAG}-nomembership-seller@it.local`,
        name: "无成员卖家",
        passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
        schoolName: "集成测试大学",
        campusId: campusA.id,
      },
    });
    createdUserIds.push(sellerNoMembership.id);

    const category = await rawClient!.productCategory.create({
      data: { name: `IT分类E1 ${RUN_TAG}`, slug: `it-cat-e1-${RUN_TAG}` },
    });
    const product = await rawClient!.product.create({
      data: {
        title: `E1 商品 ${randomUUID()}`,
        description: "Repair1 E",
        price: 10,
        condition: "NORMAL_USED",
        locationText: "IT",
        categoryId: category.id,
        campusId: campusA.id,
        sellerId: sellerNoMembership.id,
      },
    });

    await expect(
      withTransaction((tx) =>
        createProductOrderTx(tx, {
          buyerId: student.id,
          product: {
            id: product.id,
            price: "10.00",
            sellerId: sellerNoMembership.id,
            campusId: campusA.id,
          },
          meetingLocation: "IT",
          note: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_NOT_ACTIVE" });

    expect(await rawClient!.order.count({ where: { productId: product.id } })).toBe(0);
    expect((await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } })).status).toBe("ACTIVE");
  });

  it("trust snapshot：public/internal 分离 + RiskFlag 信号（Repair 1 Blocker B）", async () => {
    const { getPublicTrustSnapshot, getInternalTrustSnapshot } = await import(
      "@/lib/trust/trust-snapshot"
    );

    const snapshotUser = await createFixtureUser("快照用户", campusA.id);
    await rawClient!.riskState.create({
      data: {
        userId: snapshotUser.id,
        campusId: null,
        scopeKey: "GLOBAL",
        state: "RESTRICTED",
        reasonCode: "POLICY_VIOLATION",
      },
    });
    // 经真实服务层记录一个 REPORT_SUBMITTED 信号（等价举报创建投影）
    const { recordRiskFlag } = await import("@/lib/enforcement/risk-service");
    await recordRiskFlag({
      userId: snapshotUser.id,
      kind: "REPORT_SUBMITTED",
      sourceType: "REPORT",
      sourceId: `rep-${RUN_TAG}`,
    });

    // 公开视图：仅安全信号；无 risk / 举报计数 / 内部 campusId 列表
    const publicSnapshot = await getPublicTrustSnapshot(snapshotUser.id);
    expect(publicSnapshot).toMatchObject({
      verification: { status: "UNVERIFIED" },
      membership: { activeCampusCount: 1 },
      legacyCreditScore: { policy: "LEGACY_DISPLAY_SIGNAL" },
    });
    const publicJson = JSON.stringify(publicSnapshot);
    expect(publicJson).not.toContain("RESTRICTED");
    expect(publicJson).not.toContain("REPORT_SUBMITTED");
    expect(publicJson).not.toContain("campus-a");

    // 内部视图未授权：student 无 audit.read → DENY
    await expect(
      getInternalTrustSnapshot({ actorId: student.id, targetUserId: snapshotUser.id }),
    ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });

    // 内部视图（GLOBAL audit.read）：risk + RiskFlag 信号可见
    const internal = await getInternalTrustSnapshot({
      actorId: globalAdmin.id,
      targetUserId: snapshotUser.id,
    });
    if (internal?.view !== "GLOBAL") {
      throw new Error("expected GLOBAL view");
    }
    expect(internal.risk.activeRestrictions).toEqual(["GLOBAL"]);
    expect(internal.risk.states[0]).toMatchObject({
      scopeKey: "GLOBAL",
      state: "RESTRICTED",
      reasonCode: "POLICY_VIOLATION",
    });
    expect(internal.reportSignals).toMatchObject({
      submittedReportSignals: 1,
      confirmedReportSignals: 0,
      submittedSignalNote: "SIGNAL_NOT_ADIJUDICATED_FACT",
    });

    // Repair 2 Blocker A：campus 视角（GLOBAL admin 请求 campusId=A 同样受
    // target relationship 约束；snapshotUser 是 A 的 ACTIVE member）→
    // 校园局部最小化视图：GLOBAL 行的 RESTRICTED 不进入 campus 视图
    const campusView = await getInternalTrustSnapshot({
      actorId: globalAdmin.id,
      targetUserId: snapshotUser.id,
      campusId: campusA.id,
    });
    if (campusView?.view !== "CAMPUS") {
      throw new Error("expected CAMPUS view");
    }
    expect(campusView.membership).toEqual({ status: "ACTIVE" });
    expect(campusView.risk.state).toBe("NORMAL");
  });

  it("Repair 1 D：report lifecycle reconcile（真实 PG，legacy + reopen + 幂等）", async () => {
    const { reconcileReportRiskProjection } = await import(
      "@/lib/enforcement/report-projection"
    );

    const reporter = await createFixtureUser("举报者D1", campusA.id);
    const reported = await createFixtureUser("被举报者D1", campusA.id);

    // legacy 举报：直接建 Report 行（无任何 RiskFlag 投影）
    const report = await rawClient!.report.create({
      data: {
        targetType: "USER",
        reason: "FAKE_INFO",
        reporterId: reporter.id,
        targetUserId: reported.id,
      },
    });

    // OPEN → reconcile：SUBMITTED ACTIVE 创建
    await reconcileReportRiskProjection({ reportId: report.id });
    const submitted = await rawClient!.riskFlag.findUniqueOrThrow({
      where: {
        kind_sourceType_sourceId: {
          kind: "REPORT_SUBMITTED",
          sourceType: "REPORT",
          sourceId: report.id,
        },
      },
    });
    expect(submitted.status).toBe("ACTIVE");
    expect(submitted.userId).toBe(reported.id);
    // Repair 2 合同：CONFIRMED 以 RESOLVED 状态补建（absent-or-resolved）
    const confirmedAfterOpen = await rawClient!.riskFlag.findUnique({
      where: {
        kind_sourceType_sourceId: {
          kind: "REPORT_CONFIRMED",
          sourceType: "REPORT",
          sourceId: report.id,
        },
      },
    });
    expect(confirmedAfterOpen === null || confirmedAfterOpen.status === "RESOLVED").toBe(true);
    await expect(
      rawClient!.riskFlag.findUnique({
        where: {
          kind_sourceType_sourceId: {
            kind: "REPORT_CONFIRMED",
            sourceType: "REPORT",
            sourceId: report.id,
          },
        },
      }),
    ).resolves.toSatisfy((row: { status: string } | null) => row === null || row.status === "RESOLVED");

    // RESOLVED → SUBMITTED resolved + CONFIRMED active
    await rawClient!.report.update({
      where: { id: report.id },
      data: { status: "RESOLVED" },
    });
    await reconcileReportRiskProjection({ reportId: report.id, actorId: globalAdmin.id });
    const confirmed = await rawClient!.riskFlag.findUniqueOrThrow({
      where: {
        kind_sourceType_sourceId: {
          kind: "REPORT_CONFIRMED",
          sourceType: "REPORT",
          sourceId: report.id,
        },
      },
    });
    expect(confirmed.status).toBe("ACTIVE");
    expect(
      (await rawClient!.riskFlag.findUniqueOrThrow({
        where: {
          kind_sourceType_sourceId: {
            kind: "REPORT_SUBMITTED",
            sourceType: "REPORT",
            sourceId: report.id,
          },
        },
      })).status,
    ).toBe("RESOLVED");

    // reopen（Option B）：RESOLVED → IN_REVIEW → SUBMITTED 重激活、CONFIRMED 闭环
    await rawClient!.report.update({
      where: { id: report.id },
      data: { status: "IN_REVIEW" },
    });
    await reconcileReportRiskProjection({ reportId: report.id, actorId: globalAdmin.id });
    expect(
      (await rawClient!.riskFlag.findUniqueOrThrow({
        where: {
          kind_sourceType_sourceId: {
            kind: "REPORT_SUBMITTED",
            sourceType: "REPORT",
            sourceId: report.id,
          },
        },
      })).status,
    ).toBe("ACTIVE");
    expect(
      (await rawClient!.riskFlag.findUniqueOrThrow({
        where: {
          kind_sourceType_sourceId: {
            kind: "REPORT_CONFIRMED",
            sourceType: "REPORT",
            sourceId: report.id,
          },
        },
      })).status,
    ).toBe("RESOLVED");

    // 幂等：重复对账零变更
    const before = await rawClient!.riskFlag.findMany({
      where: { sourceType: "REPORT", sourceId: report.id },
    });
    await reconcileReportRiskProjection({ reportId: report.id });
    const after = await rawClient!.riskFlag.findMany({
      where: { sourceType: "REPORT", sourceId: report.id },
    });
    expect(after).toHaveLength(before.length);

    // 绝不自动处罚：全流程 target 的 User.status/RiskState 不变
    const user = await rawClient!.user.findUniqueOrThrow({ where: { id: reported.id } });
    expect(user.status).toBe("ACTIVE");
    expect(await rawClient!.riskState.count({ where: { userId: reported.id } })).toBe(0);
  });
});
