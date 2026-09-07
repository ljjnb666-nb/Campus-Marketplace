import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Phase 6B Repair 2 补充集成测试（真实 PostgreSQL）。
 *
 * 与 phase6b-trust-enforcement.test.ts 共享同一测试库约定：
 * - 服务层经 @/lib/prisma 单例访问 DATABASE_URL
 * - 清理走独立裸客户端硬删除
 * - fixture 前缀独立（R2 前缀），避免与主文件并行互扰
 *
 * 覆盖（Repair 2 §22-31）：
 *  - Report transition serialization 双向竞态（FOR UPDATE + racePoint）
 *  - obligation membership matrix：SERVICE / ERRAND / RENTAL counterparty
 *  - §26 restriction regression：counterparty RESTRICTED 不阻断 incoming
 *  - §27/28 privileged membership enforcement（campus + GLOBAL admin）
 *  - §29 campus internal trust isolation
 *  - §31 report projection campus provenance
 */

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const prisma = integrationDatabaseUrl ? (await import("@/lib/prisma")).prisma : null;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `r2-${randomUUID().slice(0, 8)}`;
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
  options: { role?: "STUDENT" | "ADMIN" } = {},
) {
  const user = await rawClient!.user.create({
    data: {
      email: `${RUN_TAG}-${createdUserIds.length}@it.local`,
      name,
      passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
      schoolName: "集成测试大学",
      campusId,
      role: options.role ?? "STUDENT",
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

/**
 * Repair 3 Blocker C：确定性 barrier 必须绑定 **exact loser backend PID**。
 * 旧实现轮询"任意未授予锁"——任何其他集成文件的事务等待都会误触发屏障。
 * winner 的 racePoint seam 保证 winner 已持行锁；loser 事务在 FOR UPDATE
 * 之前发布自己的 pg_backend_pid()，barrier 轮询该精确 PID 的未授予锁。
 */
async function waitForExactPidLockWaiter(
  loserPid: number,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await rawClient!.$queryRaw<{ waiting: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_locks
        WHERE pid = ${loserPid}
          AND granted = false
      ) AS waiting`;
    if (rows[0]?.waiting === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `advisory/row-lock barrier 超时：loser pid=${loserPid} 未进入锁等待`,
  );
}

describe.skipIf(!integrationDatabaseUrl)("Phase 6B Repair 2 补充集成测试（真实 PostgreSQL）", () => {
  let campusA: { id: string };
  let campusB: { id: string };
  let globalAdmin: { id: string };

  beforeAll(async () => {
    campusA = await createFixtureCampus("rc-a");
    campusB = await createFixtureCampus("rc-b");
    globalAdmin = await createFixtureUser("全局管理员R2", campusA.id, { role: "ADMIN" });

    const { ensureRbacFoundation, syncLegacyAdminRoles, ensureCampusMemberships } = await import(
      "@/lib/rbac/bootstrap"
    );
    await ensureRbacFoundation(prisma!);
    await syncLegacyAdminRoles(prisma!);
    await ensureCampusMemberships(prisma!);
  });

  afterAll(async () => {
    await rawClient!.riskFlag.deleteMany({ where: { userId: { in: createdUserIds } } });
    await rawClient!.riskState.deleteMany({ where: { userId: { in: createdUserIds } } });
    await rawClient!.enforcementAction.deleteMany({ where: { targetId: { in: createdUserIds } } });
    await rawClient!.report.deleteMany({
      where: { OR: [{ reporterId: { in: createdUserIds } }, { targetUserId: { in: createdUserIds } }] },
    });
    await rawClient!.message.deleteMany({ where: { senderId: { in: createdUserIds } } });
    await rawClient!.order.deleteMany({
      where: { OR: [{ buyerId: { in: createdUserIds } }, { sellerId: { in: createdUserIds } }] },
    });
    await rawClient!.rentalOrder.deleteMany({
      where: { OR: [{ renterId: { in: createdUserIds } }, { ownerId: { in: createdUserIds } }] },
    });
    await rawClient!.rentalListing.deleteMany({ where: { ownerId: { in: createdUserIds } } });
    await rawClient!.serviceListing.deleteMany({ where: { providerId: { in: createdUserIds } } });
    await rawClient!.errandTask.deleteMany({ where: { publisherId: { in: createdUserIds } } });
    await rawClient!.product.deleteMany({ where: { sellerId: { in: createdUserIds } } });
    await rawClient!.serviceCategory.deleteMany({ where: { slug: { startsWith: `it-svc-${RUN_TAG}` } } });
    await rawClient!.errandCategory.deleteMany({ where: { slug: { startsWith: `it-errand-${RUN_TAG}` } } });
    await rawClient!.rentalCategory.deleteMany({ where: { slug: { startsWith: `it-rental-${RUN_TAG}` } } });
    await rawClient!.productCategory.deleteMany({ where: { slug: { startsWith: `it-prod-${RUN_TAG}` } } });
    await rawClient!.campusMembership.deleteMany({ where: { userId: { in: createdUserIds } } });
    await rawClient!.userRoleAssignment.deleteMany({ where: { userId: { in: createdUserIds } } });
    await rawClient!.rolePermission.deleteMany({ where: { roleId: { in: createdRoleIds } } });
    await rawClient!.role.deleteMany({ where: { id: { in: createdRoleIds } } });
    await rawClient!.adminLog.deleteMany({ where: { adminId: { in: createdUserIds } } });
    await rawClient!.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await rawClient!.campus.deleteMany({ where: { id: { in: createdCampusIds } } });
    await rawClient!.$disconnect();
    await prisma?.$disconnect();
  });

  // ============================================================
  // Repair 2 Blocker D：Report transition serialization（双向竞态）
  // ============================================================

  it("Repair 2 D：并发 RESOLVED vs REJECTED——恰好一个合法终态，投影无矛盾", async () => {
    const { applyReportReviewTx } = await import("@/lib/enforcement/report-projection");
    const { withTransaction } = await import("@/lib/prisma");

    const admin1 = await createFixtureUser("审核D2-1", campusA.id);
    const admin2 = await createFixtureUser("审核D2-2", campusA.id);
    const target = await createFixtureUser("被举报D2", campusA.id);
    const reporter = await createFixtureUser("举报者D2", campusA.id);

    const report = await rawClient!.report.create({
      data: {
        targetType: "USER",
        reason: "FAKE_INFO",
        reporterId: reporter.id,
        targetUserId: target.id,
      },
    });

    let winnerLocked!: () => void;
    const winnerLockedPromise = new Promise<void>((resolve) => {
      winnerLocked = resolve;
    });
    let releaseWinner!: () => void;
    const winnerGate = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });

    const t1 = withTransaction((tx) =>
      applyReportReviewTx(tx, {
        reportId: report.id,
        actorId: admin1.id,
        status: "RESOLVED",
        handledNote: "winner",
        racePoint: async () => {
          winnerLocked();
          await winnerGate;
        },
      }),
    );
    await winnerLockedPromise;

    // Repair 3 Blocker C：loser 事务先发布自己的 backend PID
    let loserPidResolve!: (pid: number) => void;
    const loserPidReady = new Promise<number>((resolve) => {
      loserPidResolve = resolve;
    });
    const t2 = withTransaction(async (tx) => {
      const pidRows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      loserPidResolve(pidRows[0]!.pid);
      return applyReportReviewTx(tx, {
        reportId: report.id,
        actorId: admin2.id,
        status: "REJECTED",
      });
    }).then(
      () => "fulfilled" as const,
      (error) => ({ rejected: true as const, message: error.message as string }),
    );

    const loserPid = await loserPidReady;
    await waitForExactPidLockWaiter(loserPid);

    releaseWinner();
    await expect(t1).resolves.toMatchObject({ status: "RESOLVED" });
    await expect(t2).resolves.toMatchObject({
      rejected: true,
      message: expect.stringContaining("REPORT_STATUS_INVALID_TRANSITION"),
    });

    const finalReport = await rawClient!.report.findUniqueOrThrow({
      where: { id: report.id },
    });
    expect(finalReport.status).toBe("RESOLVED");

    const submitted = await rawClient!.riskFlag.findUniqueOrThrow({
      where: {
        kind_sourceType_sourceId: {
          kind: "REPORT_SUBMITTED",
          sourceType: "REPORT",
          sourceId: report.id,
        },
      },
    });
    expect(submitted.status).toBe("RESOLVED");
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
  });

  it("Repair 2 D direction B：REJECTED 先赢 → RESOLVED 被拒", async () => {
    const { applyReportReviewTx } = await import("@/lib/enforcement/report-projection");
    const { withTransaction } = await import("@/lib/prisma");

    const admin1 = await createFixtureUser("审核D3-1", campusA.id);
    const admin2 = await createFixtureUser("审核D3-2", campusA.id);
    const target = await createFixtureUser("被举报D3", campusA.id);
    const reporter = await createFixtureUser("举报者D3", campusA.id);

    const report = await rawClient!.report.create({
      data: {
        targetType: "USER",
        reason: "SCAM_RISK",
        reporterId: reporter.id,
        targetUserId: target.id,
      },
    });

    let winnerLocked!: () => void;
    const winnerLockedPromise = new Promise<void>((resolve) => {
      winnerLocked = resolve;
    });
    let releaseWinner!: () => void;
    const winnerGate = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });

    const t1 = withTransaction((tx) =>
      applyReportReviewTx(tx, {
        reportId: report.id,
        actorId: admin1.id,
        status: "REJECTED",
        racePoint: async () => {
          winnerLocked();
          await winnerGate;
        },
      }),
    );
    await winnerLockedPromise;

    // Repair 3 Blocker C：loser 事务先发布自己的 backend PID
    let loserPidResolve!: (pid: number) => void;
    const loserPidReady = new Promise<number>((resolve) => {
      loserPidResolve = resolve;
    });
    const t2 = withTransaction(async (tx) => {
      const pidRows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      loserPidResolve(pidRows[0]!.pid);
      return applyReportReviewTx(tx, {
        reportId: report.id,
        actorId: admin2.id,
        status: "RESOLVED",
      });
    }).then(
      () => "fulfilled" as const,
      (error) => ({
        rejected: true as const,
        code: error.code as string,
        message: error.message as string,
      }),
    );

    const loserPid = await loserPidReady;
    await waitForExactPidLockWaiter(loserPid);

    releaseWinner();
    await expect(t1).resolves.toMatchObject({ status: "REJECTED" });
    await expect(t2).resolves.toMatchObject({
      rejected: true,
      message: expect.stringContaining("REPORT_STATUS_INVALID_TRANSITION"),
    });

    const finalReport = await rawClient!.report.findUniqueOrThrow({
      where: { id: report.id },
    });
    expect(finalReport.status).toBe("REJECTED");

    const submitted = await rawClient!.riskFlag.findUniqueOrThrow({
      where: {
        kind_sourceType_sourceId: {
          kind: "REPORT_SUBMITTED",
          sourceType: "REPORT",
          sourceId: report.id,
        },
      },
    });
    expect(submitted.status).toBe("RESOLVED");
    const confirmed = await rawClient!.riskFlag.findUnique({
      where: {
        kind_sourceType_sourceId: {
          kind: "REPORT_CONFIRMED",
          sourceType: "REPORT",
          sourceId: report.id,
        },
      },
    });
    expect(confirmed === null || confirmed.status === "RESOLVED").toBe(true);
  });

  // ============================================================
  // Repair 2 §23-25：obligation membership matrix（SERVICE/ERRAND/RENTAL）
  // ============================================================

  it("Repair 2 SERVICE：provider SUSPENDED → createServiceOrderTx DENY 零订单", async () => {
    const { createServiceOrderTx } = await import("@/lib/order-creation");
    const { withTransaction } = await import("@/lib/prisma");

    const buyer = await createFixtureUser("服务买家M", campusA.id);
    const provider = await createFixtureUser("停用服务者M", campusA.id);
    await rawClient!.campusMembership.updateMany({
      where: { userId: provider.id },
      data: { status: "SUSPENDED" },
    });
    const category = await rawClient!.serviceCategory.create({
      data: { name: `IT服务M ${RUN_TAG}`, slug: `it-svc-m-${RUN_TAG}` },
    });
    const listing = await rawClient!.serviceListing.create({
      data: {
        title: `IT 服务 ${RUN_TAG}`,
        description: "matrix service",
        categoryId: category.id,
        price: 30,
        pricingUnit: "PER_SESSION",
        locationText: "IT",
        campusId: campusA.id,
        providerId: provider.id,
      },
    });

    await expect(
      withTransaction((tx) =>
        createServiceOrderTx(tx, {
          buyerId: buyer.id,
          service: {
            id: listing.id,
            price: "30.00",
            providerId: provider.id,
            campusId: campusA.id,
          },
          meetingLocation: "IT",
          note: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_NOT_ACTIVE" });

    expect(await rawClient!.order.count({ where: { serviceListingId: listing.id } })).toBe(0);
    expect(
      (await rawClient!.serviceListing.findUniqueOrThrow({ where: { id: listing.id } })).status,
    ).toBe("ACTIVE");
  });

  it("Repair 2 ERRAND：publisher LEFT → claimErrandTx DENY，任务保持 OPEN", async () => {
    const { claimErrandTx } = await import("@/lib/order-creation");
    const { withTransaction } = await import("@/lib/prisma");

    const category = await rawClient!.errandCategory.create({
      data: { name: `IT跑腿M ${RUN_TAG}`, slug: `it-errand-m-${RUN_TAG}` },
    });
    const publisher = await createFixtureUser("跑腿发布M", campusA.id);
    await rawClient!.campusMembership.updateMany({
      where: { userId: publisher.id },
      data: { status: "LEFT" },
    });
    const claimer = await createFixtureUser("跑腿接单M", campusA.id);
    const errand = await rawClient!.errandTask.create({
      data: {
        title: `IT 任务 ${RUN_TAG}`,
        description: "matrix errand",
        categoryId: category.id,
        reward: 8,
        pickupLocation: "IT",
        deliveryLocation: "IT",
        deadline: new Date(Date.now() + 3600_000),
        campusId: campusA.id,
        publisherId: publisher.id,
      },
    });

    await expect(
      withTransaction((tx) =>
        claimErrandTx(tx, {
          errandId: errand.id,
          publisherId: publisher.id,
          claimerId: claimer.id,
          campusId: campusA.id,
          reward: errand.reward,
        }),
      ),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_NOT_ACTIVE" });

    const row = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errand.id } });
    expect(row.status).toBe("OPEN");
    expect(row.accepterId).toBeNull();
    expect(await rawClient!.order.count({ where: { errandTaskId: errand.id } })).toBe(0);
  });

  it("Repair 2 RENTAL：owner SUSPENDED → createRentalOrderTx DENY 零租赁单", async () => {
    const { createRentalOrderTx } = await import("@/lib/rental-order-machine");
    const { withTransaction } = await import("@/lib/prisma");

    const owner = await createFixtureUser("租赁属主M", campusA.id);
    await rawClient!.campusMembership.updateMany({
      where: { userId: owner.id },
      data: { status: "SUSPENDED" },
    });
    const renter = await createFixtureUser("租赁租客M", campusA.id);
    const category = await rawClient!.rentalCategory.create({
      data: { name: `IT租赁M ${RUN_TAG}`, slug: `it-rental-m-${RUN_TAG}` },
    });
    const listing = await rawClient!.rentalListing.create({
      data: {
        title: `IT 租赁 ${RUN_TAG}`,
        description: "matrix rental",
        categoryId: category.id,
        campusId: campusA.id,
        ownerId: owner.id,
        condition: "NORMAL_USED",
        price: 20,
        pricingUnit: "PER_DAY",
        depositAmount: 100,
        minimumDuration: 1,
        maximumDuration: 7,
        totalQuantity: 1,
        availableQuantity: 1,
        pickupLocation: "IT",
        returnLocation: "IT",
      },
    });

    await expect(
      withTransaction((tx) =>
        createRentalOrderTx(tx, {
          userId: renter.id,
          rentalListingId: listing.id,
          startTime: new Date(Date.now() + 3600_000),
          endTime: new Date(Date.now() + 7200_000),
          quantity: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_NOT_ACTIVE" });

    expect(await rawClient!.rentalOrder.count({ where: { rentalListingId: listing.id } })).toBe(0);
    expect(
      (await rawClient!.rentalListing.findUniqueOrThrow({ where: { id: listing.id } })).status,
    ).toBe("AVAILABLE");
  });

  it("Repair 2 §26：counterparty RESTRICTED（membership ACTIVE）不阻断 incoming order", async () => {
    const { createProductOrderTx } = await import("@/lib/order-creation");
    const { setRiskState } = await import("@/lib/enforcement/risk-service");
    const { withTransaction } = await import("@/lib/prisma");

    const seller = await createFixtureUser("受限卖家M", campusA.id);
    const buyer = await createFixtureUser("正常买家M", campusA.id);
    await setRiskState({
      actorId: globalAdmin.id,
      targetUserId: seller.id,
      campusId: null,
      state: "RESTRICTED",
      reasonCode: "POLICY_VIOLATION",
    });
    const category = await rawClient!.productCategory.create({
      data: { name: `IT商品M ${RUN_TAG}`, slug: `it-prod-m-${RUN_TAG}` },
    });
    const product = await rawClient!.product.create({
      data: {
        title: `M 商品 ${randomUUID()}`,
        description: "restriction regression",
        price: 12,
        condition: "NORMAL_USED",
        locationText: "IT",
        categoryId: category.id,
        campusId: campusA.id,
        sellerId: seller.id,
      },
    });

    const order = await withTransaction((tx) =>
      createProductOrderTx(tx, {
        buyerId: buyer.id,
        product: {
          id: product.id,
          price: "12.00",
          sellerId: seller.id,
          campusId: campusA.id,
        },
        meetingLocation: "IT",
        note: null,
      }),
    );
    expect(order?.id).toBeTruthy();
  });

  // ============================================================
  // Repair 2 §27-28：privileged membership enforcement
  // ============================================================

  it("Repair 2 §27：campus 经理不能停用 PLATFORM_ADMIN 的成员关系", async () => {
    const { suspendCampusMembership } = await import(
      "@/lib/enforcement/membership-enforcement-service"
    );
    const { PERMISSION_KEYS } = await import("@/lib/rbac/permissions");

    const manager = await createFixtureUser("校区经理P1", campusA.id);
    await grantRole(manager.id, "CAMPUS_MANAGER_P1", ["campus.manage"], "CAMPUS", campusA.id);
    const privileged = await createFixtureUser("特权成员P1", campusA.id);
    await grantRole(privileged.id, "FULL_ADMIN_P1", [...PERMISSION_KEYS], "GLOBAL");

    await expect(
      suspendCampusMembership({
        actorId: manager.id,
        targetUserId: privileged.id,
        campusId: campusA.id,
        reasonCode: "POLICY_VIOLATION",
      }),
    ).rejects.toMatchObject({ code: "ENFORCEMENT_PRIVILEGED_TARGET" });

    expect(
      (
        await rawClient!.campusMembership.findUniqueOrThrow({
          where: { userId_campusId: { userId: privileged.id, campusId: campusA.id } },
        })
      ).status,
    ).toBe("ACTIVE");
    expect(await rawClient!.enforcementAction.count({ where: { targetId: privileged.id } })).toBe(0);
    expect(await rawClient!.adminLog.count({ where: { targetId: privileged.id } })).toBe(0);
  });

  it("Repair 2 §28：GLOBAL admin 同样不能停用特权目标成员关系", async () => {
    const { suspendCampusMembership } = await import(
      "@/lib/enforcement/membership-enforcement-service"
    );
    const { PERMISSION_KEYS } = await import("@/lib/rbac/permissions");

    const enforcer = await createFixtureUser("全局执法P2", campusA.id);
    await grantRole(enforcer.id, "GLOBAL_CAMPUS_P2", ["campus.manage"], "GLOBAL");
    const privileged = await createFixtureUser("特权成员P2", campusA.id);
    await grantRole(privileged.id, "FULL_ADMIN_P2", [...PERMISSION_KEYS], "GLOBAL");

    await expect(
      suspendCampusMembership({
        actorId: enforcer.id,
        targetUserId: privileged.id,
        campusId: campusA.id,
        reasonCode: "POLICY_VIOLATION",
      }),
    ).rejects.toMatchObject({ code: "ENFORCEMENT_PRIVILEGED_TARGET" });

    expect(
      (
        await rawClient!.campusMembership.findUniqueOrThrow({
          where: { userId_campusId: { userId: privileged.id, campusId: campusA.id } },
        })
      ).status,
    ).toBe("ACTIVE");
    expect(await rawClient!.enforcementAction.count({ where: { targetId: privileged.id } })).toBe(0);
    expect(await rawClient!.adminLog.count({ where: { targetId: privileged.id } })).toBe(0);
  });

  // ============================================================
  // Repair 2 §29：campus internal trust isolation
  // ============================================================

  it("Repair 2 §29：campus internal view 隔离（relationship + 本地信号 + GLOBAL 不绕过）", async () => {
    const { getInternalTrustSnapshot } = await import("@/lib/trust/trust-snapshot");

    const auditorA = await createFixtureUser("A区审计R2", campusA.id);
    await grantRole(auditorA.id, "CAMPUS_AUDITOR_R2", ["audit.read"], "CAMPUS", campusA.id);
    const targetA = await createFixtureUser("R2目标A", campusA.id);
    const targetB = await createFixtureUser("R2目标B", campusB.id);

    await rawClient!.riskFlag.createMany({
      data: [
        { userId: targetA.id, campusId: campusA.id, kind: "REPORT_SUBMITTED", severity: "INFO", sourceType: "REPORT", sourceId: `r2a-${RUN_TAG}` },
        { userId: targetA.id, campusId: campusB.id, kind: "REPORT_SUBMITTED", severity: "INFO", sourceType: "REPORT", sourceId: `r2b-${RUN_TAG}` },
        { userId: targetA.id, campusId: null, kind: "REPORT_SUBMITTED", severity: "INFO", sourceType: "REPORT", sourceId: `r2null-${RUN_TAG}` },
      ],
    });

    // A. valid same-campus：只见 A 本地信号
    const campusView = await getInternalTrustSnapshot({
      actorId: auditorA.id,
      targetUserId: targetA.id,
      campusId: campusA.id,
    });
    expect(campusView?.view).toBe("CAMPUS");
    if (campusView?.view === "CAMPUS") {
      expect(campusView.membership).toEqual({ status: "ACTIVE" });
      expect(campusView.reportSignals.submittedReportSignals).toBe(1);
      expect(campusView.reportSignals.confirmedReportSignals).toBe(0);
      expect(campusView.risk.state).toBe("NORMAL");
    }
    const campusJson = JSON.stringify(campusView);
    expect(campusJson).not.toContain(campusB.id);
    expect(campusJson).not.toContain("activeCampusIds");

    // B. target only in B → DENY（稳定错误族）
    await expect(
      getInternalTrustSnapshot({
        actorId: auditorA.id,
        targetUserId: targetB.id,
        campusId: campusA.id,
      }),
    ).rejects.toMatchObject({ code: "ENFORCEMENT_TARGET_SCOPE_MISMATCH" });

    // C. target LEFT in A → DENY
    await rawClient!.campusMembership.updateMany({
      where: { userId: targetA.id },
      data: { status: "LEFT" },
    });
    await expect(
      getInternalTrustSnapshot({
        actorId: auditorA.id,
        targetUserId: targetA.id,
        campusId: campusA.id,
      }),
    ).rejects.toMatchObject({ code: "ENFORCEMENT_TARGET_SCOPE_MISMATCH" });
    await rawClient!.campusMembership.updateMany({
      where: { userId: targetA.id },
      data: { status: "ACTIVE" },
    });

    // D. GLOBAL 视图见全量；GLOBAL admin 请求 campus 视图只见 A 本地
    const globalView = await getInternalTrustSnapshot({
      actorId: globalAdmin.id,
      targetUserId: targetA.id,
    });
    if (globalView?.view !== "GLOBAL") {
      throw new Error("expected GLOBAL view");
    }
    expect(globalView.reportSignals.submittedReportSignals).toBe(3);
    expect(globalView.membership.activeCampusIds).toEqual([campusA.id]);

    const globalAsCampus = await getInternalTrustSnapshot({
      actorId: globalAdmin.id,
      targetUserId: targetA.id,
      campusId: campusA.id,
    });
    if (globalAsCampus?.view !== "CAMPUS") {
      throw new Error("expected CAMPUS view");
    }
    expect(globalAsCampus.reportSignals.submittedReportSignals).toBe(1);
  });

  // ============================================================
  // Repair 2 §31：report projection user/campus consistency
  // ============================================================

  it("Repair 2 §31：PRODUCT/SERVICE 投影携带正确 campus；MESSAGE campusId=null", async () => {
    const { reconcileReportRiskProjection } = await import(
      "@/lib/enforcement/report-projection"
    );

    const seller = await createFixtureUser("投影卖家", campusA.id);
    const provider = await createFixtureUser("投影服务者", campusA.id);
    const reporter = await createFixtureUser("投影举报者", campusA.id);
    const category = await rawClient!.productCategory.create({
      data: { name: `IT投影分类 ${RUN_TAG}`, slug: `it-proj-p-${RUN_TAG}` },
    });
    const product = await rawClient!.product.create({
      data: {
        title: `投影商品 ${randomUUID()}`,
        description: "projection",
        price: 5,
        condition: "NORMAL_USED",
        locationText: "IT",
        categoryId: category.id,
        campusId: campusA.id,
        sellerId: seller.id,
      },
    });
    const serviceCategory = await rawClient!.serviceCategory.create({
      data: { name: `IT投影服务 ${RUN_TAG}`, slug: `it-proj-s-${RUN_TAG}` },
    });
    const service = await rawClient!.serviceListing.create({
      data: {
        title: `投影服务 ${RUN_TAG}`,
        description: "projection",
        categoryId: serviceCategory.id,
        price: 10,
        pricingUnit: "PER_SESSION",
        locationText: "IT",
        campusId: campusA.id,
        providerId: provider.id,
      },
    });

    const productReport = await rawClient!.report.create({
      data: {
        targetType: "PRODUCT",
        reason: "FAKE_INFO",
        reporterId: reporter.id,
        productId: product.id,
      },
    });
    await reconcileReportRiskProjection({ reportId: productReport.id });
    const productFlag = await rawClient!.riskFlag.findUniqueOrThrow({
      where: {
        kind_sourceType_sourceId: {
          kind: "REPORT_SUBMITTED",
          sourceType: "REPORT",
          sourceId: productReport.id,
        },
      },
    });
    expect(productFlag.userId).toBe(seller.id);
    expect(productFlag.campusId).toBe(campusA.id);

    const serviceReport = await rawClient!.report.create({
      data: {
        targetType: "SERVICE_LISTING",
        reason: "FAKE_INFO",
        reporterId: reporter.id,
        serviceListingId: service.id,
      },
    });
    await reconcileReportRiskProjection({ reportId: serviceReport.id });
    const serviceFlag = await rawClient!.riskFlag.findUniqueOrThrow({
      where: {
        kind_sourceType_sourceId: {
          kind: "REPORT_SUBMITTED",
          sourceType: "REPORT",
          sourceId: serviceReport.id,
        },
      },
    });
    expect(serviceFlag.userId).toBe(provider.id);
    expect(serviceFlag.campusId).toBe(campusA.id);

    const conversation = await rawClient!.conversation.create({ data: {} });
    const message = await rawClient!.message.create({
      data: { conversationId: conversation.id, senderId: seller.id, content: "msg" },
    });
    const messageReport = await rawClient!.report.create({
      data: {
        targetType: "MESSAGE",
        reason: "HARASSMENT",
        reporterId: reporter.id,
        messageId: message.id,
      },
    });
    await reconcileReportRiskProjection({ reportId: messageReport.id });
    const messageFlag = await rawClient!.riskFlag.findUniqueOrThrow({
      where: {
        kind_sourceType_sourceId: {
          kind: "REPORT_SUBMITTED",
          sourceType: "REPORT",
          sourceId: messageReport.id,
        },
      },
    });
    expect(messageFlag.userId).toBe(seller.id);
    expect(messageFlag.campusId).toBeNull();
  });

  // ============================================================
  // Repair 3 §13：effective verification campus scope（真实 PG）
  // ============================================================

  it("Repair 3 §13：verification 绑定 B——A 视角 NOT VERIFIED；B 视角 VERIFIED→SUSPENDED 后 NOT VERIFIED", async () => {
    const { getInternalTrustSnapshot } = await import("@/lib/trust/trust-snapshot");

    const auditorA = await createFixtureUser("A区审计V1", campusA.id);
    await grantRole(auditorA.id, "CAMPUS_AUDITOR_V1", ["audit.read"], "CAMPUS", campusA.id);
    const auditorB = await createFixtureUser("B区审计V1", campusB.id);
    await grantRole(auditorB.id, "CAMPUS_AUDITOR_B_V1", ["audit.read"], "CAMPUS", campusB.id);

    // target：A、B 双 ACTIVE membership；canonical 认证绑定 Campus B、VERIFIED
    const dualTarget = await createFixtureUser("双校区认证目标", campusA.id);
    await rawClient!.campusMembership.create({
      data: { userId: dualTarget.id, campusId: campusB.id, status: "ACTIVE" },
    });
    const membershipB = await rawClient!.campusMembership.findUniqueOrThrow({
      where: { userId_campusId: { userId: dualTarget.id, campusId: campusB.id } },
    });
    const verification = await rawClient!.userVerification.create({
      data: {
        userId: dualTarget.id,
        membershipId: membershipB.id,
        schoolName: "集成测试大学",
        campusName: "B 校区",
        studentIdLast4: "2468",
        studentCardImage: "erased",
        status: "VERIFIED",
      },
    });

    const globalView = await getInternalTrustSnapshot({
      actorId: globalAdmin.id,
      targetUserId: dualTarget.id,
    });
    expect(globalView?.verification.status).toBe("VERIFIED");

    const campusAView = await getInternalTrustSnapshot({
      actorId: auditorA.id,
      targetUserId: dualTarget.id,
      campusId: campusA.id,
    });
    expect(campusAView?.verification.status).not.toBe("VERIFIED");

    const campusBView = await getInternalTrustSnapshot({
      actorId: auditorB.id,
      targetUserId: dualTarget.id,
      campusId: campusB.id,
    });
    expect(campusBView?.verification.status).toBe("VERIFIED");

    // B membership SUSPENDED → B 视角也不再 VERIFIED（effective 降级）
    await rawClient!.campusMembership.update({
      where: { id: membershipB.id },
      data: { status: "SUSPENDED" },
    });
    const campusBViewAfter = await getInternalTrustSnapshot({
      actorId: auditorB.id,
      targetUserId: dualTarget.id,
      campusId: campusB.id,
    });
    expect(campusBViewAfter?.verification.status).not.toBe("VERIFIED");

    // canonical 证据未被篡改：UserVerification.status 仍 VERIFIED
    expect(
      (await rawClient!.userVerification.findUniqueOrThrow({ where: { id: verification.id } })).status,
    ).toBe("VERIFIED");
    void verification;
  });

});
