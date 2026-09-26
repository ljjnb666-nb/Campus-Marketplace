import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const { createNotifications, checkTimeConflict } = vi.hoisted(() => ({
  createNotifications: vi.fn(),
  checkTimeConflict: vi.fn(),
}));

vi.mock("@/repositories/notification-repository", () => ({
  createNotifications,
}));

const { marketplaceObligationValidator } = vi.hoisted(() => ({
  marketplaceObligationValidator: vi.fn(() => async () => undefined),
}));

vi.mock("@/lib/governance/active-account-mutation", () => ({
  prepareActiveAccountMutation: vi.fn().mockResolvedValue(undefined),
  assertActiveAccountMutationAllowed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/enforcement/capability-gate", () => ({
  requireMarketplaceCapability: vi.fn().mockResolvedValue(undefined),
  requireParticipantsMarketplaceEligible: vi.fn().mockResolvedValue(undefined),
  marketplaceObligationValidator,
}));

vi.mock("@/repositories/rental-order-repository", () => ({
  checkTimeConflict,
}));

import {
  EXTENSION_ALLOWED_ORDER_STATUSES,
  approveExtensionTx,
  approveRentalOrderTx,
  canCancelRentalOrder,
  counterpartyId,
  createRentalOrderTx,
  depositStatusAfterCompletion,
  incrementRentalCompletionCounters,
  isDisputableStatus,
  isRentalOrderRoleParticipant,
  recomputeRentalPositiveRate,
  rejectExtensionTx,
  rejectRentalOrderTx,
  requestExtensionTx,
  respondDamageClaimTx,
  writeStatusLog,
} from "@/lib/rental-order-machine";
import { assertActiveAccountMutationAllowed } from "@/lib/governance/active-account-mutation";

// vi.mock 提升后此导入实际是 mock；vi.mocked 仅用于恢复 mock 类型
const mockAssertActive = vi.mocked(assertActiveAccountMutationAllowed);

function buildTx() {
  return {
    rentalOrder: { findFirst: vi.fn(), update: vi.fn() },
    rentalOrderStatusLog: { create: vi.fn() },
    rentalDamageClaim: { findFirst: vi.fn(), update: vi.fn() },
    rentalReview: { count: vi.fn() },
    user: { update: vi.fn() },
    campusMembership: {
      findMany: vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) =>
        where.userId.in.map((userId: string) => ({ userId })),
      ),
    },
  };
}

// 测试里用纯 mock 对象充当事务客户端，调用领域函数时再断言为 TransactionClient
function asTx(tx: ReturnType<typeof buildTx>): Prisma.TransactionClient {
  return tx as unknown as Prisma.TransactionClient;
}

describe("rental-order-machine", () => {
  beforeEach(() => {
    createNotifications.mockReset();
    checkTimeConflict.mockReset();
    createNotifications.mockResolvedValue(undefined);
  });

  it("writes the status log with from/to/operator/note", async () => {
    const tx = buildTx();
    await writeStatusLog(asTx(tx), {
      orderId: "order-1",
      fromStatus: "PENDING_APPROVAL",
      toStatus: "PENDING_PICKUP",
      operatorId: "user-owner",
      note: "出租者同意租赁",
    });

    expect(tx.rentalOrderStatusLog.create).toHaveBeenCalledWith({
      data: {
        orderId: "order-1",
        fromStatus: "PENDING_APPROVAL",
        toStatus: "PENDING_PICKUP",
        operatorId: "user-owner",
        note: "出租者同意租赁",
      },
    });
  });

  it("accepts the matching party for a role", () => {
    const order = { ownerId: "user-owner", renterId: "user-renter" };
    expect(isRentalOrderRoleParticipant(order, "owner", "user-owner")).toBe(true);
    expect(isRentalOrderRoleParticipant(order, "renter", "user-renter")).toBe(true);
  });

  it("rejects mismatched roles and strangers", () => {
    const order = { ownerId: "user-owner", renterId: "user-renter" };
    expect(isRentalOrderRoleParticipant(order, "owner", "user-renter")).toBe(false);
    expect(isRentalOrderRoleParticipant(order, "renter", "user-owner")).toBe(false);
    expect(isRentalOrderRoleParticipant(order, "owner", "user-stranger")).toBe(false);
  });

  it("allows renter cancel while pending approval and either party while pending pickup", () => {
    const order = { ownerId: "user-owner", renterId: "user-renter" };
    expect(canCancelRentalOrder({ ...order, status: "PENDING_APPROVAL" }, "user-renter")).toBe(true);
    expect(canCancelRentalOrder({ ...order, status: "PENDING_APPROVAL" }, "user-owner")).toBe(false);
    expect(canCancelRentalOrder({ ...order, status: "PENDING_PICKUP" }, "user-owner")).toBe(true);
    expect(canCancelRentalOrder({ ...order, status: "PENDING_PICKUP" }, "user-renter")).toBe(true);
    expect(canCancelRentalOrder({ ...order, status: "IN_RENTAL" }, "user-renter")).toBe(false);
  });

  it("resolves the counterparty for owner and renter", () => {
    const order = { ownerId: "user-owner", renterId: "user-renter" };
    expect(counterpartyId(order, "user-owner")).toBe("user-renter");
    expect(counterpartyId(order, "user-renter")).toBe("user-owner");
  });

  it("moves paid deposits to PENDING_REFUND on completion and keeps zero deposits as-is", () => {
    expect(
      depositStatusAfterCompletion({ depositAmount: new Prisma.Decimal("50"), depositStatus: "PAID" }),
    ).toBe("PENDING_REFUND");
    expect(
      depositStatusAfterCompletion({ depositAmount: new Prisma.Decimal("0"), depositStatus: "NOT_REQUIRED" }),
    ).toBe("NOT_REQUIRED");
  });

  it("only allows disputes in rent-active or later statuses", () => {
    expect(isDisputableStatus("IN_RENTAL")).toBe(true);
    expect(isDisputableStatus("PENDING_INSPECTION")).toBe(true);
    expect(isDisputableStatus("COMPLETED")).toBe(true);
    expect(isDisputableStatus("PENDING_APPROVAL")).toBe(false);
    expect(isDisputableStatus("CANCELLED")).toBe(false);
  });

  it("increments rental completion counters for both parties", async () => {
    const tx = buildTx();
    await incrementRentalCompletionCounters(asTx(tx), { ownerId: "user-owner", renterId: "user-renter" });

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "user-owner" },
      data: { rentalOwnerCount: { increment: 1 } },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "user-renter" },
      data: { rentalRenterCount: { increment: 1 } },
    });
  });

  it("recomputes the positive rate as a 0..1 ratio", async () => {
    const tx = buildTx();
    // 4 条评价中 1 条好评（overallRating >= 4） => 比率 0.25
    tx.rentalReview.count.mockImplementation(({ where }: { where?: { overallRating?: unknown } }) =>
      Promise.resolve(where?.overallRating ? 1 : 4),
    );

    await recomputeRentalPositiveRate(asTx(tx), "user-owner");

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "user-owner" },
      data: { rentalPositiveRate: 0.25 },
    });
  });

  it("falls back to 0 when the target has no reviews", async () => {
    const tx = buildTx();
    tx.rentalReview.count.mockResolvedValue(0);

    await recomputeRentalPositiveRate(asTx(tx), "user-owner");

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "user-owner" },
      data: { rentalPositiveRate: 0 },
    });
  });

  it("approves an order and writes the transition log plus notification", async () => {
    const tx = buildTx();
    tx.rentalOrder.findFirst.mockResolvedValue({
      id: "order-1",
      status: "PENDING_APPROVAL",
      ownerId: "user-owner",
      renterId: "user-renter",
    });
    tx.rentalOrder.update.mockResolvedValue({});

    const result = await approveRentalOrderTx(asTx(tx), { orderId: "order-1", userId: "user-owner" });

    expect(result).toEqual({ success: true });
    expect(tx.rentalOrder.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { status: "PENDING_PICKUP" },
    });
    expect(tx.rentalOrderStatusLog.create).toHaveBeenCalledWith({
      data: {
        orderId: "order-1",
        fromStatus: "PENDING_APPROVAL",
        toStatus: "PENDING_PICKUP",
        operatorId: "user-owner",
        note: "出租者同意租赁",
      },
    });
    expect(createNotifications).toHaveBeenCalledWith(
      asTx(tx),
      [expect.objectContaining({ userId: "user-renter", title: "租赁申请已通过" })],
    );
  });

  it("SECONDARY-02/03：reject 原始原因保留在权威列，绝不进入 status log note / notification", async () => {
    const tx = buildTx();
    tx.rentalOrder.findFirst.mockResolvedValue({
      id: "order-1",
      status: "PENDING_APPROVAL",
      ownerId: "user-owner",
      renterId: "user-renter",
    });
    tx.rentalOrder.update.mockResolvedValue({});

    const RAW_REASON = "物品已损坏不想出租原因X";
    const result = await rejectRentalOrderTx(asTx(tx), {
      orderId: "order-1",
      userId: "user-owner",
      rejectReason: RAW_REASON,
    });

    expect(result).toEqual({ success: true });

    // 权威列保存原始原因（lifecycle/erasure 策略处理）
    expect(tx.rentalOrder.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: expect.objectContaining({
        status: "REJECTED",
        cancellationNote: RAW_REASON,
      }),
    });

    // status log note = generic system copy（SECONDARY-03）
    expect(tx.rentalOrderStatusLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        toStatus: "REJECTED",
        note: "出租者拒绝了租赁申请",
      }),
    });
    const logPayload = JSON.stringify(tx.rentalOrderStatusLog.create.mock.calls);
    expect(logPayload).not.toContain(RAW_REASON);

    // notification content = generic system copy（SECONDARY-02）
    expect(createNotifications).toHaveBeenCalledWith(
      asTx(tx),
      [expect.objectContaining({ userId: "user-renter", title: "租赁申请被拒绝" })],
    );
    const notificationPayload = JSON.stringify(createNotifications.mock.calls);
    expect(notificationPayload).not.toContain(RAW_REASON);
  });

  it("returns the domain error when the order is not approvable", async () => {
    const tx = buildTx();
    tx.rentalOrder.findFirst.mockResolvedValue(null);

    const result = await approveRentalOrderTx(asTx(tx), { orderId: "order-1", userId: "user-owner" });

    expect(result).toEqual({ error: "订单不存在或状态不允许" });
    expect(tx.rentalOrder.update).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("completes the order without deduction when the renter rejects the claim", async () => {
    const tx = buildTx();
    tx.rentalDamageClaim.findFirst.mockResolvedValue({
      id: "claim-1",
      orderId: "order-1",
      requestedDeduction: new Prisma.Decimal("30"),
      order: {
        id: "order-1",
        status: "PENDING_INSPECTION",
        ownerId: "user-owner",
        renterId: "user-renter",
        depositAmount: new Prisma.Decimal("50"),
        depositStatus: "PAID",
      },
    });

    const result = await respondDamageClaimTx(asTx(tx), {
      claimId: "claim-1",
      userId: "user-renter",
      agreed: false,
    });

    expect(result).toEqual({ success: true });
    expect(tx.rentalDamageClaim.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "claim-1" },
        data: expect.objectContaining({ renterAgreed: false }),
      }),
    );
    expect(tx.rentalOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "COMPLETED", depositStatus: "PENDING_REFUND" }),
      }),
    );
    expect(tx.rentalOrderStatusLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fromStatus: "PENDING_INSPECTION",
          toStatus: "COMPLETED",
          note: "租客拒绝损坏索赔，订单完成",
        }),
      }),
    );
    expect(tx.user.update).toHaveBeenCalledTimes(2);
  });

  it("returns the domain error when the claim responder is not the renter", async () => {
    const tx = buildTx();
    tx.rentalDamageClaim.findFirst.mockResolvedValue({
      id: "claim-1",
      orderId: "order-1",
      requestedDeduction: new Prisma.Decimal("30"),
      order: {
        id: "order-1",
        status: "PENDING_INSPECTION",
        ownerId: "user-owner",
        renterId: "user-renter",
        depositAmount: new Prisma.Decimal("50"),
        depositStatus: "PAID",
      },
    });

    const result = await respondDamageClaimTx(asTx(tx), {
      claimId: "claim-1",
      userId: "user-owner",
      agreed: true,
    });

    expect(result).toEqual({ error: "无效请求" });
    expect(tx.rentalDamageClaim.update).not.toHaveBeenCalled();
    expect(tx.rentalOrder.update).not.toHaveBeenCalled();
  });

  // ⚠️ Schema 漂移防护：createRentalOrderTx 使用 $queryRaw 绕过 Prisma 类型化查询，
  // 手动列举了 RentalListing 的字段。此测试确保这些字段仍存在于 schema 中，
  // 如果 RentalListing 模型重命名/删除了字段，这个测试会失败提醒开发者同步 raw SQL。
  it("raw SQL 查询的 RentalListing 字段与 schema 保持同步", () => {
    // pre-read（只读 candidate 发现）+ FOR UPDATE（行锁下重验证）两条 raw SQL 的字段合集
    const rawSqlFields = [
      "id", "ownerId", "totalQuantity", "minimumDuration", "maximumDuration",
      "price", "pricingUnit", "depositAmount", "pickupLocation", "returnLocation",
      "requiresApproval", "status", "title", "deletedAt",
    ];
    const schemaFields = Object.values(Prisma.RentalListingScalarFieldEnum);
    for (const field of rawSqlFields) {
      expect(schemaFields, `字段 "${field}" 在 Prisma schema 中不存在，请同步 rental-order-machine.ts 的 raw SQL`).toContain(field);
    }
  });

  // ⚠️ Phase 5 REPAIR 3 锁序结构回归：
  // createRentalOrderTx 的锁序必须是
  //   governance subject locks（advisory）→ RentalListing FOR UPDATE → 写入
  // 若未来把 FOR UPDATE 移回 participant guard 之前（旧锁序），会与
  // eraseAccount(owner) 的 subject lock → RentalListing updateMany 形成
  // row lock ↔ advisory lock 交叉死锁（SQLSTATE 40P01）。此测试以调用顺序
  // spy 锁定该结构；真实行为证明见集成 OWNER_CREATION_ERASURE_RACE_TEST 双向。
  it("锁序回归：pre-read → subject locks → validate → FOR UPDATE（结构锁定）", async () => {
    const calls: string[] = [];
    // 真实 validator 的锁内校验位于 subject locks 与 FOR UPDATE 之间：
    // 以 spy 复现该位置（校验内容本身由 capability-gate.test.ts 覆盖）
    marketplaceObligationValidator.mockImplementationOnce(
      () => async () => {
        calls.push("validate");
      },
    );
    const listingRow = {
      id: "listing-1", ownerId: "user-owner", campusId: "campus-1", totalQuantity: 2,
      minimumDuration: 1, maximumDuration: 30,
      price: "20", pricingUnit: "PER_DAY", depositAmount: "50",
      pickupLocation: "南门", returnLocation: "南门",
      requiresApproval: true, status: "AVAILABLE", title: "相机",
      deletedAt: null,
    };

    const tx = {
      $queryRaw: vi.fn(() => {
        const priorSelects = calls.filter(
          (entry) => entry === "pre-read" || entry === "for-update",
        ).length;
        calls.push(priorSelects === 0 ? "pre-read" : "for-update");
        return Promise.resolve([listingRow]);
      }),
      $executeRaw: vi.fn(() => {
        calls.push("subject-lock");
        return Promise.resolve(0);
      }),
      user: {
        findMany: vi.fn(() => {
          calls.push("recheck");
          return Promise.resolve([
            { id: "user-renter", status: "ACTIVE", deletedAt: null, erasedAt: null },
            { id: "user-owner", status: "ACTIVE", deletedAt: null, erasedAt: null },
          ]);
        }),
      },
      rentalUnavailablePeriod: { findFirst: vi.fn().mockResolvedValue(null) },
      rentalOrder: { create: vi.fn().mockResolvedValue({ id: "order-1" }) },
      rentalOrderStatusLog: { create: vi.fn().mockResolvedValue({}) },
      // Phase 7C：活跃 moderation 复查（无活跃行）
      listingModeration: { findFirst: vi.fn().mockResolvedValue(null) },
    };

    createNotifications.mockResolvedValue(undefined);
    checkTimeConflict.mockResolvedValue({ available: true });

    const result = await createRentalOrderTx(tx as unknown as Prisma.TransactionClient, {
      userId: "user-renter",
      rentalListingId: "listing-1",
      startTime: new Date("2026-10-01T10:00:00.000Z"),
      endTime: new Date("2026-10-02T10:00:00.000Z"),
      quantity: 1,
    });

    expect(result).toEqual({ orderId: "order-1" });

    // 精确调用序列（Phase 6C-3 Repair 2）：pre-read（无锁）→ 两把 subject 锁
    // → 锁内校验（validateLocked；真实实现=actor 三门+全参与方资格）→ FOR UPDATE
    expect(calls).toEqual([
      "pre-read",
      "subject-lock",
      "subject-lock",
      "validate",
      "for-update",
    ]);
    // FOR UPDATE 必须是最后一次行锁请求，且严格晚于 governance 锁
    expect(calls.indexOf("subject-lock")).toBeLessThan(calls.indexOf("for-update"));
  });
});

// ============================================================
// AUDIT2-RB03：extension lifecycle authority 单元合同
// 真实并发/真实 PostgreSQL 证明见
// tests/integration/audit2-rental-extension-authority.test.ts
// ============================================================

const ORDER_START = new Date("2026-08-08T10:00:00.000Z");
const ORDER_END = new Date("2026-08-10T10:00:00.000Z");
const NEW_END = new Date("2026-08-12T10:00:00.000Z");

function extensionOrderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    ownerId: "user-owner",
    renterId: "user-renter",
    rentalListingId: "listing-1",
    status: "IN_RENTAL",
    startTime: ORDER_START,
    endTime: ORDER_END,
    quantity: 1,
    unitPriceSnapshot: "20",
    pricingUnitSnapshot: "PER_DAY",
    ...overrides,
  };
}

function extensionExtRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ext-1",
    orderId: "order-1",
    requesterId: "user-renter",
    newEndTime: NEW_END,
    additionalFee: "40",
    status: "PENDING",
    ...overrides,
  };
}

/**
 * extension authority 的状态化 mock 事务客户端：
 * $queryRaw 按 SQL 形状路由（RentalExtensionRequest / RentalListing /
 * RentalOrder × FOR UPDATE），并记录 authority 调用序列供锁序断言。
 */
function buildExtensionTx(config: {
  orderPreRead?: unknown[] | null;
  orderRow?: unknown[] | null;
  listingRow?: unknown[] | null;
  extPreRead?: unknown[] | null;
  extRow?: unknown[] | null;
  pendingCount?: number;
  gateCount?: number;
  unavailable?: unknown;
  conflictAvailable?: boolean;
}) {
  const calls: string[] = [];
  const tx = {
    calls,
    $executeRaw: vi.fn(async () => {
      calls.push("subject-lock");
      return 0;
    }),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("");
      const forUpdate = sql.includes("FOR UPDATE");
      if (sql.includes('"RentalExtensionRequest"')) {
        calls.push(forUpdate ? "ext-for-update" : "ext-pre-read");
        return (forUpdate ? config.extRow : config.extPreRead) ?? [];
      }
      if (sql.includes('"RentalListing"')) {
        calls.push("listing-for-update");
        return config.listingRow ?? [];
      }
      if (sql.includes('"RentalOrder"')) {
        calls.push(forUpdate ? "order-for-update" : "order-pre-read");
        return (forUpdate ? config.orderRow : config.orderPreRead) ?? [];
      }
      calls.push("raw-other");
      return [];
    }),
    rentalExtensionRequest: {
      count: vi.fn(async () => {
        calls.push("pending-count");
        return config.pendingCount ?? 0;
      }),
      create: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => {
        calls.push("winner-gate");
        return { count: config.gateCount ?? 1 };
      }),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    rentalUnavailablePeriod: {
      findFirst: vi.fn(async () => config.unavailable ?? null),
    },
    rentalOrder: { update: vi.fn(async () => ({})) },
    rentalOrderStatusLog: { create: vi.fn(async () => ({})) },
  };
  return tx;
}

function asExtensionTx(tx: ReturnType<typeof buildExtensionTx>): Prisma.TransactionClient {
  return tx as unknown as Prisma.TransactionClient;
}

describe("rental-order-machine extension authority (AUDIT2-RB03)", () => {
  beforeEach(() => {
    createNotifications.mockReset();
    createNotifications.mockResolvedValue(undefined);
    checkTimeConflict.mockReset();
    mockAssertActive.mockReset();
    mockAssertActive.mockResolvedValue(undefined);
  });

  it("§9 冻结合同：EXTENSION_ALLOWED_ORDER_STATUSES = IN_RENTAL / PICKED_UP", () => {
    expect([...EXTENSION_ALLOWED_ORDER_STATUSES].sort()).toEqual(["IN_RENTAL", "PICKED_UP"]);
  });

  it("§14 request normal：锁序 subject→order→listing，fee 基于订单 snapshot", async () => {
    const tx = buildExtensionTx({
      orderPreRead: [{ id: "order-1", ownerId: "user-owner", renterId: "user-renter" }],
      orderRow: [extensionOrderRow()],
      listingRow: [{ id: "listing-1" }],
      pendingCount: 0,
      conflictAvailable: true,
    });
    checkTimeConflict.mockResolvedValue({ available: true });

    const result = await requestExtensionTx(asExtensionTx(tx), {
      orderId: "order-1",
      userId: "user-renter",
      newEndTime: NEW_END,
    });

    expect(result).toEqual({ success: true });
    // 完整参与方锁（owner+renter 各一把）→ order 行锁 → listing 行锁 → cardinality
    // （actor ACTIVE 复核位于锁后、order 锁前，由 mock 承接，真实行为见集成测试）
    expect(tx.calls).toEqual([
      "order-pre-read",
      "subject-lock",
      "subject-lock",
      "order-for-update",
      "listing-for-update",
      "pending-count",
    ]);
    expect(tx.rentalExtensionRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: "order-1",
        requesterId: "user-renter",
        status: "PENDING",
        additionalFee: new Prisma.Decimal("40"),
      }),
    });
  });

  it("§16 duplicate pending request blocked：已有 PENDING → 稳定业务错误，零创建", async () => {
    const tx = buildExtensionTx({
      orderPreRead: [{ id: "order-1", ownerId: "user-owner", renterId: "user-renter" }],
      orderRow: [extensionOrderRow()],
      listingRow: [{ id: "listing-1" }],
      pendingCount: 1,
    });

    const result = await requestExtensionTx(asExtensionTx(tx), {
      orderId: "order-1",
      userId: "user-renter",
      newEndTime: NEW_END,
    });

    expect(result).toEqual({ error: "已有待处理的续租请求" });
    expect(tx.rentalExtensionRequest.create).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("request stale status：PENDING_RETURN 不可发起续租", async () => {
    const tx = buildExtensionTx({
      orderPreRead: [{ id: "order-1", ownerId: "user-owner", renterId: "user-renter" }],
      orderRow: [extensionOrderRow({ status: "PENDING_RETURN" })],
      listingRow: [{ id: "listing-1" }],
    });

    const result = await requestExtensionTx(asExtensionTx(tx), {
      orderId: "order-1",
      userId: "user-renter",
      newEndTime: NEW_END,
    });

    expect(result).toEqual({ error: "订单状态错误" });
    expect(tx.rentalExtensionRequest.create).not.toHaveBeenCalled();
  });

  it("§19 request newEnd <= current end：锁内拒绝（非 UI 合同）", async () => {
    const tx = buildExtensionTx({
      orderPreRead: [{ id: "order-1", ownerId: "user-owner", renterId: "user-renter" }],
      orderRow: [extensionOrderRow()],
      listingRow: [{ id: "listing-1" }],
      pendingCount: 0,
    });

    const result = await requestExtensionTx(asExtensionTx(tx), {
      orderId: "order-1",
      userId: "user-renter",
      newEndTime: ORDER_END,
    });

    expect(result).toEqual({ error: "新结束时间必须晚于当前结束时间" });
    expect(tx.rentalExtensionRequest.create).not.toHaveBeenCalled();
  });

  it("§11 account inactive：actor 复核失败即抛 AUTH_ACCOUNT_INACTIVE，零写入", async () => {
    mockAssertActive.mockRejectedValue(
      Object.assign(new Error("account inactive"), { code: "AUTH_ACCOUNT_INACTIVE" }),
    );
    const tx = buildExtensionTx({
      orderPreRead: [{ id: "order-1", ownerId: "user-owner", renterId: "user-renter" }],
      orderRow: [extensionOrderRow()],
      listingRow: [{ id: "listing-1" }],
    });

    await expect(
      requestExtensionTx(asExtensionTx(tx), {
        orderId: "order-1",
        userId: "user-renter",
        newEndTime: NEW_END,
      }),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });

    expect(tx.rentalExtensionRequest.create).not.toHaveBeenCalled();
    // 锁仍已取得（完整参与方锁集在复核之前）
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("§23-§39 approve normal：锁序 USER→ORDER→LISTING→EXTENSION + winner gate + 会计一致", async () => {
    const tx = buildExtensionTx({
      extPreRead: [{ id: "ext-1", orderId: "order-1", ownerId: "user-owner", renterId: "user-renter", listingId: "listing-1" }],
      orderRow: [extensionOrderRow()],
      listingRow: [{ id: "listing-1" }],
      extRow: [extensionExtRow()],
      pendingCount: 1,
      unavailable: null,
      conflictAvailable: true,
      gateCount: 1,
    });
    checkTimeConflict.mockResolvedValue({ available: true });

    const result = await approveExtensionTx(asExtensionTx(tx), {
      extensionRequestId: "ext-1",
      userId: "user-owner",
    });

    expect(result).toEqual({ success: true });
    // §71 静态合同：participant locks → actor 复核（mock）→ ORDER FOR UPDATE
    // → LISTING FOR UPDATE → EXTENSION FOR UPDATE → cardinality → winner gate
    expect(tx.calls).toEqual([
      "ext-pre-read",
      "subject-lock",
      "subject-lock",
      "order-for-update",
      "listing-for-update",
      "ext-for-update",
      "pending-count",
      "winner-gate",
    ]);
    expect(tx.rentalExtensionRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "ext-1", status: "PENDING" },
      data: { status: "APPROVED" },
    });
    // §35-§37：duration 重算（8/8→8/12=4），rentalAmount/finalAmount 各加一次
    expect(tx.rentalOrder.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: {
        endTime: NEW_END,
        rentalDuration: 4,
        rentalAmount: { increment: new Prisma.Decimal("40") },
        finalAmount: { increment: new Prisma.Decimal("40") },
      },
    });
    // §38 same-status log
    expect(tx.rentalOrderStatusLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromStatus: "IN_RENTAL",
        toStatus: "IN_RENTAL",
        note: expect.stringContaining("出租者同意续租"),
      }),
    });
    // §39 winner 通知恰一条
    expect(createNotifications).toHaveBeenCalledTimes(1);
  });

  it("§25 approve stale order state：PENDING_RETURN → 拒绝，extension 保持 PENDING", async () => {
    const tx = buildExtensionTx({
      extPreRead: [{ id: "ext-1", orderId: "order-1", ownerId: "user-owner", renterId: "user-renter", listingId: "listing-1" }],
      orderRow: [extensionOrderRow({ status: "PENDING_RETURN" })],
      listingRow: [{ id: "listing-1" }],
      extRow: [extensionExtRow()],
    });

    const result = await approveExtensionTx(asExtensionTx(tx), {
      extensionRequestId: "ext-1",
      userId: "user-owner",
    });

    expect(result).toEqual({ error: "订单状态已变化，无法续租" });
    expect(tx.rentalExtensionRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.rentalOrder.update).not.toHaveBeenCalled();
  });

  it("§30 approve backward end：newEnd <= fresh endTime → STALE，不缩短订单", async () => {
    const tx = buildExtensionTx({
      extPreRead: [{ id: "ext-1", orderId: "order-1", ownerId: "user-owner", renterId: "user-renter", listingId: "listing-1" }],
      orderRow: [extensionOrderRow()],
      listingRow: [{ id: "listing-1" }],
      extRow: [extensionExtRow({ newEndTime: ORDER_END })],
      pendingCount: 1,
    });

    const result = await approveExtensionTx(asExtensionTx(tx), {
      extensionRequestId: "ext-1",
      userId: "user-owner",
    });

    expect(result).toEqual({ error: "续租请求已过期，请重新提交续租" });
    expect(tx.rentalOrder.update).not.toHaveBeenCalled();
    expect(tx.rentalExtensionRequest.updateMany).not.toHaveBeenCalled();
  });

  it("§31 approve stale fee：基线漂移 FAIL CLOSED，金额零写", async () => {
    const tx = buildExtensionTx({
      extPreRead: [{ id: "ext-1", orderId: "order-1", ownerId: "user-owner", renterId: "user-renter", listingId: "listing-1" }],
      orderRow: [extensionOrderRow()],
      listingRow: [{ id: "listing-1" }],
      extRow: [extensionExtRow({ additionalFee: "999" })],
      pendingCount: 1,
    });

    const result = await approveExtensionTx(asExtensionTx(tx), {
      extensionRequestId: "ext-1",
      userId: "user-owner",
    });

    expect(result).toEqual({ error: "续租费用已变化，请重新提交续租" });
    expect(tx.rentalExtensionRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.rentalOrder.update).not.toHaveBeenCalled();
  });

  it("§29 approve multiple pending anomaly：cardinality != 1 FAIL CLOSED", async () => {
    const tx = buildExtensionTx({
      extPreRead: [{ id: "ext-1", orderId: "order-1", ownerId: "user-owner", renterId: "user-renter", listingId: "listing-1" }],
      orderRow: [extensionOrderRow()],
      listingRow: [{ id: "listing-1" }],
      extRow: [extensionExtRow()],
      pendingCount: 2,
    });

    const result = await approveExtensionTx(asExtensionTx(tx), {
      extensionRequestId: "ext-1",
      userId: "user-owner",
    });

    expect(result).toEqual({ error: "存在多个待处理的续租请求，请先逐个拒绝后再审批" });
    expect(tx.rentalExtensionRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.rentalOrder.update).not.toHaveBeenCalled();
  });

  it("§33 approve unavailable interval：冲突保持 PENDING，零订单写", async () => {
    const tx = buildExtensionTx({
      extPreRead: [{ id: "ext-1", orderId: "order-1", ownerId: "user-owner", renterId: "user-renter", listingId: "listing-1" }],
      orderRow: [extensionOrderRow()],
      listingRow: [{ id: "listing-1" }],
      extRow: [extensionExtRow()],
      pendingCount: 1,
      unavailable: { id: "period-1" },
    });

    const result = await approveExtensionTx(asExtensionTx(tx), {
      extensionRequestId: "ext-1",
      userId: "user-owner",
    });

    expect(result).toEqual({ error: "该时间段已被标记为不可租" });
    expect(tx.rentalExtensionRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.rentalOrder.update).not.toHaveBeenCalled();
  });

  it("§33 approve capacity conflict：库存不足保持 PENDING，零订单写", async () => {
    const tx = buildExtensionTx({
      extPreRead: [{ id: "ext-1", orderId: "order-1", ownerId: "user-owner", renterId: "user-renter", listingId: "listing-1" }],
      orderRow: [extensionOrderRow()],
      listingRow: [{ id: "listing-1" }],
      extRow: [extensionExtRow()],
      pendingCount: 1,
    });
    checkTimeConflict.mockResolvedValue({ available: false, reservedQuantity: 1 });

    const result = await approveExtensionTx(asExtensionTx(tx), {
      extensionRequestId: "ext-1",
      userId: "user-owner",
    });

    expect(result).toEqual({ error: "续租时间段库存不足" });
    expect(tx.rentalExtensionRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.rentalOrder.update).not.toHaveBeenCalled();
  });

  it("approve 非 owner actor：无效请求，零写入", async () => {
    const tx = buildExtensionTx({
      extPreRead: [{ id: "ext-1", orderId: "order-1", ownerId: "user-owner", renterId: "user-renter", listingId: "listing-1" }],
      orderRow: [extensionOrderRow()],
      listingRow: [{ id: "listing-1" }],
      extRow: [extensionExtRow()],
    });

    const result = await approveExtensionTx(asExtensionTx(tx), {
      extensionRequestId: "ext-1",
      userId: "user-not-owner",
    });

    expect(result).toEqual({ error: "无效请求" });
    expect(tx.rentalExtensionRequest.updateMany).not.toHaveBeenCalled();
  });

  it("double approve 输家：extension 已非 PENDING → 无效请求，不再写订单", async () => {
    const tx = buildExtensionTx({
      extPreRead: [{ id: "ext-1", orderId: "order-1", ownerId: "user-owner", renterId: "user-renter", listingId: "listing-1" }],
      orderRow: [extensionOrderRow()],
      listingRow: [{ id: "listing-1" }],
      extRow: [extensionExtRow({ status: "APPROVED" })],
    });

    const result = await approveExtensionTx(asExtensionTx(tx), {
      extensionRequestId: "ext-1",
      userId: "user-owner",
    });

    expect(result).toEqual({ error: "无效请求" });
    expect(tx.rentalOrder.update).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("§40 reject pending：conditional PENDING→REJECTED + renter 通知", async () => {
    const tx = buildExtensionTx({
      extPreRead: [{ id: "ext-1", orderId: "order-1", ownerId: "user-owner", renterId: "user-renter" }],
      orderRow: [extensionOrderRow()],
      extRow: [extensionExtRow()],
      gateCount: 1,
    });

    const result = await rejectExtensionTx(asExtensionTx(tx), {
      extensionRequestId: "ext-1",
      userId: "user-owner",
    });

    expect(result).toEqual({ success: true });
    expect(tx.rentalExtensionRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "ext-1", status: "PENDING" },
      data: { status: "REJECTED" },
    });
    expect(createNotifications).toHaveBeenCalledTimes(1);
  });

  it("§41 reject after order terminal：COMPLETED 订单仍可拒绝清理 stale request", async () => {
    const tx = buildExtensionTx({
      extPreRead: [{ id: "ext-1", orderId: "order-1", ownerId: "user-owner", renterId: "user-renter" }],
      orderRow: [extensionOrderRow({ status: "COMPLETED" })],
      extRow: [extensionExtRow()],
      gateCount: 1,
    });

    const result = await rejectExtensionTx(asExtensionTx(tx), {
      extensionRequestId: "ext-1",
      userId: "user-owner",
    });

    expect(result).toEqual({ success: true });
    expect(tx.rentalExtensionRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "ext-1", status: "PENDING" },
      data: { status: "REJECTED" },
    });
  });

  it("§42 approve vs reject 单胜者：approve 后 reject 见非 PENDING → 无效请求", async () => {
    const winner = buildExtensionTx({
      extPreRead: [{ id: "ext-1", orderId: "order-1", ownerId: "user-owner", renterId: "user-renter", listingId: "listing-1" }],
      orderRow: [extensionOrderRow()],
      listingRow: [{ id: "listing-1" }],
      extRow: [extensionExtRow()],
      pendingCount: 1,
      conflictAvailable: true,
      gateCount: 1,
    });
    checkTimeConflict.mockResolvedValue({ available: true });

    expect(
      await approveExtensionTx(asExtensionTx(winner), { extensionRequestId: "ext-1", userId: "user-owner" }),
    ).toEqual({ success: true });

    const loser = buildExtensionTx({
      extPreRead: [{ id: "ext-1", orderId: "order-1", ownerId: "user-owner", renterId: "user-renter" }],
      orderRow: [extensionOrderRow()],
      extRow: [extensionExtRow({ status: "APPROVED" })],
    });

    expect(
      await rejectExtensionTx(asExtensionTx(loser), { extensionRequestId: "ext-1", userId: "user-owner" }),
    ).toEqual({ error: "无效请求" });
    // 通知只有 winner 一条
    expect(createNotifications).toHaveBeenCalledTimes(1);
  });

  // ---- AUDIT2-RB03 EXTERNAL REVIEW FIX：maximumDuration 总租期合同 ----
  // maximumDuration 约束整个订单 startTime → proposed endTime 的最大总租期
  // （不是单次增量）；request 与 approve 都以 locked listing 现势值为 authority。

  it("EXT-MAX-UNIT-01 request total duration > maximumDuration → blocked，零创建零通知", async () => {
    const tx = buildExtensionTx({
      orderPreRead: [{ id: "order-1", ownerId: "user-owner", renterId: "user-renter" }],
      orderRow: [extensionOrderRow()],
      listingRow: [{ id: "listing-1", maximumDuration: 3 }], // proposed total = 4 天
      pendingCount: 0,
    });

    const result = await requestExtensionTx(asExtensionTx(tx), {
      orderId: "order-1",
      userId: "user-renter",
      newEndTime: NEW_END,
    });

    expect(result).toEqual({ error: "最长租期为 3 个计价单位" });
    expect(tx.rentalExtensionRequest.create).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("EXT-MAX-UNIT-02 approve total duration > maximumDuration → blocked，extension 保持 PENDING 零订单写", async () => {
    const tx = buildExtensionTx({
      extPreRead: [{ id: "ext-1", orderId: "order-1", ownerId: "user-owner", renterId: "user-renter", listingId: "listing-1" }],
      orderRow: [extensionOrderRow()],
      listingRow: [{ id: "listing-1", maximumDuration: 3 }],
      extRow: [extensionExtRow()],
      pendingCount: 1,
    });

    const result = await approveExtensionTx(asExtensionTx(tx), {
      extensionRequestId: "ext-1",
      userId: "user-owner",
    });

    expect(result).toEqual({ error: "最长租期为 3 个计价单位" });
    expect(tx.rentalExtensionRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.rentalOrder.update).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("EXT-MAX-UNIT-03 duration == maximumDuration → request 与 approve 均允许（> 而非 >=）", async () => {
    // proposed total = 8/8 → 8/12 = 4 天，maximumDuration = 4：恰好等于上限
    const requestTx = buildExtensionTx({
      orderPreRead: [{ id: "order-1", ownerId: "user-owner", renterId: "user-renter" }],
      orderRow: [extensionOrderRow()],
      listingRow: [{ id: "listing-1", maximumDuration: 4 }],
      pendingCount: 0,
      conflictAvailable: true,
    });
    checkTimeConflict.mockResolvedValue({ available: true });

    expect(
      await requestExtensionTx(asExtensionTx(requestTx), {
        orderId: "order-1",
        userId: "user-renter",
        newEndTime: NEW_END,
      }),
    ).toEqual({ success: true });
    expect(requestTx.rentalExtensionRequest.create).toHaveBeenCalledTimes(1);

    const approveTx = buildExtensionTx({
      extPreRead: [{ id: "ext-1", orderId: "order-1", ownerId: "user-owner", renterId: "user-renter", listingId: "listing-1" }],
      orderRow: [extensionOrderRow()],
      listingRow: [{ id: "listing-1", maximumDuration: 4 }],
      extRow: [extensionExtRow()],
      pendingCount: 1,
      gateCount: 1,
    });

    expect(
      await approveExtensionTx(asExtensionTx(approveTx), {
        extensionRequestId: "ext-1",
        userId: "user-owner",
      }),
    ).toEqual({ success: true });
    expect(approveTx.rentalExtensionRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(approveTx.rentalOrder.update).toHaveBeenCalledTimes(1);
  });
});
