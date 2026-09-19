import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Phase 7F User & Campus Verification Operations 集成测试（真实 PostgreSQL）。
//
// 覆盖（指令冻结的矩阵）：
//  - RB01..RB05：RBAC/角色/迁移合同（evidence.read 定义、CAMPUS_VERIFICATION_
//    REVIEWER 恰两 key、manageable 扩列、legacy 11-key 零变化、DB↔代码收敛、
//    零 UserRoleAssignment）
//  - SLA01..SLA06：提交/重提交 +48h、迁移历史 origin、overdue 只读、
//    零自动决定、零 enforcement
//  - U01..U07 / UP01..UP06：用户面授权（GLOBAL-only）与 DTO 隐私
//  - V01..V06：认证 scope（membership.campusId 唯一 truth、fail-closed）
//  - E01..E06：verification.evidence.read 窄授权（VERIFICATION-only、campus
//    精确、非认证资产 DENY、sensitive.read 语义保留、PLATFORM_ADMIN 保留、
//    审计触发合同 grantedBy=permission 保留）
//  - D01..D06：详情两阶段读（最小锚点先行、失败路径零敏感查询、无 oracle）
//  - V-RACE-01..07：真实 PG 并发（恰一 winner、revoke/membership/erasure/
//    resubmit 串行、NO_40P01）
//
// 零 sleep：并发 barrier = racePoint seam + pg_advisory_xact_lock waiter 轮询
// （6B/7B/7C/7E 同约定）。

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

const RUN_TAG = `p7f-${randomUUID().slice(0, 8)}`;
const FIXTURE_PASSWORD_HASH = ["$2a$10$", "itfixtureitfixtureitfixtureitfixtureitfix"].join("");

const createdUserIds: string[] = [];
const createdCampusIds: string[] = [];
const createdAssignmentIds: string[] = [];
const createdMembershipIds: string[] = [];
const createdVerificationIds: string[] = [];
const createdAssetIds: string[] = [];
const createdRoleIds: string[] = [];

let campusA: { id: string; name: string };
let campusB: { id: string; name: string };
let globalAdmin: { id: string; email: string; name: string };

async function createFixtureUser(
  name: string,
  options: {
    membershipCampusId?: string | null;
    membershipStatus?: "ACTIVE" | "SUSPENDED";
    userCampusId?: string;
    status?: "ACTIVE" | "SUSPENDED";
  } = {},
) {
  const user = await rawClient!.user.create({
    data: {
      email: `${RUN_TAG}-${createdUserIds.length}-${name}@it.local`,
      name,
      passwordHash: FIXTURE_PASSWORD_HASH,
      schoolName: "集成测试大学",
      campusId: options.userCampusId ?? campusA.id,
      role: "STUDENT",
      status: options.status ?? "ACTIVE",
    },
  });
  createdUserIds.push(user.id);
  const membershipCampusId =
    options.membershipCampusId === undefined ? campusA.id : options.membershipCampusId;
  if (membershipCampusId) {
    const membership = await rawClient!.campusMembership.create({
      data: {
        userId: user.id,
        campusId: membershipCampusId,
        status: options.membershipStatus ?? "ACTIVE",
      },
    });
    createdMembershipIds.push(membership.id);
  }
  return user;
}

async function assignRoleByKey(userId: string, roleKey: string, campusId: string | null) {
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

/** 测试专用 ad-hoc 角色（asset.sensitive.read@A / campus user.suspend 等）。 */
async function createAdHocRole(key: string, permissionKeys: string[]) {
  const role = await rawClient!.role.create({
    data: {
      key,
      name: key,
      scope: "CAMPUS",
      isSystem: false,
      rolePermissions: {
        create: permissionKeys.map((permissionKey) => ({
          permission: { connect: { key: permissionKey } },
        })),
      },
    },
  });
  createdRoleIds.push(role.id);
  return role;
}

/** 直建认证行 + 可选绑定 VERIFICATION 私有资产（evidence 场景）。 */
async function createVerificationFixture(input: {
  userId: string;
  campusId: string;
  options?: {
    membershipStatus?: "ACTIVE" | "SUSPENDED";
    status?: "PENDING" | "VERIFIED" | "REJECTED" | "REVOKED";
    submittedAt?: Date;
    withEvidenceAsset?: boolean;
  };
}) {
  const options = input.options ?? {};
  // 已有同校区 membership 则复用（createFixtureUser 默认为 campusA 建 ACTIVE
  // membership——避免 (userId, campusId) 唯一冲突；status 仅在新建时生效）
  const existing = await rawClient!.campusMembership.findUnique({
    where: { userId_campusId: { userId: input.userId, campusId: input.campusId } },
  });
  const membership =
    existing ??
    (await rawClient!.campusMembership.create({
      data: {
        userId: input.userId,
        campusId: input.campusId,
        status: options.membershipStatus ?? "ACTIVE",
      },
    }));
  if (!existing) {
    createdMembershipIds.push(membership.id);
  }
  const submittedAt = options.submittedAt ?? new Date();
    const verification = await rawClient!.userVerification.create({
      data: {
        userId: input.userId,
        membershipId: membership.id,
        schoolName: "集成测试大学",
        campusName: `${input.campusId}-校区`,
        studentIdLast4: "9999",
        studentCardImage: "legacy",
        status: options.status ?? "PENDING",
        submittedAt,
        reviewDueAt: new Date(submittedAt.getTime() + 48 * 60 * 60 * 1000),
      },
    });
    createdVerificationIds.push(verification.id);

    // 用户投影与认证行同形（canonical 不变量：两者由同一写路径同步）
    await rawClient!.user.update({
      where: { id: input.userId },
      data: { verificationStatus: options.status ?? "PENDING" },
    });

  if (options.withEvidenceAsset) {
    const asset = await rawClient!.uploadedAsset.create({
      data: {
        ownerId: input.userId,
        category: "VERIFICATION",
        access: "PRIVATE",
        bucket: "campus-private",
        objectKey: `it/${RUN_TAG}/${verification.id}.webp`,
        mimeType: "image/webp",
        sizeBytes: 1024,
        status: "ATTACHED",
        verificationId: verification.id,
        attachedAt: new Date(),
      },
    });
    createdAssetIds.push(asset.id);
    await rawClient!.userVerification.update({
      where: { id: verification.id },
      data: { studentCardImage: `asset:${asset.id}` },
    });
  }

  return verification;
}

/** 非 VERIFICATION 私有资产（REPORT 类、无业务绑定；campus 回退 owner membership）。 */
async function createNonVerificationPrivateAsset(ownerId: string) {
  const asset = await rawClient!.uploadedAsset.create({
    data: {
      ownerId,
      category: "REPORT",
      access: "PRIVATE",
      bucket: "campus-private",
      objectKey: `it/${RUN_TAG}-report-${createdAssetIds.length}.webp`,
      mimeType: "image/webp",
      sizeBytes: 512,
      status: "ATTACHED",
      attachedAt: new Date(),
    },
  });
  createdAssetIds.push(asset.id);
  return asset;
}

beforeAll(async () => {
  if (!integrationDatabaseUrl || !rawClient) {
    return;
  }
  campusA = await rawClient.campus.create({
    data: { name: `${RUN_TAG}-A校区`, slug: `${RUN_TAG}-a`, schoolName: "集成测试大学", isActive: true },
  });
  campusB = await rawClient.campus.create({
    data: { name: `${RUN_TAG}-B校区`, slug: `${RUN_TAG}-b`, schoolName: "集成测试大学", isActive: true },
  });
  createdCampusIds.push(campusA.id, campusB.id);

  globalAdmin = await createFixtureUser("全局管理员", { membershipCampusId: null });
  await assignRoleByKey(globalAdmin.id, "PLATFORM_ADMIN", null);
});

afterAll(async () => {
  if (!rawClient) {
    return;
  }
  // 逆序清理（FK：assignment/verification/asset → membership/user → campus）
  await rawClient
    .$transaction([
      rawClient.userRoleAssignment.deleteMany({ where: { id: { in: createdAssignmentIds } } }),
      rawClient.uploadedAsset.deleteMany({ where: { id: { in: createdAssetIds } } }),
      rawClient.userVerification.deleteMany({ where: { id: { in: createdVerificationIds } } }),
      rawClient.campusMembership.deleteMany({ where: { id: { in: createdMembershipIds } } }),
      rawClient.adminLog.deleteMany({
        where: { adminId: { in: createdUserIds } },
      }),
      rawClient.enforcementAction.deleteMany({
        where: { OR: [{ actorId: { in: createdUserIds } }, { targetId: { in: createdUserIds } }] },
      }),
      rawClient.notification.deleteMany({ where: { userId: { in: createdUserIds } } }),
      rawClient.role.deleteMany({ where: { id: { in: createdRoleIds } } }),
      rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } }),
      rawClient.campus.deleteMany({ where: { id: { in: createdCampusIds } } }),
    ])
    .catch((error) => {
      // 清理失败不掩盖测试结果；下一轮 RUN_TAG 唯一，不影响后续运行
      console.error("phase7f cleanup failed", error);
    });
  await rawClient.$disconnect();
});

// ══════════════════════════════════════════════════════════════════════════
// RB：RBAC / 角色定义 / 迁移合同
// ══════════════════════════════════════════════════════════════════════════

describe.skipIf(!integrationDatabaseUrl)("Phase 7F RBAC/迁移合同", () => {
  it("RB01：SYSTEM_ROLES 中 CAMPUS_VERIFICATION_REVIEWER 恰两 key（CAMPUS scope）", async () => {
    const { SYSTEM_ROLES } = await import("@/lib/rbac/roles");
    const role = SYSTEM_ROLES.find((r) => r.key === "CAMPUS_VERIFICATION_REVIEWER");
    expect(role).toBeDefined();
    expect(role!.scope).toBe("CAMPUS");
    expect([...role!.permissionKeys].sort()).toEqual(["verification.evidence.read", "verification.review"]);
  });

  it("RB02：manageable allowlist 显式扩列；LEGACY_ADMIN_EQUIVALENCE 保持 11 key 不含新权限", async () => {
    const { MANAGEABLE_GOVERNANCE_ROLE_KEYS } = await import("@/lib/rbac/role-manage-access");
    const { LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS, PERMISSION_KEYS } = await import(
      "@/lib/rbac/permissions"
    );

    expect(MANAGEABLE_GOVERNANCE_ROLE_KEYS).toContain("CAMPUS_VERIFICATION_REVIEWER");
    // R1 冻结：legacy 11-key 零变化，新权限不入列
    expect(LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS).toHaveLength(11);
    expect(LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS).not.toContain("verification.evidence.read");
    expect(PERMISSION_KEYS).toContain("verification.evidence.read");
  });

  it("RB03：DB↔代码收敛——角色权限集恰两 key；PLATFORM_ADMIN 含新权限；零 assignment", async () => {
    const rolePerms = await rawClient!.rolePermission.findMany({
      where: { role: { key: "CAMPUS_VERIFICATION_REVIEWER" } },
      select: { permission: { select: { key: true } } },
    });
    expect(rolePerms.map((rp) => rp.permission.key).sort()).toEqual([
      "verification.evidence.read",
      "verification.review",
    ]);

    const platformAdmin = await rawClient!.role.findUniqueOrThrow({
      where: { key: "PLATFORM_ADMIN" },
      select: { rolePermissions: { select: { permission: { select: { key: true } } } } },
    });
    expect(
      platformAdmin.rolePermissions.map((rp) => rp.permission.key),
    ).toContain("verification.evidence.read");

    // 迁移合同：data-only 迁移绝不产生 UserRoleAssignment
    const assignments = await rawClient!.userRoleAssignment.count({
      where: { role: { key: "CAMPUS_VERIFICATION_REVIEWER" } },
    });
    expect(assignments).toBe(0);
  });

  it("RB04：schema 迁移合同——reviewDueAt NOT NULL + 历史行 48h 不变量 + origin 文本守卫", async () => {
    const columns = await rawClient!.$queryRaw<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'UserVerification' AND column_name = 'reviewDueAt'`;
    expect(columns).toHaveLength(1);
    expect(columns[0].is_nullable).toBe("NO");

    // 所有行（含任何历史行）满足 reviewDueAt = submittedAt + 48h
    const violations = await rawClient!.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "UserVerification"
      WHERE "reviewDueAt" <> "submittedAt" + INTERVAL '48 hours'`;
    expect(Number(violations[0].count)).toBe(0);

    // 迁移文本守卫：backfill origin 必须是 submittedAt，绝不能是迁移执行时刻
    const migrationSql = readFileSync(
      join(process.cwd(), "prisma/migrations/20260918120000_phase7f_verification_review_sla/migration.sql"),
      "utf8",
    );
    expect(migrationSql).toContain(`"submittedAt" + INTERVAL '48 hours'`);
    expect(migrationSql).not.toMatch(/now\(\)\s*\+\s*INTERVAL/i);
    expect(migrationSql).not.toMatch(/CURRENT_TIMESTAMP\s*\+\s*INTERVAL/i);

    // 索引存在（队列排序）
    const index = await rawClient!.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM pg_indexes
      WHERE indexname = 'UserVerification_reviewDueAt_submittedAt_id_idx'`;
    expect(Number(index[0].count)).toBe(1);
  });

  it("RB05：campus 认证审核员不构成 legacy full-admin（requireAdmin eligibility 不变）", async () => {
    const { hasFullAdminSurfaceAccess, loadAuthorizationContext } = await import("@/lib/rbac/service");
    const reviewer = await createFixtureUser("校区认证审核员");
    await assignRoleByKey(reviewer.id, "CAMPUS_VERIFICATION_REVIEWER", campusA.id);
    const context = await loadAuthorizationContext(reviewer.id);
    expect(hasFullAdminSurfaceAccess(context)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// SLA：提交/重提交/overdue/零自动决定
// ══════════════════════════════════════════════════════════════════════════

describe.skipIf(!integrationDatabaseUrl)("Phase 7F 审核 SLA", () => {
  it("SLA01+SLA02：首次提交 +48h；驳回后重提交以新 submittedAt 重置 +48h", async () => {
    const { submitMembershipVerification, decideMembershipVerification } = await import(
      "@/lib/campus/verification-service"
    );

    const student = await createFixtureUser("SLA学生");
    const submitted = await submitMembershipVerification({
      userId: student.id,
      schoolName: "集成测试大学",
      campusName: "A校区",
      studentIdLast4: "1111",
      studentCardImageToken: "https://example.com/card.jpg",
    });
    createdVerificationIds.push(submitted.id);
    expect(
      submitted.reviewDueAt.getTime() - submitted.submittedAt.getTime(),
    ).toBe(48 * 60 * 60 * 1000);

    await decideMembershipVerification({
      actorId: globalAdmin.id,
      verificationId: submitted.id,
      decision: "REJECTED",
    });

    // 重提交：等待至少 5ms 确保新 submittedAt 与旧值可区分
    await new Promise((resolve) => setTimeout(resolve, 10));
    const resubmitted = await submitMembershipVerification({
      userId: student.id,
      schoolName: "集成测试大学",
      campusName: "A校区",
      studentIdLast4: "1111",
      studentCardImageToken: "https://example.com/card2.jpg",
    });
    expect(resubmitted.status).toBe("PENDING");
    expect(resubmitted.submittedAt.getTime()).toBeGreaterThan(submitted.submittedAt.getTime());
    expect(
      resubmitted.reviewDueAt.getTime() - resubmitted.submittedAt.getTime(),
    ).toBe(48 * 60 * 60 * 1000);
  });

  it("SLA03：迁移历史 origin——旧行（submittedAt 在过去）满足同一 48h 不变量", async () => {
    // 模拟迁移前旧行：submittedAt 远在过去；按 backfill 公式补 reviewDueAt
    const oldStudent = await createFixtureUser("SLA历史学生");
    const oldSubmittedAt = new Date(Date.now() - 100 * 60 * 60 * 1000);
    const verification = await createVerificationFixture({
      userId: oldStudent.id,
      campusId: campusA.id,
      options: { submittedAt: oldSubmittedAt },
    });
    const violations = await rawClient!.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "UserVerification"
      WHERE id = ${verification.id}
        AND "reviewDueAt" <> "submittedAt" + INTERVAL '48 hours'`;
    expect(Number(violations[0].count)).toBe(0);
    // origin 是 submittedAt（100h 前），不是"现在 + 48h"
    expect(verification.reviewDueAt.getTime()).toBe(oldSubmittedAt.getTime() + 48 * 60 * 60 * 1000);
  });

  it("SLA04+SLA05+SLA06：overdue 只读——无自动决定、无 enforcement、仅过滤/排序生效", async () => {
    const overdueStudent = await createFixtureUser("SLA超时学生");
    const overdue = await createVerificationFixture({
      userId: overdueStudent.id,
      campusId: campusA.id,
    });
    // 直接把 reviewDueAt 挪到过去（模拟超时；无任何运行时写路径会这样做）
    await rawClient!.userVerification.update({
      where: { id: overdue.id },
      data: { reviewDueAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const enforcementBefore = await rawClient!.enforcementAction.count({
      where: { targetId: overdueStudent.id },
    });

    const { deriveVerificationReviewAccess } = await import("@/lib/campus/verification-review-access");
    const { loadAuthorizationContext } = await import("@/lib/rbac/service");
    const access = deriveVerificationReviewAccess(await loadAuthorizationContext(globalAdmin.id));
    const { loadAuthorizedVerificationQueue } = await import("@/lib/campus/verification-review-query");

    const page = await loadAuthorizedVerificationQueue({ access, limit: 50 });
    const item = page.items.find((entry) => entry.verificationId === overdue.id);
    expect(item).toBeDefined();
    expect(item!.overdue).toBe(true);

    const overdueOnly = await loadAuthorizedVerificationQueue({
      access,
      limit: 50,
      filters: { overdueOnly: true },
    });
    expect(overdueOnly.items.some((entry) => entry.verificationId === overdue.id)).toBe(true);

    // SLA05/SLA06：超时绝不自动决定/执法——状态仍 PENDING、零执法行
    await new Promise((resolve) => setTimeout(resolve, 20));
    const row = await rawClient!.userVerification.findUniqueOrThrow({ where: { id: overdue.id } });
    expect(row.status).toBe("PENDING");
    expect(row.reviewedAt).toBeNull();
    expect(row.reviewedById).toBeNull();
    const enforcementAfter = await rawClient!.enforcementAction.count({
      where: { targetId: overdueStudent.id },
    });
    expect(enforcementAfter).toBe(enforcementBefore);
  });

  it("SLA 附：常量冻结 48h + 只读 helper", async () => {
    const {
      VERIFICATION_REVIEW_SLA_HOURS,
      computeVerificationReviewDueAt,
      isVerificationReviewOverdue,
    } = await import("@/lib/campus/verification-sla");
    expect(VERIFICATION_REVIEW_SLA_HOURS).toBe(48);
    const submittedAt = new Date("2026-09-18T00:00:00.000Z");
    expect(computeVerificationReviewDueAt(submittedAt).toISOString()).toBe(
      "2026-09-20T00:00:00.000Z",
    );
    expect(
      isVerificationReviewOverdue({ status: "PENDING", reviewDueAt: new Date(Date.now() - 1) }),
    ).toBe(true);
    expect(
      isVerificationReviewOverdue({ status: "VERIFIED", reviewDueAt: new Date(Date.now() - 1) }),
    ).toBe(false);
    expect(
      isVerificationReviewOverdue({ status: "PENDING", reviewDueAt: new Date(Date.now() + 60000) }),
    ).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// U01..U07 / UP01..UP06：用户运营面授权与 DTO 隐私
// ══════════════════════════════════════════════════════════════════════════

describe.skipIf(!integrationDatabaseUrl)("Phase 7F 用户运营面", () => {
  it("U01..U04：GLOBAL user.suspend ONLY——campus grant/无权限/非激活 actor 全部 DENY", async () => {
    const { deriveUserOperationsAccess } = await import("@/lib/governance/user-operations-access");
    const { loadAuthorizationContext } = await import("@/lib/rbac/service");

    // U01：GLOBAL user.suspend（PLATFORM_ADMIN）→ ALLOW
    const adminContext = await loadAuthorizationContext(globalAdmin.id);
    expect(deriveUserOperationsAccess(adminContext)).toEqual({ global: true });

    // U02：campus-scoped user.suspend（ad-hoc 角色）也不放行（GLOBAL-ONLY 冻结）
    await createAdHocRole(`${RUN_TAG}_CAMPUS_SUSPEND`, ["user.suspend"]);
    const campusSuspender = await createFixtureUser("校区停用员");
    await assignRoleByKey(campusSuspender.id, `${RUN_TAG}_CAMPUS_SUSPEND`, campusA.id);
    expect(
      deriveUserOperationsAccess(await loadAuthorizationContext(campusSuspender.id)),
    ).toEqual({ global: false });

    // U03：无权限
    const student = await createFixtureUser("普通学生");
    expect(
      deriveUserOperationsAccess(await loadAuthorizationContext(student.id)),
    ).toEqual({ global: false });

    // U04：非激活 actor（GLOBAL grant 但账号 SUSPENDED）→ DENY
    const inactiveAdmin = await createFixtureUser("停用管理员", {
      membershipCampusId: null,
      status: "SUSPENDED",
    });
    await assignRoleByKey(inactiveAdmin.id, "PLATFORM_ADMIN", null);
    expect(
      deriveUserOperationsAccess(await loadAuthorizationContext(inactiveAdmin.id)),
    ).toEqual({ global: false });
  });

  it("UP01..UP05：队列 DTO 最小化——无 email/studentId/私有证据/role/creditScore", async () => {
    const { loadUserOperationsQueue } = await import("@/lib/governance/user-operations-query");

    const privacyStudent = await createFixtureUser("隐私学生");
    await createVerificationFixture({
      userId: privacyStudent.id,
      campusId: campusA.id,
      options: { withEvidenceAsset: true },
    });

    const page = await loadUserOperationsQueue({ limit: 50 });
    const item = page.items.find((entry) => entry.userId === privacyStudent.id);
    expect(item).toBeDefined();

    // DTO 形状恰为允许字段（UP04/UP05：无 role authority、无 creditScore）
    expect(Object.keys(item!).sort()).toEqual(
      [
        "activeCampusNames",
        "createdAt",
        "displayName",
        "lastLoginAt",
        "status",
        "userId",
        "verificationStatus",
      ].sort(),
    );

    // UP01/UP02/UP03：序列化结果不含 email / studentId / 私有证据引用
    const serialized = JSON.stringify(page.items);
    expect(serialized).not.toContain(privacyStudent.email);
    expect(serialized).not.toContain("9999");
    expect(serialized).not.toContain("asset:");
    expect(serialized).not.toContain("studentCardImage");
  });

  it("UP06+U05：详情 maskedEmail；missing/deleted/erased 统一 { ok:false }（无 oracle）", async () => {
    const { loadUserOperationsDetail, maskEmail } = await import(
      "@/lib/governance/user-operations-query"
    );

    expect(maskEmail("zhangsan@example.com")).toBe("zh***@example.com");
    expect(maskEmail("ab@c.cn")).toBe("ab***@c.cn");
    expect(maskEmail("x@c.cn")).toBe("x***@c.cn");

    const detailStudent = await createFixtureUser("详情学生");
    const result = await loadUserOperationsDetail({ userId: detailStudent.id });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detail.maskedEmail).not.toBe(detailStudent.email);
      expect(result.detail.maskedEmail).toMatch(/^[a-zA-Z0-9]{1,2}\*\*\*@/);
      expect(Object.keys(result.detail).sort()).toEqual(
        [
          "createdAt",
          "displayName",
          "lastLoginAt",
          "maskedEmail",
          "memberships",
          "riskStates",
          "status",
          "userId",
          "verificationStatus",
        ].sort(),
      );
    }

    // U05：missing / deleted / erased 三种形态互不可区分
    const deletedUser = await createFixtureUser("已删除学生");
    await rawClient!.user.update({ where: { id: deletedUser.id }, data: { deletedAt: new Date() } });
    const erasedUser = await createFixtureUser("已注销学生");
    await rawClient!.user.update({ where: { id: erasedUser.id }, data: { erasedAt: new Date() } });

    const missing = await loadUserOperationsDetail({ userId: "p7f-ghost-user" });
    const deleted = await loadUserOperationsDetail({ userId: deletedUser.id });
    const erased = await loadUserOperationsDetail({ userId: erasedUser.id });
    expect(missing).toEqual({ ok: false });
    expect(deleted).toEqual({ ok: false });
    expect(erased).toEqual({ ok: false });
  });

  it("U06+U07：privileged target / self 停用仍被 canonical seam fail closed", async () => {
    const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
    const { isEnforcementError } = await import("@/lib/enforcement/errors");

    // U06：privileged target（另一 PLATFORM_ADMIN-like）→ ENFORCEMENT_PRIVILEGED_TARGET
    const anotherAdmin = await createFixtureUser("另一管理员", { membershipCampusId: null });
    await assignRoleByKey(anotherAdmin.id, "PLATFORM_ADMIN", null);
    const privileged = await suspendAccount({
      actorId: globalAdmin.id,
      targetUserId: anotherAdmin.id,
      reasonCode: "MANUAL_REVIEW",
    }).catch((error: unknown) => error);
    expect(isEnforcementError(privileged)).toBe(true);
    expect((privileged as { code: string }).code).toBe("ENFORCEMENT_PRIVILEGED_TARGET");

    // U07：self suspend → ENFORCEMENT_SELF_DENIED
    const selfDeny = await suspendAccount({
      actorId: globalAdmin.id,
      targetUserId: globalAdmin.id,
      reasonCode: "MANUAL_REVIEW",
    }).catch((error: unknown) => error);
    expect(isEnforcementError(selfDeny)).toBe(true);
    expect((selfDeny as { code: string }).code).toBe("ENFORCEMENT_SELF_DENIED");
  });

  it("action 层：suspendGovernanceUser/reinstateGovernanceUser 为薄 adapter（uniform deny / canonical 调用）", async () => {
    const { suspendGovernanceUser, reinstateGovernanceUser } = await import(
      "@/actions/governance-users"
    );

    const target = await createFixtureUser("动作目标学生");
    const formData = new FormData();
    formData.set("userId", target.id);

    // 无 session（参数合法）→ 薄 adapter 的 catch-all 兜底（server action 不上抛）
    sessionSeam.actionUser.current = null;
    const noSession = await suspendGovernanceUser(formData);
    expect(noSession.success).toBe(false);

    // 无权限 actor → uniform deny（不暴露结构）
    const bystander = await createFixtureUser("旁观学生");
    sessionSeam.actionUser.current = {
      id: bystander.id,
      email: bystander.email,
      name: bystander.name,
    };
    const denied = await suspendGovernanceUser(formData);
    expect(denied).toEqual({ success: false, error: "没有权限管理该账号" });

    // 授权 actor → canonical 调用成功 + 执法/审计行
    sessionSeam.actionUser.current = {
      id: globalAdmin.id,
      email: globalAdmin.email,
      name: globalAdmin.name,
    };
    const suspended = await suspendGovernanceUser(formData);
    expect(suspended.success).toBe(true);
    const suspendedRow = await rawClient!.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(suspendedRow.status).toBe("SUSPENDED");
    const action = await rawClient!.enforcementAction.findFirstOrThrow({
      where: { targetId: target.id, type: "ACCOUNT_SUSPEND" },
    });
    expect(action.actorId).toBe(globalAdmin.id);
    expect(action.sourceType).toBe("GOVERNANCE_ACTION");

    // missing target → uniform deny（无 oracle）
    const ghostForm = new FormData();
    ghostForm.set("userId", "p7f-ghost-target");
    const ghost = await suspendGovernanceUser(ghostForm);
    expect(ghost).toEqual({ success: false, error: "没有权限管理该账号" });

    // reinstate → ACTIVE
    const reinstated = await reinstateGovernanceUser(formData);
    expect(reinstated.success).toBe(true);
    const activeRow = await rawClient!.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(activeRow.status).toBe("ACTIVE");

    sessionSeam.actionUser.current = null;
  });
});

// ══════════════════════════════════════════════════════════════════════════
// V01..V06：认证审核 scope（membership.campusId 唯一 truth）
// ══════════════════════════════════════════════════════════════════════════

describe.skipIf(!integrationDatabaseUrl)("Phase 7F 认证审核 scope", () => {
  async function accessOf(userId: string) {
    const { deriveVerificationReviewAccess } = await import("@/lib/campus/verification-review-access");
    const { loadAuthorizationContext } = await import("@/lib/rbac/service");
    return deriveVerificationReviewAccess(await loadAuthorizationContext(userId));
  }

  it("V01..V03：GLOBAL 见全部；campus A 仅见 A；campus A 不见 B（含 detail deny）", async () => {
    const { loadAuthorizedVerificationQueue, loadAuthorizedVerificationDetail } = await import(
      "@/lib/campus/verification-review-query"
    );

    const reviewerA = await createFixtureUser("认证审核员A");
    await assignRoleByKey(reviewerA.id, "CAMPUS_VERIFICATION_REVIEWER", campusA.id);

    const studentA = await createFixtureUser("认证学生A");
    const verificationA = await createVerificationFixture({
      userId: studentA.id,
      campusId: campusA.id,
    });
    const studentB = await createFixtureUser("认证学生B");
    const verificationB = await createVerificationFixture({
      userId: studentB.id,
      campusId: campusB.id,
    });

    // V01：GLOBAL（PLATFORM_ADMIN）见 A 与 B
    const globalAccess = await accessOf(globalAdmin.id);
    const globalPage = await loadAuthorizedVerificationQueue({ access: globalAccess, limit: 50 });
    expect(globalPage.items.some((item) => item.verificationId === verificationA.id)).toBe(true);
    expect(globalPage.items.some((item) => item.verificationId === verificationB.id)).toBe(true);

    // V02：campus A 见 A
    const campusAAccess = await accessOf(reviewerA.id);
    expect(campusAAccess).toEqual({ global: false, campusIds: [campusA.id] });
    const campusAPage = await loadAuthorizedVerificationQueue({ access: campusAAccess, limit: 50 });
    expect(campusAPage.items.some((item) => item.verificationId === verificationA.id)).toBe(true);

    // V03：campus A 不见 B（队列 + detail 同形 deny）
    expect(campusAPage.items.some((item) => item.verificationId === verificationB.id)).toBe(false);
    expect(
      await loadAuthorizedVerificationDetail({ access: campusAAccess, verificationId: verificationB.id }),
    ).toEqual({ ok: false });

    // campus filter 不能扩大授权（reviewerA 用 campusB 过滤仍为空）
    const filtered = await loadAuthorizedVerificationQueue({
      access: campusAAccess,
      limit: 50,
      filters: { campusId: campusB.id },
    });
    expect(filtered.items).toHaveLength(0);
  });

  it("V04：actor membership 非 ACTIVE → campus scope 失效（空队列 + detail deny）", async () => {
    const reviewer = await createFixtureUser("失效认证审核员", { membershipStatus: "SUSPENDED" });
    await assignRoleByKey(reviewer.id, "CAMPUS_VERIFICATION_REVIEWER", campusA.id);
    const access = await accessOf(reviewer.id);
    expect(access).toEqual({ global: false, campusIds: [] });

    const { loadAuthorizedVerificationQueue, loadAuthorizedVerificationDetail } = await import(
      "@/lib/campus/verification-review-query"
    );
    const student = await createFixtureUser("V04学生");
    const verification = await createVerificationFixture({ userId: student.id, campusId: campusA.id });
    const page = await loadAuthorizedVerificationQueue({ access, limit: 50 });
    expect(page.items).toHaveLength(0);
    expect(
      await loadAuthorizedVerificationDetail({ access, verificationId: verification.id }),
    ).toEqual({ ok: false });
  });

  it("V05：target membership 非 ACTIVE → fail closed（队列不可见 + detail deny）", async () => {
    const { loadAuthorizedVerificationQueue, loadAuthorizedVerificationDetail } = await import(
      "@/lib/campus/verification-review-query"
    );
    const student = await createFixtureUser("V05学生", { membershipCampusId: null });
    const verification = await createVerificationFixture({
      userId: student.id,
      campusId: campusA.id,
      options: { membershipStatus: "SUSPENDED" },
    });

    const globalAccess = await accessOf(globalAdmin.id);
    const page = await loadAuthorizedVerificationQueue({ access: globalAccess, limit: 50 });
    expect(page.items.some((item) => item.verificationId === verification.id)).toBe(false);
    expect(
      await loadAuthorizedVerificationDetail({ access: globalAccess, verificationId: verification.id }),
    ).toEqual({ ok: false });
  });

  it("V06：User.campusId 与 scope 无关——membership.campusId 是唯一 truth", async () => {
    // 学生 User.campusId = B，但 membership + 认证绑定 A
    const student = await createFixtureUser("V06学生", { userCampusId: campusB.id });
    const verification = await createVerificationFixture({ userId: student.id, campusId: campusA.id });

    const reviewerA = await createFixtureUser("V06审核员A");
    await assignRoleByKey(reviewerA.id, "CAMPUS_VERIFICATION_REVIEWER", campusA.id);
    const reviewerB = await createFixtureUser("V06审核员B", { membershipCampusId: campusB.id });
    await assignRoleByKey(reviewerB.id, "CAMPUS_VERIFICATION_REVIEWER", campusB.id);

    const { loadAuthorizedVerificationQueue, loadAuthorizedVerificationDetail } = await import(
      "@/lib/campus/verification-review-query"
    );

    const accessA = await accessOf(reviewerA.id);
    const pageA = await loadAuthorizedVerificationQueue({ access: accessA, limit: 50 });
    expect(pageA.items.some((item) => item.verificationId === verification.id)).toBe(true);
    expect(
      (await loadAuthorizedVerificationDetail({ access: accessA, verificationId: verification.id })).ok,
    ).toBe(true);

    const accessB = await accessOf(reviewerB.id);
    const pageB = await loadAuthorizedVerificationQueue({ access: accessB, limit: 50 });
    expect(pageB.items.some((item) => item.verificationId === verification.id)).toBe(false);
    expect(
      await loadAuthorizedVerificationDetail({ access: accessB, verificationId: verification.id }),
    ).toEqual({ ok: false });
  });

  it("队列 DTO 最小化 + keyset 分页 + 默认排序（reviewDueAt ASC）", async () => {
    const { loadAuthorizedVerificationQueue, encodeVerificationCursor, decodeVerificationCursor } =
      await import("@/lib/campus/verification-review-query");

    const student = await createFixtureUser("DTO学生");
    const verification = await createVerificationFixture({
      userId: student.id,
      campusId: campusA.id,
      options: { withEvidenceAsset: true },
    });

    const globalAccess = await accessOf(globalAdmin.id);
    const page = await loadAuthorizedVerificationQueue({ access: globalAccess, limit: 50 });
    const item = page.items.find((entry) => entry.verificationId === verification.id);
    expect(item).toBeDefined();
    expect(Object.keys(item!).sort()).toEqual(
      [
        "campusId",
        "campusName",
        "overdue",
        "reviewDueAt",
        "status",
        "submittedAt",
        "userDisplayName",
        "verificationId",
      ].sort(),
    );
    const serialized = JSON.stringify(page.items);
    expect(serialized).not.toContain(student.email);
    expect(serialized).not.toContain("9999");
    expect(serialized).not.toContain("asset:");
    expect(serialized).not.toContain("reviewNote");

    // keyset：cursor roundtrip + 分页不重不漏
    const cursor = { reviewDueAt: new Date(), submittedAt: new Date(), id: "abc" };
    const encoded = encodeVerificationCursor(cursor);
    expect(decodeVerificationCursor(encoded)).toEqual(cursor);
    expect(decodeVerificationCursor("not-a-cursor")).toBeNull();

    const page1 = await loadAuthorizedVerificationQueue({ access: globalAccess, limit: 1 });
    if (page1.nextCursor) {
      const page2 = await loadAuthorizedVerificationQueue({
        access: globalAccess,
        limit: 50,
        cursor: decodeVerificationCursor(page1.nextCursor)!,
      });
      expect(
        page2.items.some((entry) => entry.verificationId === page1.items[0].verificationId),
      ).toBe(false);
    }

    // 排序：reviewDueAt ASC 全列单调
    const dueDates = page.items.map((entry) => Date.parse(entry.reviewDueAt));
    const sorted = [...dueDates].sort((a, b) => a - b);
    expect(dueDates).toEqual(sorted);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// E01..E06：verification.evidence.read 窄授权
// ══════════════════════════════════════════════════════════════════════════

describe.skipIf(!integrationDatabaseUrl)("Phase 7F 认证证据窄授权", () => {
  it("E01..E03+E05：evidence.read@A → 认证资产 A 允许 / B 拒 / 非认证资产拒；PLATFORM_ADMIN 保留", async () => {
    const { resolvePrivateAssetAccess } = await import("@/lib/asset-service");

    const reviewer = await createFixtureUser("证据审核员A");
    await assignRoleByKey(reviewer.id, "CAMPUS_VERIFICATION_REVIEWER", campusA.id);

    const studentA = await createFixtureUser("证据学生A");
    const verificationA = await createVerificationFixture({
      userId: studentA.id,
      campusId: campusA.id,
      options: { withEvidenceAsset: true },
    });
    const assetAId = (
      await rawClient!.uploadedAsset.findFirstOrThrow({
        where: { verificationId: verificationA.id },
      })
    ).id;

    const studentB = await createFixtureUser("证据学生B");
    const verificationB = await createVerificationFixture({
      userId: studentB.id,
      campusId: campusB.id,
      options: { withEvidenceAsset: true },
    });
    const assetBId = (
      await rawClient!.uploadedAsset.findFirstOrThrow({
        where: { verificationId: verificationB.id },
      })
    ).id;

    const reportAsset = await createNonVerificationPrivateAsset(studentA.id);

    // E01：verification.evidence.read@A → 认证资产 A 允许（grantedBy=permission
    // 保留——这正是 content 路由敏感访问审计的触发合同）
    const allowed = await resolvePrivateAssetAccess(assetAId, { id: reviewer.id });
    expect(allowed).toMatchObject({ ok: true, grantedBy: "permission" });
    if (allowed.ok) {
      expect(allowed.asset.category).toBe("VERIFICATION");
    }

    // E02：同权限@A → 认证资产 B 拒绝
    const deniedB = await resolvePrivateAssetAccess(assetBId, { id: reviewer.id });
    expect(deniedB).toMatchObject({ ok: false, reason: "forbidden" });

    // E03：同权限 → 非 VERIFICATION 私有资产拒绝
    const deniedNonVerification = await resolvePrivateAssetAccess(reportAsset.id, { id: reviewer.id });
    expect(deniedNonVerification).toMatchObject({ ok: false, reason: "forbidden" });

    // E05：PLATFORM_ADMIN（全量含两权限）→ 认证资产 A/B 与非认证资产均允许
    expect((await resolvePrivateAssetAccess(assetAId, { id: globalAdmin.id })).ok).toBe(true);
    expect((await resolvePrivateAssetAccess(assetBId, { id: globalAdmin.id })).ok).toBe(true);
    expect((await resolvePrivateAssetAccess(reportAsset.id, { id: globalAdmin.id })).ok).toBe(true);
  });

  it("E04：asset.sensitive.read 既有语义保留（认证 + 非认证私有资产均按 campus 精确放行）", async () => {
    const { resolvePrivateAssetAccess } = await import("@/lib/asset-service");

    await createAdHocRole(`${RUN_TAG}_SENSITIVE_A`, ["asset.sensitive.read"]);
    const sensitiveReader = await createFixtureUser("敏感读者A");
    await assignRoleByKey(sensitiveReader.id, `${RUN_TAG}_SENSITIVE_A`, campusA.id);

    const studentA = await createFixtureUser("敏感语义学生A");
    const verificationA = await createVerificationFixture({
      userId: studentA.id,
      campusId: campusA.id,
      options: { withEvidenceAsset: true },
    });
    const assetAId = (
      await rawClient!.uploadedAsset.findFirstOrThrow({
        where: { verificationId: verificationA.id },
      })
    ).id;
    const reportAsset = await createNonVerificationPrivateAsset(studentA.id);

    const studentB = await createFixtureUser("敏感语义学生B");
    const verificationB = await createVerificationFixture({
      userId: studentB.id,
      campusId: campusB.id,
      options: { withEvidenceAsset: true },
    });
    const assetBId = (
      await rawClient!.uploadedAsset.findFirstOrThrow({
        where: { verificationId: verificationB.id },
      })
    ).id;

    // sensitive.read@A：VERIFICATION 资产 A 允许（与 evidence.read 并列 OR）
    expect((await resolvePrivateAssetAccess(assetAId, { id: sensitiveReader.id })).ok).toBe(true);
    // 非 VERIFICATION 私有资产 A 也允许（既有语义：campus 精确匹配）
    expect((await resolvePrivateAssetAccess(reportAsset.id, { id: sensitiveReader.id })).ok).toBe(true);
    // campus B 资产拒绝（campus 精确语义保留）
    expect(
      (await resolvePrivateAssetAccess(assetBId, { id: sensitiveReader.id })),
    ).toMatchObject({ ok: false, reason: "forbidden" });
  });

  it("E06：证据权限路径的审计触发合同保留（grantedBy=permission + category=VERIFICATION）", async () => {
    // content 路由的敏感访问审计（VERIFICATION_ASSET_ACCESSED）以
    // grantedBy=permission ∧ category=VERIFICATION 为触发条件——新权限路径
    // 必须保持同一触发形态（HTTP 层审计由 route 单测/E2E 覆盖）。
    const { resolvePrivateAssetAccess } = await import("@/lib/asset-service");
    const reviewer = await createFixtureUser("审计合同审核员");
    await assignRoleByKey(reviewer.id, "CAMPUS_VERIFICATION_REVIEWER", campusA.id);
    const student = await createFixtureUser("审计合同学生");
    const verification = await createVerificationFixture({
      userId: student.id,
      campusId: campusA.id,
      options: { withEvidenceAsset: true },
    });
    const assetId = (
      await rawClient!.uploadedAsset.findFirstOrThrow({
        where: { verificationId: verification.id },
      })
    ).id;
    const result = await resolvePrivateAssetAccess(assetId, { id: reviewer.id });
    expect(result).toMatchObject({ ok: true, grantedBy: "permission" });
    if (result.ok) {
      expect(result.asset.category).toBe("VERIFICATION");
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// D01..D06：认证详情两阶段读（最小锚点先行 / 失败路径零敏感查询）
// ══════════════════════════════════════════════════════════════════════════

describe.skipIf(!integrationDatabaseUrl)("Phase 7F 认证详情两阶段读", () => {
  it("D01..D06：最小锚点先行；未授权/missing/inactive 失败路径零敏感查询；授权后 Stage B", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { loadAuthorizedVerificationDetail } = await import(
      "@/lib/campus/verification-review-query"
    );
    const { deriveVerificationReviewAccess } = await import("@/lib/campus/verification-review-access");
    const { loadAuthorizationContext } = await import("@/lib/rbac/service");

    const reviewerA = await createFixtureUser("两阶段审核员A");
    await assignRoleByKey(reviewerA.id, "CAMPUS_VERIFICATION_REVIEWER", campusA.id);
    const accessA = deriveVerificationReviewAccess(await loadAuthorizationContext(reviewerA.id));

    const student = await createFixtureUser("两阶段学生");
    const verification = await createVerificationFixture({
      userId: student.id,
      campusId: campusA.id,
      options: { withEvidenceAsset: true },
    });

    // 扩展客户端（软删除拦截）上的方法不能直接 spyOn（passthrough 会丢结果）：
    // 显式委托到同库的 raw client（UserVerification 不在软删除模型集内，
    // 两客户端行为等价），换取调用计数与参数快照。
    const findUniqueSpy = vi
      .spyOn(prisma.userVerification, "findUnique")
      .mockImplementation(
        ((args: Prisma.UserVerificationFindUniqueArgs) =>
          rawClient!.userVerification.findUnique(args)) as unknown as typeof prisma.userVerification.findUnique,
      );

    // D01+D05：授权路径——首个查询是最小锚点（select 恰为 Stage A 字段），
    // 第二个查询才是敏感水合
    findUniqueSpy.mockClear();
    const authorized = await loadAuthorizedVerificationDetail({
      access: accessA,
      verificationId: verification.id,
    });
    expect(authorized.ok).toBe(true);
    if (authorized.ok) {
      expect(authorized.detail.studentIdLast4).toBe("9999");
      expect(authorized.detail.studentCardImageRef).toMatch(/^asset:/);
    }
    expect(findUniqueSpy).toHaveBeenCalledTimes(2);
    const stageACall = findUniqueSpy.mock.calls[0][0] as {
      select?: Record<string, unknown>;
    };
    expect(Object.keys(stageACall.select ?? {})).toEqual(
      expect.arrayContaining(["id", "status", "membership"]),
    );
    const stageASelectKeys = Object.keys(
      ((stageACall.select as { membership?: { select?: Record<string, unknown> } }).membership ?? {})
        .select ?? {},
    );
    expect(JSON.stringify(stageACall.select)).not.toContain("studentIdLast4");
    expect(JSON.stringify(stageACall.select)).not.toContain("studentCardImage");
    expect(JSON.stringify(stageACall.select)).not.toContain("reviewNote");
    expect(stageASelectKeys).toEqual(expect.arrayContaining(["campusId", "status"]));

    // D02：未授权（campus B 审核 B 的视角）→ 恰一次锚点查询、零敏感查询
    const reviewerB = await createFixtureUser("两阶段审核员B", { membershipCampusId: campusB.id });
    await assignRoleByKey(reviewerB.id, "CAMPUS_VERIFICATION_REVIEWER", campusB.id);
    const accessB = deriveVerificationReviewAccess(await loadAuthorizationContext(reviewerB.id));
    findUniqueSpy.mockClear();
    const denied = await loadAuthorizedVerificationDetail({
      access: accessB,
      verificationId: verification.id,
    });
    expect(denied).toEqual({ ok: false });
    expect(findUniqueSpy).toHaveBeenCalledTimes(1);

    // D03：missing → 恰一次查询、同形 { ok:false }
    findUniqueSpy.mockClear();
    const missing = await loadAuthorizedVerificationDetail({
      access: accessA,
      verificationId: "p7f-ghost-verification",
    });
    expect(missing).toEqual({ ok: false });
    expect(findUniqueSpy).toHaveBeenCalledTimes(1);

    // D04：inactive membership → 恰一次查询、同形 { ok:false }
    const inactiveStudent = await createFixtureUser("两阶段失效学生", { membershipCampusId: null });
    const inactiveVerification = await createVerificationFixture({
      userId: inactiveStudent.id,
      campusId: campusA.id,
      options: { membershipStatus: "SUSPENDED" },
    });
    findUniqueSpy.mockClear();
    const inactive = await loadAuthorizedVerificationDetail({
      access: accessA,
      verificationId: inactiveVerification.id,
    });
    expect(inactive).toEqual({ ok: false });
    expect(findUniqueSpy).toHaveBeenCalledTimes(1);

    // D06：无存在性 oracle——missing / 未授权 / inactive 三种 { ok:false } 同形
    expect(denied).toEqual(missing);
    expect(missing).toEqual(inactive);

    findUniqueSpy.mockRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// V-RACE-01..07 + NO_40P01：真实 PG 并发（racePoint seam + advisory waiter）
// ══════════════════════════════════════════════════════════════════════════

describe.skipIf(!integrationDatabaseUrl)("Phase 7F 认证审核并发（真实 PG 治理锁）", () => {
  let scenarioSeq = 0;

  /** 每用例独立场景：campus A 审核 PENDING 认证。 */
  async function createRaceScenario() {
    scenarioSeq += 1;
    const reviewer = await createFixtureUser(`竞态审核员${scenarioSeq}`);
    await assignRoleByKey(reviewer.id, "CAMPUS_VERIFICATION_REVIEWER", campusA.id);
    const student = await createFixtureUser(`竞态学生${scenarioSeq}`);
    const verification = await createVerificationFixture({
      userId: student.id,
      campusId: campusA.id,
    });
    return { reviewer, student, verification };
  }

  /**
   * 竞态闸门（6B/7E 同款确定性协议，零 sleep）：
   * racePoint 先 signal（证明 T1 已真实取得治理锁），再等待 barrier；
   * 测试侧 await locked 后才启动 T2，随后用 advisory waiter 证明 T2 阻塞。
   */
  function raceGate() {
    let signal!: () => void;
    const locked = new Promise<void>((resolve) => {
      signal = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const racePoint = async () => {
      signal();
      await barrier;
    };
    return { locked, release, racePoint };
  }

  /** NO_40P01：任何拒绝原因都不得是 PG serialization failure。 */
  function assertNoSerializationFailure(errors: unknown[]) {
    for (const error of errors) {
      expect(String((error as Error)?.message ?? error)).not.toContain("40P01");
    }
  }

  it("V-RACE-01：两审核员并发决定同一 PENDING → 恰一合法 winner", async () => {
    const { waitForAdvisoryLockWaiter } = await import("./helpers/lock-barrier");
    const { decideMembershipVerification } = await import("@/lib/campus/verification-service");
    const { isRbacError } = await import("@/lib/rbac/errors");

    const { reviewer, student, verification } = await createRaceScenario();
    const reviewer2 = await createFixtureUser("竞态审核员1b");
    await assignRoleByKey(reviewer2.id, "CAMPUS_VERIFICATION_REVIEWER", campusA.id);

    const t1 = raceGate();
    const winnerPromise = decideMembershipVerification({
      actorId: reviewer.id,
      verificationId: verification.id,
      decision: "VERIFIED",
      racePoint: t1.racePoint,
    });
    await t1.locked;

    // T2 启动后阻塞在 USER:target 治理锁（T1 持有中）→ waiter 证明后放行 T1
    const loserPromise = decideMembershipVerification({
      actorId: reviewer2.id,
      verificationId: verification.id,
      decision: "REJECTED",
    }).then(
      () => "fulfilled" as const,
      (error: unknown) => error,
    );
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${student.id}`]);

    t1.release();
    const winner = await winnerPromise;
    const loser = await loserPromise;

    expect(winner.status).toBe("VERIFIED");
    expect(isRbacError(loser)).toBe(true);
    expect((loser as { code: string }).code).toBe("VERIFICATION_INVALID_TRANSITION");
    assertNoSerializationFailure([loser]);

    const row = await rawClient!.userVerification.findUniqueOrThrow({ where: { id: verification.id } });
    expect(row.status).toBe("VERIFIED");
    expect(row.reviewedById).toBe(reviewer.id);
    const audits = await rawClient!.adminLog.findMany({
      where: { targetType: "USER_VERIFICATION", targetId: verification.id, action: { in: ["APPROVE_VERIFICATION", "REJECT_VERIFICATION"] } },
    });
    expect(audits).toHaveLength(1);
  }, 30_000);

  it("V-RACE-02：角色撤回先赢 → 审核被拒 + 零决定副作用", async () => {
    const { waitForAdvisoryLockWaiter } = await import("./helpers/lock-barrier");
    const { decideMembershipVerification } = await import("@/lib/campus/verification-service");
    const { revokeRole } = await import("@/lib/rbac/assignment-service");
    const { isRbacError } = await import("@/lib/rbac/errors");

    const { reviewer, student, verification } = await createRaceScenario();

    const t1 = raceGate();
    const revokePromise = revokeRole({
      actorId: globalAdmin.id,
      targetUserId: reviewer.id,
      roleKey: "CAMPUS_VERIFICATION_REVIEWER",
      campusId: campusA.id,
      racePoint: t1.racePoint,
    });
    await t1.locked;

    // T2：审核阻塞在 USER:reviewer 治理锁（撤回事务持有中）
    const reviewPromise = decideMembershipVerification({
      actorId: reviewer.id,
      verificationId: verification.id,
      decision: "VERIFIED",
    }).then(
      () => "fulfilled" as const,
      (error: unknown) => error,
    );
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${reviewer.id}`]);

    t1.release();
    const revokeResult = await revokePromise;
    const review = await reviewPromise;

    expect(revokeResult).toMatchObject({ removed: true });
    expect(isRbacError(review)).toBe(true);
    expect((review as { code: string }).code).toBe("AUTH_PERMISSION_DENIED");
    assertNoSerializationFailure([review]);

    // 零决定副作用：状态/审计/投影全部未变
    const row = await rawClient!.userVerification.findUniqueOrThrow({ where: { id: verification.id } });
    expect(row.status).toBe("PENDING");
    expect(row.reviewedById).toBeNull();
    const user = await rawClient!.user.findUniqueOrThrow({ where: { id: student.id } });
    expect(user.verificationStatus).toBe("PENDING");
    const audits = await rawClient!.adminLog.count({
      where: { targetType: "USER_VERIFICATION", targetId: verification.id, action: { in: ["APPROVE_VERIFICATION", "REJECT_VERIFICATION", "REVOKE_VERIFICATION"] } },
    });
    expect(audits).toBe(0);
  }, 30_000);

  it("V-RACE-03：审核先赢 → 合法提交；撤回随后完成", async () => {
    const { waitForAdvisoryLockWaiter } = await import("./helpers/lock-barrier");
    const { decideMembershipVerification } = await import("@/lib/campus/verification-service");
    const { revokeRole } = await import("@/lib/rbac/assignment-service");

    const { reviewer, verification } = await createRaceScenario();

    const t1 = raceGate();
    const reviewPromise = decideMembershipVerification({
      actorId: reviewer.id,
      verificationId: verification.id,
      decision: "VERIFIED",
      racePoint: t1.racePoint,
    });
    await t1.locked;

    // T2：撤回阻塞在 USER:reviewer 治理锁（审核事务持有中）
    const revokePromise = revokeRole({
      actorId: globalAdmin.id,
      targetUserId: reviewer.id,
      roleKey: "CAMPUS_VERIFICATION_REVIEWER",
      campusId: campusA.id,
    });
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${reviewer.id}`]);

    t1.release();
    const review = await reviewPromise;
    const revokeResult = await revokePromise;

    expect(review.status).toBe("VERIFIED");
    expect(revokeResult).toMatchObject({ removed: true });

    const row = await rawClient!.userVerification.findUniqueOrThrow({ where: { id: verification.id } });
    expect(row.status).toBe("VERIFIED");
    expect(row.reviewedById).toBe(reviewer.id);
  }, 30_000);

  it("V-RACE-04：membership 停用先赢 → 审核 MEMBERSHIP_NOT_ACTIVE", async () => {
    const { waitForAdvisoryLockWaiter } = await import("./helpers/lock-barrier");
    const { decideMembershipVerification } = await import("@/lib/campus/verification-service");
    const { suspendCampusMembership } = await import("@/lib/enforcement/membership-enforcement-service");
    const { isRbacError } = await import("@/lib/rbac/errors");

    const { reviewer, student, verification } = await createRaceScenario();

    const t1 = raceGate();
    const suspendPromise = suspendCampusMembership({
      actorId: globalAdmin.id,
      targetUserId: student.id,
      campusId: campusA.id,
      reasonCode: "MANUAL_REVIEW",
      racePoint: t1.racePoint,
    });
    await t1.locked;

    // T2：审核阻塞在 USER:target 治理锁（membership 停用事务持有中）
    const reviewPromise = decideMembershipVerification({
      actorId: reviewer.id,
      verificationId: verification.id,
      decision: "VERIFIED",
    }).then(
      () => "fulfilled" as const,
      (error: unknown) => error,
    );
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${student.id}`]);

    t1.release();
    const suspension = await suspendPromise;
    const review = await reviewPromise;

    expect(membershipSuspensionApplied(suspension)).toBe(true);
    expect(isRbacError(review)).toBe(true);
    expect((review as { code: string }).code).toBe("MEMBERSHIP_NOT_ACTIVE");
    assertNoSerializationFailure([review]);

    const row = await rawClient!.userVerification.findUniqueOrThrow({ where: { id: verification.id } });
    expect(row.status).toBe("PENDING");
  }, 30_000);

  it("V-RACE-05：审核先赢 → 决定先提交；membership 停用随后", async () => {
    const { waitForAdvisoryLockWaiter } = await import("./helpers/lock-barrier");
    const { decideMembershipVerification } = await import("@/lib/campus/verification-service");
    const { suspendCampusMembership } = await import("@/lib/enforcement/membership-enforcement-service");

    const { reviewer, student, verification } = await createRaceScenario();

    const t1 = raceGate();
    const reviewPromise = decideMembershipVerification({
      actorId: reviewer.id,
      verificationId: verification.id,
      decision: "VERIFIED",
      racePoint: t1.racePoint,
    });
    await t1.locked;

    // T2：membership 停用阻塞在 USER:target 治理锁（审核事务持有中）
    const suspendPromise = suspendCampusMembership({
      actorId: globalAdmin.id,
      targetUserId: student.id,
      campusId: campusA.id,
      reasonCode: "MANUAL_REVIEW",
    });
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${student.id}`]);

    t1.release();
    const review = await reviewPromise;
    const suspension = await suspendPromise;

    expect(review.status).toBe("VERIFIED");
    expect(membershipSuspensionApplied(suspension)).toBe(true);

    const row = await rawClient!.userVerification.findUniqueOrThrow({ where: { id: verification.id } });
    expect(row.status).toBe("VERIFIED");
    const membership = await rawClient!.campusMembership.findFirstOrThrow({
      where: { userId: student.id, campusId: campusA.id },
    });
    expect(membership.status).toBe("SUSPENDED");
  }, 30_000);

  it("V-RACE-06：账号注销先赢 → 审核被拒（fail closed）+ 零决定副作用", async () => {
    const { waitForAdvisoryLockWaiter } = await import("./helpers/lock-barrier");
    const { decideMembershipVerification } = await import("@/lib/campus/verification-service");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");
    const { isRbacError } = await import("@/lib/rbac/errors");

    const { reviewer, student, verification } = await createRaceScenario();

    const t1 = raceGate();
    const erasePromise = eraseAccount(student.id, undefined, t1.racePoint);
    await t1.locked;

    // T2：审核阻塞在 USER:target 治理锁（注销事务持有中）
    const reviewPromise = decideMembershipVerification({
      actorId: reviewer.id,
      verificationId: verification.id,
      decision: "VERIFIED",
    }).then(
      () => "fulfilled" as const,
      (error: unknown) => error,
    );
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${student.id}`]);

    t1.release();
    const erased = await erasePromise;
    const review = await reviewPromise;

    expect(erased.erasedAt).toBeTruthy();
    expect(isRbacError(review)).toBe(true);
    // 注销后的拒绝码：membership 已失效或账号已不可用（两者均 fail closed，
    // 不泄露更多结构）
    expect(["MEMBERSHIP_NOT_ACTIVE", "AUTH_ACCOUNT_INACTIVE", "VERIFICATION_NOT_FOUND"]).toContain(
      (review as { code: string }).code,
    );
    assertNoSerializationFailure([review]);

    // 零决定副作用：erasure 的匿名化（status → UNVERIFIED、材料清除）是
    // canonical 注销语义，不属于审核决定——决定者/审计/决定时间必须为空
    const row = await rawClient!.userVerification.findUniqueOrThrow({ where: { id: verification.id } });
    expect(row.reviewedById).toBeNull();
    expect(row.reviewedAt).toBeNull();
    const decisionAudits = await rawClient!.adminLog.count({
      where: {
        targetType: "USER_VERIFICATION",
        targetId: verification.id,
        action: { in: ["APPROVE_VERIFICATION", "REJECT_VERIFICATION", "REVOKE_VERIFICATION"] },
      },
    });
    expect(decisionAudits).toBe(0);
  }, 30_000);

  it("V-RACE-07：重提交 vs 审核 → 串行化 canonical 终态（决定提交后重提交合法重置）", async () => {
    const { waitForAdvisoryLockWaiter } = await import("./helpers/lock-barrier");
    const { decideMembershipVerification, submitMembershipVerification } = await import(
      "@/lib/campus/verification-service"
    );

    const { reviewer, student, verification } = await createRaceScenario();

    const t1 = raceGate();
    const reviewPromise = decideMembershipVerification({
      actorId: reviewer.id,
      verificationId: verification.id,
      decision: "VERIFIED",
      racePoint: t1.racePoint,
    });
    await t1.locked;

    // T2：重提交阻塞在 USER:target 治理锁（审核事务持有中）
    const resubmitPromise = submitMembershipVerification({
      userId: student.id,
      schoolName: "集成测试大学",
      campusName: "A校区",
      studentIdLast4: "7777",
      studentCardImageToken: "https://example.com/card-again.jpg",
    });
    await waitForAdvisoryLockWaiter(rawClient!, [`USER:${student.id}`]);

    t1.release();
    const review = await reviewPromise;
    const resubmitted = await resubmitPromise;

    // 串行化结果：决定先提交（VERIFIED），随后重提交按状态机合法回到 PENDING
    expect(review.status).toBe("VERIFIED");
    expect(resubmitted.status).toBe("PENDING");
    expect(resubmitted.id).toBe(verification.id);
    expect(
      resubmitted.reviewDueAt.getTime() - resubmitted.submittedAt.getTime(),
    ).toBe(48 * 60 * 60 * 1000);
    const user = await rawClient!.user.findUniqueOrThrow({ where: { id: student.id } });
    expect(user.verificationStatus).toBe("PENDING");
    expect(user.studentIdLast4).toBe("7777");
  }, 30_000);

  it("NO_40P01：全部并发用例无 serialization failure（锁序无死锁环回归哨兵）", async () => {
    // 锁序合同回归哨兵：decide 的锁集（sorted {USER:actor, USER:target}）必须
    // 与 submit/erasure/membership/assignment 同一命名空间排序——用一次性
    // 并发四个治理动作验证无 40P01/死锁（超时即失败）。
    const { decideMembershipVerification } = await import("@/lib/campus/verification-service");
    const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
    const { revokeRole } = await import("@/lib/rbac/assignment-service");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");

    const { reviewer, verification } = await createRaceScenario();
    const bystander = await createFixtureUser("并发旁观者");

    const t1 = raceGate();
    const reviewPromise = decideMembershipVerification({
      actorId: reviewer.id,
      verificationId: verification.id,
      decision: "VERIFIED",
      racePoint: t1.racePoint,
    });
    await t1.locked;

    // 多路并发治理动作（不同目标，无环）：各自独立完成或结构化拒绝
    const concurrent = await Promise.allSettled([
      suspendAccount({ actorId: globalAdmin.id, targetUserId: bystander.id, reasonCode: "MANUAL_REVIEW" }),
      revokeRole({
        actorId: globalAdmin.id,
        targetUserId: bystander.id,
        roleKey: "CAMPUS_VERIFICATION_REVIEWER",
        campusId: campusA.id,
      }),
      eraseAccount(bystander.id),
    ]);

    t1.release();
    const review = await reviewPromise;
    expect(review.status).toBe("VERIFIED");

    for (const outcome of concurrent) {
      if (outcome.status === "rejected") {
        expect(String((outcome.reason as Error)?.message ?? outcome.reason)).not.toContain("40P01");
        expect(String((outcome.reason as Error)?.message ?? outcome.reason)).not.toContain(
          "deadlock detected",
        );
      }
    }
  }, 30_000);
});

/** membership 停用结果的窄类型守卫（SUSPENDED = 已生效）。 */
function membershipSuspensionApplied(
  result: { status: string; alreadyInState: boolean } | "fulfilled",
): boolean {
  return typeof result === "object" && result.status === "SUSPENDED";
}
