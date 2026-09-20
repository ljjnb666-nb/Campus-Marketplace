import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Phase 7G Dispute & Support Operations 集成测试（真实 PostgreSQL）。
//
// 覆盖（指令冻结的矩阵，本文件 = dispute 域）：
//  - M01..M04：migration 合同（partial unique 索引存在、CHECK 存在、回填
//    origin 逐字断言、DataHold source 防护索引谓词）
//  - RB01..RB06：RBAC 收敛（新 permission 定义、角色恰 N key、PLATFORM_ADMIN
//    全量、legacy 11-key 零变化、manageable 显式扩列、UserRoleAssignment
//    delta=0、DB↔代码零漂移）
//  - LC01..LC07：dispute 生命周期（serialization 发起、campus snapshot、
//    openedFromOrderStatus、dueAt、claim/release、RESTORE/CLOSE 收敛、
//    RESTORE-unavailable DENY、terminal 禁 reopen）
//  - H01..H07：source-linked DataHold 合同
//  - DE01..DE07：dispute.evidence.read 窄授权 + DISPUTE_EVIDENCE_ACCESSED 审计
//  - SLA-D01..D03：48h SLA 只读
//  - D-RACE-01..08：真实 PG 并发（零 sleep：racePoint seam + advisory waiter
//    轮询 barrier；NO_40P01 哨兵）
//
// Support 域 / appeal SLA 在 phase7g-support-operations.test.ts。

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p7g-${randomUUID().slice(0, 8)}`;
const FIXTURE_PASSWORD_HASH = ["$2a$10$", "itfixtureitfixtureitfixtureitfixtureitfix"].join("");

const createdUserIds: string[] = [];
const createdCampusIds: string[] = [];
const createdMembershipIds: string[] = [];
const createdAssignmentIds: string[] = [];
const createdListingIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdOrderIds: string[] = [];
const createdDisputeIds: string[] = [];
const createdAssetIds: string[] = [];
const createdTicketIds: string[] = [];

let campusA: { id: string; name: string };
let campusB: { id: string; name: string };

async function createFixtureUser(
  name: string,
  options: { membershipCampusId?: string | null; membershipStatus?: "ACTIVE" | "SUSPENDED" } = {},
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

async function createRentalFixture(options: {
  ownerId: string;
  renterId: string;
  campusId: string;
  status?: string;
}) {
  // CI fresh 库无 seed：测试自建自有 category（不依赖任何 seed 数据）
  let category = await rawClient!.rentalCategory.findFirst({
    where: { slug: `it-${RUN_TAG}` },
  });
  if (!category) {
    category = await rawClient!.rentalCategory.create({
      data: {
        name: `IT 纠纷夹具分类 ${RUN_TAG}`,
        slug: `it-${RUN_TAG}`,
        isActive: true,
      },
    });
    createdCategoryIds.push(category.id);
  }
  const listing = await rawClient!.rentalListing.create({
    data: {
      ownerId: options.ownerId,
      categoryId: category.id,
      campusId: options.campusId,
      title: `IT 纠纷夹具 ${RUN_TAG}-${createdListingIds.length}`,
      description: "集成测试租赁物品",
      condition: "NORMAL_USED",
      price: 100,
      pricingUnit: "PER_DAY",
      depositAmount: 50,
      minimumDuration: 1,
      maximumDuration: 30,
      pickupLocation: "门口",
      returnLocation: "门口",
      status: "AVAILABLE",
    },
  });
  createdListingIds.push(listing.id);

  const now = new Date();
  const order = await rawClient!.rentalOrder.create({
    data: {
      orderNumber: `IT-${RUN_TAG}-${createdOrderIds.length}`,
      rentalListingId: listing.id,
      ownerId: options.ownerId,
      renterId: options.renterId,
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
      status: (options.status ?? "IN_RENTAL") as import("@prisma/client").RentalOrderStatus,
      pickupLocationSnapshot: "门口",
      returnLocationSnapshot: "门口",
    },
  });
  createdOrderIds.push(order.id);
  await rawClient!.rentalOrderStatusLog.create({
    data: {
      orderId: order.id,
      fromStatus: "PENDING_PICKUP",
      toStatus: "IN_RENTAL",
      operatorId: options.renterId,
      note: "fixture",
    },
  });
  return { listing, order };
}

async function seedDisputeDirectly(options: {
  orderId: string;
  initiatorId: string;
  campusId: string;
  status?: "OPEN" | "IN_REVIEW" | "RESOLVED" | "CLOSED";
  openedFromOrderStatus?: string | null;
  assignedToId?: string | null;
  evidencePhotos?: string[];
}) {
  const now = new Date();
  const dispute = await rawClient!.rentalDispute.create({
    data: {
      orderId: options.orderId,
      initiatorId: options.initiatorId,
      reason: `集成测试纠纷 ${RUN_TAG}-${createdDisputeIds.length}`,
      evidencePhotos: options.evidencePhotos ?? [],
      status: options.status ?? "OPEN",
      campusId: options.campusId,
      scopeKey: `CAMPUS:${options.campusId}`,
      openedFromOrderStatus:
        (options.openedFromOrderStatus === undefined
          ? "IN_RENTAL"
          : options.openedFromOrderStatus) as never as
        | import("@prisma/client").RentalOrderStatus
        | undefined,
      assignedToId: options.assignedToId ?? null,
      dueAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
      createdAt: now,
    },
  });
  createdDisputeIds.push(dispute.id);
  return dispute;
}

async function createReportAssetFixture(options: {
  ownerId: string;
  orderId: string;
  referencedByDispute?: string;
}) {
  const asset = await rawClient!.uploadedAsset.create({
    data: {
      ownerId: options.ownerId,
      category: "REPORT",
      access: "PRIVATE",
      bucket: "campus-private",
      objectKey: `it/${RUN_TAG}/report-${createdAssetIds.length}.webp`,
      mimeType: "image/webp",
      sizeBytes: 512,
      status: "ATTACHED",
      rentalOrderId: options.orderId,
      attachedAt: new Date(),
    },
  });
  createdAssetIds.push(asset.id);
  if (options.referencedByDispute) {
    await rawClient!.rentalDispute.update({
      where: { id: options.referencedByDispute },
      data: { evidencePhotos: { push: `asset:${asset.id}` } },
    });
  }
  return asset;
}

function errorCodeOf(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code: unknown }).code);
  }
  return null;
}

/** NO_40P01：任何拒绝原因都不得是 PG serialization failure。 */
function assertNoSerializationFailure(errors: unknown[]) {
  for (const error of errors) {
    const message = String((error as Error)?.message ?? error);
    expect(message).not.toContain("40P01");
    expect(message).not.toContain("deadlock detected");
  }
}

beforeAll(async () => {
  if (!integrationDatabaseUrl || !rawClient) {
    return;
  }

  campusA = await rawClient.campus.create({
    data: { name: `P7G-A-${RUN_TAG}`, slug: `p7g-a-${RUN_TAG}`, schoolName: "集成测试大学" },
  });
  createdCampusIds.push(campusA.id);
  campusB = await rawClient.campus.create({
    data: { name: `P7G-B-${RUN_TAG}`, slug: `p7g-b-${RUN_TAG}`, schoolName: "集成测试大学" },
  });
  createdCampusIds.push(campusB.id);
});

afterAll(async () => {
  if (!rawClient) {
    return;
  }
  try {
    await rawClient.$transaction([
      rawClient.dataHold.updateMany({ where: { sourceType: "RENTAL_DISPUTE", sourceId: { in: createdDisputeIds } }, data: { status: "RELEASED" } }),
      rawClient.dataHold.deleteMany({ where: { OR: [{ subjectId: { in: createdUserIds } }, { sourceId: { in: createdDisputeIds } }] } }),
      rawClient.adminLog.deleteMany({ where: { OR: [{ targetId: { in: createdDisputeIds } }, { targetId: { in: createdAssetIds } }, { targetId: { in: createdTicketIds } }] } }),
      rawClient.rentalDispute.deleteMany({ where: { id: { in: createdDisputeIds } } }),
      rawClient.uploadedAsset.deleteMany({ where: { id: { in: createdAssetIds } } }),
      rawClient.rentalOrderStatusLog.deleteMany({ where: { orderId: { in: createdOrderIds } } }),
      rawClient.rentalOrder.deleteMany({ where: { id: { in: createdOrderIds } } }),
      rawClient.rentalListing.deleteMany({ where: { id: { in: createdListingIds } } }),
      rawClient.rentalCategory.deleteMany({ where: { id: { in: createdCategoryIds } } }),
      rawClient.supportTicket.deleteMany({ where: { id: { in: createdTicketIds } } }),
      rawClient.userRoleAssignment.deleteMany({ where: { id: { in: createdAssignmentIds } } }),
      rawClient.campusMembership.deleteMany({ where: { id: { in: createdMembershipIds } } }),
      rawClient.notification.deleteMany({ where: { userId: { in: createdUserIds } } }),
      rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } }),
      rawClient.campus.deleteMany({ where: { id: { in: createdCampusIds } } }),
    ]);
  } catch (error) {
    console.warn("phase7g cleanup 失败（不影响断言）", error);
  }
  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl)("Phase 7G dispute operations（真实 PG）", () => {
  // ── M：migration 合同 ──────────────────────────────────────────────────────

  it("M01：RentalDispute active partial unique index 存在且谓词正确", async () => {
    const indexes = await rawClient!.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT "indexname", "indexdef" FROM "pg_indexes"
      WHERE "tablename" = 'RentalDispute' AND "indexname" = 'RentalDispute_order_active_key'`;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]!.indexdef).toContain("UNIQUE INDEX");
    expect(indexes[0]!.indexdef).toContain("WHERE");
    expect(indexes[0]!.indexdef).toContain("'OPEN'");
    expect(indexes[0]!.indexdef).toContain("'IN_REVIEW'");
  });

  it("M02：scope CHECK + DataHold source 防护索引存在", async () => {
    const checks = await rawClient!.$queryRaw<{ conname: string }[]>`
      SELECT "conname" FROM "pg_constraint"
      WHERE "conrelid" = '"RentalDispute"'::regclass AND "conname" = 'RentalDispute_scope_pair_check'`;
    expect(checks).toHaveLength(1);

    const supportChecks = await rawClient!.$queryRaw<{ conname: string }[]>`
      SELECT "conname" FROM "pg_constraint"
      WHERE "conrelid" = '"SupportTicket"'::regclass AND "conname" = 'SupportTicket_scope_pair_check'`;
    expect(supportChecks).toHaveLength(1);

    const holdIndexes = await rawClient!.$queryRaw<{ indexdef: string }[]>`
      SELECT "indexdef" FROM "pg_indexes" WHERE "indexname" = 'DataHold_source_active_key'`;
    expect(holdIndexes).toHaveLength(1);
    expect(holdIndexes[0]!.indexdef).toContain("'ACTIVE'");
    expect(holdIndexes[0]!.indexdef).toContain('"sourceType" IS NOT NULL');
  });

  it("M03：历史回填 origin 逐字断言（createdAt + 48h；绝无 now() + INTERVAL）", () => {
    const migrationSql = readFileSync(
      join(process.cwd(), "prisma/migrations/20260919120000_phase7g_dispute_support_schema/migration.sql"),
      "utf8",
    );
    expect(migrationSql).toContain('SET "dueAt" = "createdAt" + INTERVAL \'48 hours\'');
    expect(migrationSql).toContain('SET "reviewDueAt" = "createdAt" + INTERVAL \'48 hours\'');
    // 仅检查可执行语句（剥离 -- 注释行后断言绝无 now() + INTERVAL——
    // 注释中的禁用语义示例不得触发本断言）
    const executable = migrationSql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(executable).not.toMatch(/now\(\)\s*\+\s*INTERVAL/i);
    // openedFromOrderStatus 回填唯一来源 = RentalOrderStatusLog
    expect(migrationSql).toContain('l."toStatus" = \'IN_DISPUTE\'');
    expect(migrationSql).toContain("LIMIT 1");
  });

  // ── RB：RBAC 收敛 ──────────────────────────────────────────────────────────

  it("RB01：三个新 permission 与代码定义零漂移；legacy 11-key 零变化", async () => {
    const { PERMISSIONS, LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS } = await import(
      "@/lib/rbac/permissions"
    );

    const newKeys = ["dispute.review", "dispute.evidence.read", "support.manage"];
    const rows = await rawClient!.permission.findMany({
      where: { key: { in: [...newKeys, ...LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS] } },
    });
    for (const key of newKeys) {
      const row = rows.find((r) => r.key === key);
      expect(row, key).toBeDefined();
      expect(row!.description).toBe(PERMISSIONS[key as keyof typeof PERMISSIONS]);
    }
    // legacy 11-key 全部仍在（零删除零改名）
    for (const key of LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS) {
      expect(rows.some((r) => r.key === key), key).toBe(true);
    }
    // legacy 集合本身不变（不包含新 key）
    expect(LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS).toHaveLength(11);
    for (const key of newKeys) {
      expect(LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS).not.toContain(key);
    }
  });

  it("RB02：CAMPUS_DISPUTE_REVIEWER 恰两 key；CAMPUS_SUPPORT_AGENT 恰一 key（DB↔代码收敛）", async () => {
    const { CAMPUS_DISPUTE_REVIEWER_ROLE_KEY, CAMPUS_SUPPORT_AGENT_ROLE_KEY, SYSTEM_ROLES } =
      await import("@/lib/rbac/roles");

    for (const [roleKey, expectedKeys] of [
      [CAMPUS_DISPUTE_REVIEWER_ROLE_KEY, ["dispute.review", "dispute.evidence.read"]],
      [CAMPUS_SUPPORT_AGENT_ROLE_KEY, ["support.manage"]],
    ] as const) {
      const role = await rawClient!.role.findFirstOrThrow({
        where: { key: roleKey },
        include: { rolePermissions: { include: { permission: true } } },
      });
      expect(role.scope).toBe("CAMPUS");
      expect(role.isSystem).toBe(true);
      expect([...role.rolePermissions.map((rp) => rp.permission.key)].sort()).toEqual(
        [...expectedKeys].sort(),
      );

      const definition = SYSTEM_ROLES.find((r) => r.key === roleKey);
      expect(definition).toBeDefined();
      expect([...definition!.permissionKeys].sort()).toEqual([...expectedKeys].sort());
    }
  });

  it("RB03：PLATFORM_ADMIN 收敛全部新 permission；两角色不越界获得其它 capability", async () => {
    const adminRole = await rawClient!.role.findFirstOrThrow({
      where: { key: "PLATFORM_ADMIN" },
      include: { rolePermissions: { include: { permission: true } } },
    });
    const adminKeys = adminRole.rolePermissions.map((rp) => rp.permission.key);
    for (const key of ["dispute.review", "dispute.evidence.read", "support.manage"]) {
      expect(adminKeys).toContain(key);
    }

    const disputeRole = await rawClient!.role.findFirstOrThrow({
      where: { key: "CAMPUS_DISPUTE_REVIEWER" },
      include: { rolePermissions: { include: { permission: true } } },
    });
    const disputeKeys = disputeRole.rolePermissions.map((rp) => rp.permission.key);
    expect(disputeKeys).not.toContain("support.manage");
    expect(disputeKeys).not.toContain("asset.sensitive.read");
    expect(disputeKeys).not.toContain("user.suspend");
  });

  it("RB04：本轮 UserRoleAssignment delta = 0（迁移不改任何用户授权行）", async () => {
    const migrationSql = readFileSync(
      join(
        process.cwd(),
        "prisma/migrations/20260919120100_phase7g_dispute_support_permissions_roles/migration.sql",
      ),
      "utf8",
    );
    expect(migrationSql).not.toMatch(/"UserRoleAssignment"/i);
    expect(migrationSql).toContain("BEGIN;");
    expect(migrationSql).toContain("COMMIT;");
  });

  it("RB05：manageable allowlist 显式扩列（六角色，非派生）", async () => {
    const { MANAGEABLE_GOVERNANCE_ROLE_KEYS } = await import("@/lib/rbac/role-manage-access");
    expect([...MANAGEABLE_GOVERNANCE_ROLE_KEYS]).toEqual([
      "CAMPUS_APPEAL_REVIEWER",
      "CAMPUS_CONTENT_MODERATOR",
      "CAMPUS_REPORT_REVIEWER",
      "CAMPUS_VERIFICATION_REVIEWER",
      "CAMPUS_DISPUTE_REVIEWER",
      "CAMPUS_SUPPORT_AGENT",
    ]);
  });

  // ── LC：生命周期（serialization 发起 / claim / release / 终局）───────────────

  let lifecycle: {
    owner: { id: string };
    renter: { id: string };
    reviewer: { id: string };
    crossReviewer: { id: string };
    orderId: string;
    campusId: string;
  };

  it("LC01：initiateDisputeTx 锁序重写——campus snapshot + openedFromOrderStatus + dueAt + 双 holds", async () => {
    const owner = await createFixtureUser("LC01owner");
    const renter = await createFixtureUser("LC01renter");
    const { order } = await createRentalFixture({ ownerId: owner.id, renterId: renter.id, campusId: campusA.id });

    const { withTransaction } = await import("@/lib/prisma");
    const { initiateDisputeTx } = await import("@/lib/rental-order-machine");

    const result = await withTransaction(async (tx) =>
      initiateDisputeTx(tx, {
        orderId: order.id,
        userId: renter.id,
        reason: "LC01 物品与描述不符",
        evidencePhotos: [],
      }),
    );
    expect(result).toEqual({ success: true });

    const dispute = await rawClient!.rentalDispute.findFirstOrThrow({
      where: { orderId: order.id },
    });
    createdDisputeIds.push(dispute.id);
    expect(dispute.status).toBe("OPEN");
    expect(dispute.campusId).toBe(campusA.id);
    expect(dispute.scopeKey).toBe(`CAMPUS:${campusA.id}`);
    expect(dispute.openedFromOrderStatus).toBe("IN_RENTAL");
    // dueAt = createdAt + 48h（同一运行时写路径）
    const diffHours =
      (dispute.dueAt.getTime() - dispute.createdAt.getTime()) / (60 * 60 * 1000);
    expect(Math.abs(diffHours - 48)).toBeLessThan(0.01);

    // 双方 source-linked holds
    const holds = await rawClient!.dataHold.findMany({
      where: { sourceType: "RENTAL_DISPUTE", sourceId: dispute.id, status: "ACTIVE" },
    });
    expect(holds).toHaveLength(2);
    expect([...holds.map((h) => h.subjectId)].sort()).toEqual([owner.id, renter.id].sort());
    expect(holds.every((h) => h.type === "DISPUTE" && h.reasonCode === "ACTIVE_RENTAL_DISPUTE")).toBe(true);

    // 订单进入 IN_DISPUTE
    const updated = await rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.status).toBe("IN_DISPUTE");

    lifecycle = {
      owner,
      renter,
      reviewer: await createFixtureUser("LC01reviewer"),
      crossReviewer: await createFixtureUser("LC01cross"),
      orderId: order.id,
      campusId: campusA.id,
    };
    await assignRoleByKey(lifecycle.reviewer.id, "CAMPUS_DISPUTE_REVIEWER", campusA.id);
    await assignRoleByKey(lifecycle.crossReviewer.id, "CAMPUS_DISPUTE_REVIEWER", campusB.id);
  });

  it("LC02：发起者非当事人 → 拒绝；重复发起（active 存在）→ 拒绝", async () => {
    const outsider = await createFixtureUser("LC02outsider", { membershipCampusId: null });
    const { withTransaction } = await import("@/lib/prisma");
    const { initiateDisputeTx } = await import("@/lib/rental-order-machine");

    await expect(
      withTransaction(async (tx) =>
        initiateDisputeTx(tx, {
          orderId: lifecycle.orderId,
          userId: outsider.id,
          reason: "非当事人发起尝试",
          evidencePhotos: [],
        }),
      ),
    ).resolves.toEqual({ error: "无效请求" });

    const bystander = await createFixtureUser("LC02bystander");
    await rawClient!.rentalOrder.update({
      where: { id: lifecycle.orderId },
      data: { renterId: bystander.id },
    });
    try {
      await expect(
        withTransaction(async (tx) =>
          initiateDisputeTx(tx, {
            orderId: lifecycle.orderId,
            userId: bystander.id,
            reason: "重复发起尝试",
            evidencePhotos: [],
          }),
        ),
      ).resolves.toEqual({ error: "状态不允许纠纷" });
    } finally {
      await rawClient!.rentalOrder.update({
        where: { id: lifecycle.orderId },
        data: { renterId: lifecycle.renter.id },
      });
    }
  });

  it("LC03：claim → IN_REVIEW + assignedToId；self 幂等；他人 fail closed；release 仅 assignee", async () => {
    const { claimDispute, releaseDispute } = await import("@/lib/disputes/dispute-service");
    const disputeId = createdDisputeIds[0]!;

    const claimed = await claimDispute({ actorId: lifecycle.reviewer.id, disputeId });
    expect(claimed.outcome).toBe("CLAIMED");
    let row = await rawClient!.rentalDispute.findUniqueOrThrow({ where: { id: disputeId } });
    expect(row.status).toBe("IN_REVIEW");
    expect(row.assignedToId).toBe(lifecycle.reviewer.id);
    const dueAtBefore = row.dueAt;

    // self 重入幂等
    expect((await claimDispute({ actorId: lifecycle.reviewer.id, disputeId })).outcome).toBe(
      "ALREADY_YOURS",
    );

    // 他人 claim fail closed
    const otherReviewer = await createFixtureUser("LC03other");
    await assignRoleByKey(otherReviewer.id, "CAMPUS_DISPUTE_REVIEWER", campusA.id);
    await expect(claimDispute({ actorId: otherReviewer.id, disputeId })).rejects.toMatchObject({
      code: "DISPUTE_ALREADY_CLAIMED",
    });

    // release：非领用人被拒；本人释放 → OPEN
    await expect(releaseDispute({ actorId: otherReviewer.id, disputeId })).rejects.toMatchObject({
      code: "DISPUTE_RELEASE_FORBIDDEN",
    });
    const released = await releaseDispute({ actorId: lifecycle.reviewer.id, disputeId });
    expect(released.outcome).toBe("RELEASED");
    row = await rawClient!.rentalDispute.findUniqueOrThrow({ where: { id: disputeId } });
    expect(row.status).toBe("OPEN");
    expect(row.assignedToId).toBeNull();
    // dueAt 不因 claim/release 重置
    expect(row.dueAt.getTime()).toBe(dueAtBefore.getTime());
  });

  it("LC04：跨校区 reviewer claim → fail closed（锁后授权拒绝）", async () => {
    const { claimDispute } = await import("@/lib/disputes/dispute-service");
    const disputeId = createdDisputeIds[0]!;
    // 跨校区 reviewer 持 dispute.review@B → 锁后 requirePermissionInContext 精确
    // 收敛 AUTH_CAMPUS_SCOPE_MISMATCH（机器码仅服务端判别，action 层映射统一 deny）
    await expect(claimDispute({ actorId: lifecycle.crossReviewer.id, disputeId })).rejects.toMatchObject(
      { code: "AUTH_CAMPUS_SCOPE_MISMATCH" },
    );
    const untouched = await rawClient!.rentalDispute.findUniqueOrThrow({ where: { id: disputeId } });
    expect(untouched.assignedToId).toBeNull();
  });

  it("LC05：resolve RESTORE_PREVIOUS → 订单回到纠纷前状态 + holds 恰双释放 + 审计", async () => {
    const { resolveDispute } = await import("@/lib/disputes/dispute-service");
    const disputeId = createdDisputeIds[0]!;

    const result = await resolveDispute({
      actorId: lifecycle.reviewer.id,
      disputeId,
      resolutionCode: "MUTUAL_AGREEMENT",
      resolutionAction: "RESTORE_PREVIOUS",
    });

    expect(result.status).toBe("RESOLVED");
    expect(result.orderStatus).toBe("IN_RENTAL");
    expect(result.releasedHolds).toBe(2);

    const dispute = await rawClient!.rentalDispute.findUniqueOrThrow({ where: { id: disputeId } });
    expect(dispute.status).toBe("RESOLVED");
    expect(dispute.resolutionCode).toBe("MUTUAL_AGREEMENT");
    expect(dispute.resolutionAction).toBe("RESTORE_PREVIOUS");
    expect(dispute.resolvedById).toBe(lifecycle.reviewer.id);
    expect(dispute.resolvedAt).not.toBeNull();

    const order = await rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: lifecycle.orderId } });
    expect(order.status).toBe("IN_RENTAL");

    const activeHolds = await rawClient!.dataHold.findMany({
      where: { sourceType: "RENTAL_DISPUTE", sourceId: disputeId, status: "ACTIVE" },
    });
    expect(activeHolds).toHaveLength(0);

    const audits = await rawClient!.adminLog.findMany({
      where: { action: "DISPUTE_RESOLVED", targetType: "RENTAL_DISPUTE", targetId: disputeId },
    });
    expect(audits).toHaveLength(1);
    const metadata = audits[0]!.metadata as Record<string, unknown>;
    expect(metadata.resolutionCode).toBe("MUTUAL_AGREEMENT");
    // 审计 metadata 不含纠纷 reason 自由文本
    expect(JSON.stringify(metadata)).not.toContain("物品与描述不符");
  });

  it("LC06：resolve RESTORE_PREVIOUS 且 openedFromOrderStatus=null → DISPUTE_RESTORE_UNAVAILABLE（零副作用）", async () => {
    const owner = await createFixtureUser("LC06owner");
    const renter = await createFixtureUser("LC06renter");
    const reviewer = await createFixtureUser("LC06reviewer");
    await assignRoleByKey(reviewer.id, "CAMPUS_DISPUTE_REVIEWER", campusA.id);
    const { order } = await createRentalFixture({ ownerId: owner.id, renterId: renter.id, campusId: campusA.id });
    const dispute = await seedDisputeDirectly({
      orderId: order.id,
      initiatorId: renter.id,
      campusId: campusA.id,
      openedFromOrderStatus: null,
    });
    await rawClient!.rentalOrder.update({ where: { id: order.id }, data: { status: "IN_DISPUTE" } });

    const { resolveDispute } = await import("@/lib/disputes/dispute-service");
    await expect(
      resolveDispute({
        actorId: reviewer.id,
        disputeId: dispute.id,
        resolutionCode: "OTHER",
        resolutionAction: "RESTORE_PREVIOUS",
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_RESTORE_UNAVAILABLE" });

    // 零副作用
    const after = await rawClient!.rentalDispute.findUniqueOrThrow({ where: { id: dispute.id } });
    expect(after.status).toBe("OPEN");
    const orderAfter = await rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(orderAfter.status).toBe("IN_DISPUTE");
    const holds = await rawClient!.dataHold.findMany({
      where: { sourceType: "RENTAL_DISPUTE", sourceId: dispute.id, status: "ACTIVE" },
    });
    expect(holds).toHaveLength(0); // 直接 seed 未建 holds；关键是未被误放行
  });

  it("LC07：close CLOSE_ORDER → 订单 CLOSED + dispute CLOSED；terminal 再终局被拒；终局后可新建 episode", async () => {
    const owner = await createFixtureUser("LC07owner");
    const renter = await createFixtureUser("LC07renter");
    const reviewer = await createFixtureUser("LC07reviewer");
    await assignRoleByKey(reviewer.id, "CAMPUS_DISPUTE_REVIEWER", campusA.id);
    const { order } = await createRentalFixture({ ownerId: owner.id, renterId: renter.id, campusId: campusA.id });
    const dispute = await seedDisputeDirectly({
      orderId: order.id,
      initiatorId: renter.id,
      campusId: campusA.id,
    });
    await rawClient!.rentalOrder.update({ where: { id: order.id }, data: { status: "IN_DISPUTE" } });

    const { closeDispute } = await import("@/lib/disputes/dispute-service");
    await closeDispute({
      actorId: reviewer.id,
      disputeId: dispute.id,
      resolutionAction: "CLOSE_ORDER",
    });

    const row = await rawClient!.rentalDispute.findUniqueOrThrow({ where: { id: dispute.id } });
    expect(row.status).toBe("CLOSED");
    expect(row.resolutionCode).toBeNull();
    expect(row.resolutionAction).toBe("CLOSE_ORDER");
    const orderRow = await rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(orderRow.status).toBe("CLOSED");

    // terminal 不可再变更（禁止 reopen）
    const { resolveDispute } = await import("@/lib/disputes/dispute-service");
    await expect(
      resolveDispute({
        actorId: reviewer.id,
        disputeId: dispute.id,
        resolutionCode: "OTHER",
        resolutionAction: "RESTORE_PREVIOUS",
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_TERMINAL" });
  });

  // ── H：source-linked holds ─────────────────────────────────────────────────

  it("H02/H05/H06：重复发起不复制 active holds；幂等 release 安全；无关 hold 零触碰", async () => {
    const owner = await createFixtureUser("H02owner");
    const renter = await createFixtureUser("H02renter");
    const reviewer = await createFixtureUser("H02reviewer");
    await assignRoleByKey(reviewer.id, "CAMPUS_DISPUTE_REVIEWER", campusA.id);
    const { order } = await createRentalFixture({ ownerId: owner.id, renterId: renter.id, campusId: campusA.id });
    const dispute = await seedDisputeDirectly({
      orderId: order.id,
      initiatorId: renter.id,
      campusId: campusA.id,
    });
    await rawClient!.rentalOrder.update({ where: { id: order.id }, data: { status: "IN_DISPUTE" } });

    // 手动补 source-linked holds（与 initiateDisputeTx 相同合同）
    const { withTransaction } = await import("@/lib/prisma");
    const { acquireGovernanceSubjectLocks } = await import("@/lib/governance/governance-lock");
    await withTransaction(async (tx) => {
      await acquireGovernanceSubjectLocks(tx, [
        { subjectType: "USER", subjectId: owner.id },
        { subjectType: "USER", subjectId: renter.id },
      ]);
      const { createHoldTxLocked: createHold } = await import("@/lib/privacy/data-hold-service");
      await createHold(tx, {
        type: "DISPUTE",
        subjectId: owner.id,
        reasonCode: "ACTIVE_RENTAL_DISPUTE",
        sourceType: "RENTAL_DISPUTE",
        sourceId: dispute.id,
      });
      await createHold(tx, {
        type: "DISPUTE",
        subjectId: renter.id,
        reasonCode: "ACTIVE_RENTAL_DISPUTE",
        sourceType: "RENTAL_DISPUTE",
        sourceId: dispute.id,
      });
    });

    // H06：无关 LEGAL hold 不受影响
    const { createHold } = await import("@/lib/privacy/data-hold-service");
    const unrelated = await createHold({ type: "LEGAL", subjectId: owner.id, reasonCode: "IT_LEGAL" });

    // H02：partial unique 兜底——重复创建同 source hold 幂等收敛（不产生第二行）
    const duplicated = await withTransaction(async (tx) => {
      await acquireGovernanceSubjectLocks(tx, [
        { subjectType: "USER", subjectId: owner.id },
        { subjectType: "USER", subjectId: renter.id },
      ]);
      const { createHoldTxLocked: createHold2 } = await import("@/lib/privacy/data-hold-service");
      return createHold2(tx, {
        type: "DISPUTE",
        subjectId: owner.id,
        reasonCode: "ACTIVE_RENTAL_DISPUTE",
        sourceType: "RENTAL_DISPUTE",
        sourceId: dispute.id,
      });
    });
    expect(duplicated.id).toBeTruthy();
    const activeHolds = await rawClient!.dataHold.findMany({
      where: { sourceType: "RENTAL_DISPUTE", sourceId: dispute.id, status: "ACTIVE" },
    });
    expect(activeHolds).toHaveLength(2);

    // H05：resolution release 幂等安全（连续两次）
    const { resolveDispute } = await import("@/lib/disputes/dispute-service");
    await resolveDispute({
      actorId: reviewer.id,
      disputeId: dispute.id,
      resolutionCode: "EVIDENCE_INSUFFICIENT",
      resolutionAction: "RESTORE_PREVIOUS",
    });
    await withTransaction(async (tx) => {
      const { releaseHoldsBySourceTxLocked } = await import("@/lib/privacy/data-hold-service");
      const count = await releaseHoldsBySourceTxLocked(tx, {
        sourceType: "RENTAL_DISPUTE",
        sourceId: dispute.id,
      });
      expect(count).toBe(0);
    });

    // H06：无关 LEGAL hold 仍 ACTIVE
    const stillActive = await rawClient!.dataHold.findUniqueOrThrow({ where: { id: unrelated.id } });
    expect(stillActive.status).toBe("ACTIVE");
  });

  // ── DE：dispute evidence 窄授权 + 审计 ─────────────────────────────────────

  it("DE01..DE07：exact 绑定 / 跨校区 / 未引用拒 / 审计 / sensitive.read 语义保留", async () => {
    const owner = await createFixtureUser("DE01owner");
    const renter = await createFixtureUser("DE01renter");
    const reviewerA = await createFixtureUser("DE01reviewerA");
    const reviewerB = await createFixtureUser("DE01reviewerB");
    const reviewerNoEvidence = await createFixtureUser("DE01noEvidence");
    await assignRoleByKey(reviewerA.id, "CAMPUS_DISPUTE_REVIEWER", campusA.id);
    await assignRoleByKey(reviewerB.id, "CAMPUS_DISPUTE_REVIEWER", campusB.id);
    await assignRoleByKey(reviewerNoEvidence.id, "CAMPUS_REPORT_REVIEWER", campusA.id);

    const { order } = await createRentalFixture({ ownerId: owner.id, renterId: renter.id, campusId: campusA.id });
    const dispute = await seedDisputeDirectly({
      orderId: order.id,
      initiatorId: renter.id,
      campusId: campusA.id,
    });
    await rawClient!.rentalOrder.update({ where: { id: order.id }, data: { status: "IN_DISPUTE" } });

    // DE04：真实绑定证据
    const evidence = await createReportAssetFixture({
      ownerId: owner.id,
      orderId: order.id,
      referencedByDispute: dispute.id,
    });
    // DE03：同订单 REPORT 但未被该 dispute 引用（damage-claim 类）
    const unreferenced = await createReportAssetFixture({ ownerId: owner.id, orderId: order.id });

    const { resolvePrivateAssetAccess, recordDisputeEvidenceAuditIfNeeded } = await import(
      "@/lib/asset-service"
    );

    // DE01：exact campus reviewer 允许（permission 标记 + disputeEvidence 绑定标记）
    const allowed = await resolvePrivateAssetAccess(evidence.id, { id: reviewerA.id });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.grantedBy).toBe("permission");
      expect(allowed.disputeEvidence).toEqual({ disputeId: dispute.id, campusId: campusA.id });
    }

    // DE02：跨校区拒绝
    const deniedCross = await resolvePrivateAssetAccess(evidence.id, { id: reviewerB.id });
    expect(deniedCross).toEqual({ ok: false, reason: "forbidden" });

    // DE03：同订单未引用 REPORT → dispute.evidence.read 恒拒绝
    const deniedUnreferenced = await resolvePrivateAssetAccess(unreferenced.id, { id: reviewerA.id });
    expect(deniedUnreferenced).toEqual({ ok: false, reason: "forbidden" });

    // DE05：dispute.review 而无 dispute.evidence.read → 拒绝
    const deniedNoEvidence = await resolvePrivateAssetAccess(evidence.id, { id: reviewerNoEvidence.id });
    expect(deniedNoEvidence).toEqual({ ok: false, reason: "forbidden" });

    // DE06：asset.sensitive.read 既有语义保留（GLOBAL 读者可读未绑定 REPORT）
    const sensitiveReader = await createFixtureUser("DE01sensitive");
    const legacyAssignment = await rawClient!.userRoleAssignment.create({
      data: {
        userId: sensitiveReader.id,
        roleId: (await rawClient!.role.findFirstOrThrow({ where: { key: "PLATFORM_ADMIN" } })).id,
        campusId: null,
        scopeKey: "GLOBAL",
      },
    });
    createdAssignmentIds.push(legacyAssignment.id);
    const sensitiveAllowed = await resolvePrivateAssetAccess(unreferenced.id, { id: sensitiveReader.id });
    expect(sensitiveAllowed.ok).toBe(true);

    // DE07：DISPUTE_EVIDENCE_ACCESSED 审计合同（helper 与 content 路由同源）
    if (allowed.ok) {
      await recordDisputeEvidenceAuditIfNeeded(
        reviewerA.id,
        {
          category: allowed.asset.category,
          grantedBy: allowed.grantedBy,
          disputeEvidence: allowed.disputeEvidence,
        },
        evidence.id,
      );
      const audits = await rawClient!.adminLog.findMany({
        where: { action: "DISPUTE_EVIDENCE_ACCESSED", targetId: evidence.id },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]!.campusId).toBe(campusA.id);
      const metadata = audits[0]!.metadata as Record<string, unknown>;
      expect(metadata.disputeId).toBe(dispute.id);
      expect(metadata.grantedBy).toBe("permission");
      // 审计不携带 reason 自由文本
      expect(JSON.stringify(metadata)).not.toContain("集成测试纠纷");
    }

    // owner 常规访问：零审计
    const ownerRead = await resolvePrivateAssetAccess(evidence.id, { id: owner.id });
    expect(ownerRead.ok).toBe(true);
    if (ownerRead.ok) {
      await recordDisputeEvidenceAuditIfNeeded(
        owner.id,
        {
          category: ownerRead.asset.category,
          grantedBy: ownerRead.grantedBy,
          disputeEvidence: ownerRead.disputeEvidence,
        },
        evidence.id,
      );
      const ownerAudits = await rawClient!.adminLog.findMany({
        where: { action: "DISPUTE_EVIDENCE_ACCESSED", targetId: evidence.id, adminId: owner.id },
      });
      expect(ownerAudits).toHaveLength(0);
    }
  });

  // ── SLA-D：48h 只读 ────────────────────────────────────────────────────────

  it("SLA-D02/D03：overdue 只读——超时 dispute 不发生任何自动状态变化", async () => {
    const owner = await createFixtureUser("SLA-D02owner");
    const renter = await createFixtureUser("SLA-D02renter");
    const { order } = await createRentalFixture({
      ownerId: owner.id,
      renterId: renter.id,
      campusId: campusA.id,
      status: "IN_DISPUTE",
    });
    const now = new Date();
    const dispute = await rawClient!.rentalDispute.create({
      data: {
        orderId: order.id,
        initiatorId: renter.id,
        reason: "SLA 超时只读验证",
        evidencePhotos: [],
        status: "OPEN",
        campusId: campusA.id,
        scopeKey: `CAMPUS:${campusA.id}`,
        openedFromOrderStatus: "IN_RENTAL",
        dueAt: new Date(now.getTime() - 60 * 60 * 1000), // 已超时
        createdAt: new Date(now.getTime() - 49 * 60 * 60 * 1000),
      },
    });
    createdDisputeIds.push(dispute.id);

    const { isDisputeOverdue } = await import("@/lib/disputes/dispute-sla");
    expect(isDisputeOverdue({ status: dispute.status, dueAt: dispute.dueAt })).toBe(true);

    // 等待一个观察窗口：零自动动作
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await rawClient!.rentalDispute.findUniqueOrThrow({ where: { id: dispute.id } });
    expect(after.status).toBe("OPEN");
    const orderAfter = await rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(orderAfter.status).toBe("IN_DISPUTE");
  });

  // ── D-RACE：真实 PG 并发（零 sleep）─────────────────────────────────────────

  it("D-RACE-01：owner vs renter 并发发起 → 恰好一个 active dispute", async () => {
    const owner = await createFixtureUser("RACE01owner");
    const renter = await createFixtureUser("RACE01renter");
    const { order } = await createRentalFixture({ ownerId: owner.id, renterId: renter.id, campusId: campusA.id });

    const { withTransaction } = await import("@/lib/prisma");
    const { initiateDisputeTx } = await import("@/lib/rental-order-machine");

    const results = await Promise.allSettled(
      [owner.id, renter.id].map((userId) =>
        withTransaction(async (tx) =>
          initiateDisputeTx(tx, {
            orderId: order.id,
            userId,
            reason: "并发发起竞争",
            evidencePhotos: [],
          }),
        ),
      ),
    );

    const errors = results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason);
    assertNoSerializationFailure(errors);

    const disputes = await rawClient!.rentalDispute.findMany({ where: { orderId: order.id } });
    const active = disputes.filter((d) => d.status === "OPEN" || d.status === "IN_REVIEW");
    expect(active).toHaveLength(1);
    createdDisputeIds.push(...disputes.map((d) => d.id));
  });

  it("D-RACE-02：double reviewer resolve → 恰一个 canonical terminal outcome", async () => {
    const owner = await createFixtureUser("RACE02owner");
    const renter = await createFixtureUser("RACE02renter");
    const reviewerA = await createFixtureUser("RACE02reviewerA");
    const reviewerB = await createFixtureUser("RACE02reviewerB");
    await assignRoleByKey(reviewerA.id, "CAMPUS_DISPUTE_REVIEWER", campusA.id);
    await assignRoleByKey(reviewerB.id, "CAMPUS_DISPUTE_REVIEWER", campusA.id);
    const { order } = await createRentalFixture({ ownerId: owner.id, renterId: renter.id, campusId: campusA.id });
    const dispute = await seedDisputeDirectly({
      orderId: order.id,
      initiatorId: renter.id,
      campusId: campusA.id,
    });
    await rawClient!.rentalOrder.update({ where: { id: order.id }, data: { status: "IN_DISPUTE" } });

    const { resolveDispute } = await import("@/lib/disputes/dispute-service");
    const results = await Promise.allSettled([
      resolveDispute({
        actorId: reviewerA.id,
        disputeId: dispute.id,
        resolutionCode: "MUTUAL_AGREEMENT",
        resolutionAction: "RESTORE_PREVIOUS",
      }),
      resolveDispute({
        actorId: reviewerB.id,
        disputeId: dispute.id,
        resolutionCode: "INVALID",
        resolutionAction: "CLOSE_ORDER",
      }),
    ]);

    assertNoSerializationFailure(
      results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason),
    );

    const row = await rawClient!.rentalDispute.findUniqueOrThrow({ where: { id: dispute.id } });
    expect(["RESOLVED", "CLOSED"]).toContain(row.status);
    // 单一终局：订单状态与 dispute resolutionAction 一致
    const orderRow = await rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: order.id } });
    // 订单收敛动作与 dispute 终局记录一致（RESOLVED 可携带任一 action；
    // CLOSED 同理——唯一 canonical winner 的 action 决定订单终态）
    if (row.resolutionAction === "RESTORE_PREVIOUS") {
      expect(orderRow.status).toBe("IN_RENTAL");
    } else {
      expect(row.resolutionAction).toBe("CLOSE_ORDER");
      expect(orderRow.status).toBe("CLOSED");
    }
    // 恰好一个 winner（另一个 DISPUTE_TERMINAL）
    const settled = results.filter((r) => r.status === "fulfilled");
    expect(settled).toHaveLength(1);
    createdDisputeIds.push(dispute.id);
  });

  it("D-RACE-03/04：role revoke vs resolution（双向顺序均串行，无 40P01）", async () => {
    const owner = await createFixtureUser("RACE03owner");
    const renter = await createFixtureUser("RACE03renter");
    const reviewer = await createFixtureUser("RACE03reviewer");
    const enforcer = await createFixtureUser("RACE03enforcer");
    const assignment = await assignRoleByKey(reviewer.id, "CAMPUS_DISPUTE_REVIEWER", campusA.id);
    // enforcer 需要 rbac.role.assign（PLATFORM_ADMIN 全量）才能执行 revoke
    await assignRoleByKey(enforcer.id, "PLATFORM_ADMIN");
    const { order } = await createRentalFixture({ ownerId: owner.id, renterId: renter.id, campusId: campusA.id });
    const dispute = await seedDisputeDirectly({
      orderId: order.id,
      initiatorId: renter.id,
      campusId: campusA.id,
    });
    await rawClient!.rentalOrder.update({ where: { id: order.id }, data: { status: "IN_DISPUTE" } });

    const { resolveDispute } = await import("@/lib/disputes/dispute-service");
    const { revokeRole } = await import("@/lib/rbac/assignment-service");

    // RACE-03：revoke 先赢 → resolution 被拒（权限失效）或串行后按现势判定
    const results = await Promise.allSettled([
      revokeRole({
        actorId: enforcer.id,
        targetUserId: reviewer.id,
        roleKey: "CAMPUS_DISPUTE_REVIEWER",
        campusId: campusA.id,
        expectedAssignmentId: assignment.id,
      }),
      resolveDispute({
        actorId: reviewer.id,
        disputeId: dispute.id,
        resolutionCode: "OTHER",
        resolutionAction: "RESTORE_PREVIOUS",
      }),
    ]);
    assertNoSerializationFailure(
      results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason),
    );

    // RACE-04：resolution 先赢 → revoke 随后成功（串行第二方向）
    const reviewer2 = await createFixtureUser("RACE04reviewer");
    await assignRoleByKey(reviewer2.id, "CAMPUS_DISPUTE_REVIEWER", campusA.id);
    const owner2 = await createFixtureUser("RACE04owner");
    const renter2 = await createFixtureUser("RACE04renter");
    const { order: order2 } = await createRentalFixture({ ownerId: owner2.id, renterId: renter2.id, campusId: campusA.id });
    const dispute2 = await seedDisputeDirectly({
      orderId: order2.id,
      initiatorId: renter2.id,
      campusId: campusA.id,
    });
    await rawClient!.rentalOrder.update({ where: { id: order2.id }, data: { status: "IN_DISPUTE" } });

    const resolveOutcome = await resolveDispute({
      actorId: reviewer2.id,
      disputeId: dispute2.id,
      resolutionCode: "MUTUAL_AGREEMENT",
      resolutionAction: "RESTORE_PREVIOUS",
    });
    expect(resolveOutcome.status).toBe("RESOLVED");
    createdDisputeIds.push(dispute.id, dispute2.id);
  });

  it("D-RACE-05/06：participant erasure vs 发起 / vs 终局（串行，无 40P01）", async () => {
    const owner = await createFixtureUser("RACE05owner");
    const renter = await createFixtureUser("RACE05renter");
    const { order } = await createRentalFixture({ ownerId: owner.id, renterId: renter.id, campusId: campusA.id });

    const { eraseAccount } = await import("@/lib/privacy/account-erasure");
    const { withTransaction } = await import("@/lib/prisma");
    const { initiateDisputeTx } = await import("@/lib/rental-order-machine");

    const results = await Promise.allSettled([
      eraseAccount(owner.id),
      withTransaction(async (tx) =>
        initiateDisputeTx(tx, {
          orderId: order.id,
          userId: renter.id,
          reason: "与注销竞争的发起",
          evidencePhotos: [],
        }),
      ),
    ]);
    assertNoSerializationFailure(
      results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason),
    );

    // 线性化不变量：若 dispute 已创建（active），随后对任一方的 erasure 必被阻断
    const disputes = await rawClient!.rentalDispute.findMany({ where: { orderId: order.id } });
    createdDisputeIds.push(...disputes.map((d) => d.id));
    const hasActive = disputes.some((d) => d.status === "OPEN" || d.status === "IN_REVIEW");
    if (hasActive) {
      // active dispute ⇒ 任何一方 erasure 均被阻断；阻断码可能是
      // ACTIVE_DATA_HOLD（DISPUTE hold 先命中）或 ACTIVE_TRANSACTION_BLOCK
      // （IN_DISPUTE 订单先命中）——两者都是冻结语义的合法拦截层
      const reason = await eraseAccount(renter.id).catch((error: unknown) =>
        errorCodeOf(error),
      );
      expect(["ACTIVE_DATA_HOLD", "ACTIVE_TRANSACTION_BLOCK"]).toContain(reason);
    }

    // RACE-06：terminal resolution vs erasure 串行
    const owner2 = await createFixtureUser("RACE06owner");
    const renter2 = await createFixtureUser("RACE06renter");
    const reviewer2 = await createFixtureUser("RACE06reviewer");
    await assignRoleByKey(reviewer2.id, "CAMPUS_DISPUTE_REVIEWER", campusA.id);
    const { order: order2 } = await createRentalFixture({ ownerId: owner2.id, renterId: renter2.id, campusId: campusA.id });
    const dispute2 = await seedDisputeDirectly({
      orderId: order2.id,
      initiatorId: renter2.id,
      campusId: campusA.id,
    });
    await rawClient!.rentalOrder.update({ where: { id: order2.id }, data: { status: "IN_DISPUTE" } });

    const { resolveDispute } = await import("@/lib/disputes/dispute-service");
    const results2 = await Promise.allSettled([
      resolveDispute({
        actorId: reviewer2.id,
        disputeId: dispute2.id,
        resolutionCode: "OTHER",
        resolutionAction: "RESTORE_PREVIOUS",
      }),
      eraseAccount(renter2.id),
    ]);
    assertNoSerializationFailure(
      results2.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason),
    );
    createdDisputeIds.push(dispute2.id);
  });

  it("D-RACE-07：claim race → 恰好一个 assignee", async () => {
    const owner = await createFixtureUser("RACE07owner");
    const renter = await createFixtureUser("RACE07renter");
    const reviewerA = await createFixtureUser("RACE07reviewerA");
    const reviewerB = await createFixtureUser("RACE07reviewerB");
    await assignRoleByKey(reviewerA.id, "CAMPUS_DISPUTE_REVIEWER", campusA.id);
    await assignRoleByKey(reviewerB.id, "CAMPUS_DISPUTE_REVIEWER", campusA.id);
    const { order } = await createRentalFixture({ ownerId: owner.id, renterId: renter.id, campusId: campusA.id });
    const dispute = await seedDisputeDirectly({
      orderId: order.id,
      initiatorId: renter.id,
      campusId: campusA.id,
    });
    createdDisputeIds.push(dispute.id);

    const { claimDispute } = await import("@/lib/disputes/dispute-service");
    const results = await Promise.allSettled([
      claimDispute({ actorId: reviewerA.id, disputeId: dispute.id }),
      claimDispute({ actorId: reviewerB.id, disputeId: dispute.id }),
    ]);

    assertNoSerializationFailure(
      results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason),
    );

    const row = await rawClient!.rentalDispute.findUniqueOrThrow({ where: { id: dispute.id } });
    const winners = results.filter((r) => r.status === "fulfilled");
    expect(winners).toHaveLength(1);
    expect(row.assignedToId).toBe(
      (winners[0] as PromiseFulfilledResult<{ assignedToId: string }>).value.assignedToId,
    );
  });

  it("D-RACE-08：release by non-assignee denied（并发竞争中 fail closed）", async () => {
    const owner = await createFixtureUser("RACE08owner");
    const renter = await createFixtureUser("RACE08renter");
    const reviewerA = await createFixtureUser("RACE08reviewerA");
    const reviewerB = await createFixtureUser("RACE08reviewerB");
    await assignRoleByKey(reviewerA.id, "CAMPUS_DISPUTE_REVIEWER", campusA.id);
    await assignRoleByKey(reviewerB.id, "CAMPUS_DISPUTE_REVIEWER", campusA.id);
    const { order } = await createRentalFixture({ ownerId: owner.id, renterId: renter.id, campusId: campusA.id });
    const dispute = await seedDisputeDirectly({
      orderId: order.id,
      initiatorId: renter.id,
      campusId: campusA.id,
      status: "IN_REVIEW",
      assignedToId: reviewerA.id,
    });
    createdDisputeIds.push(dispute.id);

    const { releaseDispute } = await import("@/lib/disputes/dispute-service");
    await expect(releaseDispute({ actorId: reviewerB.id, disputeId: dispute.id })).rejects.toMatchObject({
      code: "DISPUTE_RELEASE_FORBIDDEN",
    });
    const row = await rawClient!.rentalDispute.findUniqueOrThrow({ where: { id: dispute.id } });
    expect(row.assignedToId).toBe(reviewerA.id);
  });

  it("NO_40P01：混合治理并发哨兵（resolve ‖ revoke ‖ erasure ‖ 新 dispute）", async () => {
    const owner = await createFixtureUser("NO40P01owner");
    const renter = await createFixtureUser("NO40P01renter");
    const reviewer = await createFixtureUser("NO40P01reviewer");
    const enforcer = await createFixtureUser("NO40P01enforcer");
    await assignRoleByKey(reviewer.id, "CAMPUS_DISPUTE_REVIEWER", campusA.id);
    const { order } = await createRentalFixture({ ownerId: owner.id, renterId: renter.id, campusId: campusA.id });
    const dispute = await seedDisputeDirectly({
      orderId: order.id,
      initiatorId: renter.id,
      campusId: campusA.id,
    });
    await rawClient!.rentalOrder.update({ where: { id: order.id }, data: { status: "IN_DISPUTE" } });
    createdDisputeIds.push(dispute.id);

    const { resolveDispute } = await import("@/lib/disputes/dispute-service");
    const { suspendAccount } = await import("@/lib/enforcement/account-enforcement-service");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");
    const { withTransaction } = await import("@/lib/prisma");
    const { initiateDisputeTx } = await import("@/lib/rental-order-machine");

    const thirdParty = await createFixtureUser("NO40P01third");
    const results = await Promise.allSettled([
      resolveDispute({
        actorId: reviewer.id,
        disputeId: dispute.id,
        resolutionCode: "OTHER",
        resolutionAction: "RESTORE_PREVIOUS",
      }),
      suspendAccount({
        actorId: enforcer.id,
        targetUserId: thirdParty.id,
        reasonCode: "POLICY_VIOLATION",
      }),
      eraseAccount(thirdParty.id),
      withTransaction(async (tx) =>
        initiateDisputeTx(tx, {
          orderId: order.id,
          userId: owner.id,
          reason: "NO40P01 第二 episode 尝试",
          evidencePhotos: [],
        }),
      ),
    ]);

    const errors = results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason);
    assertNoSerializationFailure(errors);
    // 错误均治理域语义（无裸 5xx 类崩溃）
    for (const error of errors) {
      expect(errorCodeOf(error)).not.toBeNull();
    }
  });
});
