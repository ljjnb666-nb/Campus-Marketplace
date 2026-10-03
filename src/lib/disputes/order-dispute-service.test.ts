import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  recordAdminAudit,
  txNotificationCreateMany,
  txNotificationFindUnique,
  loadAuthorizationContextMock,
  releaseHoldsBySourceTxLocked,
  projectProductAfterReservationRelease,
} = vi.hoisted(() => ({
  recordAdminAudit: vi.fn(),
  // Phase 9B：canonical notification emit（emitNotificationTx 写边界）
  txNotificationCreateMany: vi.fn(),
  txNotificationFindUnique: vi.fn(),
  loadAuthorizationContextMock: vi.fn(),
  releaseHoldsBySourceTxLocked: vi.fn(),
  projectProductAfterReservationRelease: vi.fn(),
}));

vi.mock("@/lib/governance/admin-audit", () => ({ recordAdminAudit }));
vi.mock("@/lib/privacy/data-hold-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy/data-hold-service")>();
  return {
    ...actual,
    releaseHoldsBySourceTxLocked,
  };
});
vi.mock("@/lib/product-order-lifecycle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/product-order-lifecycle")>();
  return {
    ...actual,
    projectProductAfterReservationRelease,
  };
});
vi.mock("@/lib/rbac/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rbac/service")>();
  return { ...actual, loadAuthorizationContext: loadAuthorizationContextMock };
});

const txStub = {
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  orderDispute: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  order: {
    update: vi.fn(),
  },
  errandTask: {
    update: vi.fn(),
  },
  // Phase 9B：emitNotificationTx 内部写入（createMany + dedupe winner 读回）
  notification: {
    createMany: txNotificationCreateMany,
    findUnique: txNotificationFindUnique,
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  withTransaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(txStub)),
}));

import type { AuthorizationContext } from "@/lib/rbac/service";
import {
  claimOrderDispute,
  closeOrderDispute,
  releaseOrderDispute,
  resolveOrderDispute,
} from "@/lib/disputes/order-dispute-service";

/**
 * Phase 8C-01：claim/release/resolve/close 的锁序前段 + 状态机 + order 收敛 +
 * hold 释放 + 共享 release projection 合同（mock tx；真实 PG 线性化与竞态在
 * tests/integration/phase8c-01）。
 */

const ACTIVE_CTX: AuthorizationContext = {
  userId: "reviewer-1",
  accountActive: true,
  activeCampusIds: ["campus-a"],
  grants: [
    {
      roleKey: "CAMPUS_DISPUTE_REVIEWER",
      scope: "CAMPUS",
      campusId: "campus-a",
      permissionKeys: ["dispute.review"],
    },
  ],
};

function disputeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "dispute-1",
    orderId: "order-1",
    campusId: "campus-a",
    scopeKey: "CAMPUS:campus-a",
    status: "OPEN",
    assignedToId: null,
    openedFromOrderStatus: "ACCEPTED",
    openedFromErrandStatus: null,
    ...overrides,
  };
}

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    type: "PRODUCT",
    status: "IN_DISPUTE",
    buyerId: "buyer-1",
    sellerId: "seller-1",
    productId: "product-1",
    errandTaskId: null,
    ...overrides,
  };
}

function productScenario(disputeOverrides: Record<string, unknown> = {}, orderOverrides: Record<string, unknown> = {}) {
  txStub.orderDispute.findUnique.mockResolvedValue({
    order: { buyerId: "buyer-1", sellerId: "seller-1" },
  });
  txStub.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = Array.isArray(strings) ? strings.join("|") : String(strings);
    if (sql.includes('FROM "ErrandTask"')) {
      return [{ id: "errand-1", status: "DISPUTED" }];
    }
    if (sql.includes('FROM "OrderDispute"')) {
      return [disputeRow(disputeOverrides)];
    }
    if (sql.includes('FROM "Order"')) {
      return [orderRow(orderOverrides)];
    }
    return [];
  });
  txStub.orderDispute.update.mockResolvedValue({});
  txStub.order.update.mockResolvedValue({});
  txStub.errandTask.update.mockResolvedValue({});
  releaseHoldsBySourceTxLocked.mockResolvedValue(2);
}

beforeEach(() => {
  for (const mock of [
    txStub.orderDispute.findUnique,
    txStub.orderDispute.update,
    txStub.order.update,
    txStub.errandTask.update,
    txStub.$queryRaw,
    txStub.$executeRaw,
    recordAdminAudit,
    txNotificationCreateMany,
    txNotificationFindUnique,
    releaseHoldsBySourceTxLocked,
    projectProductAfterReservationRelease,
  ]) {
    mock.mockReset();
  }
  // Phase 9B：emitNotificationTx 写边界（createMany + dedupe winner 读回）
  txNotificationCreateMany.mockResolvedValue({ count: 1 });
  txNotificationFindUnique.mockResolvedValue({ id: "notification-1" });
  loadAuthorizationContextMock.mockReset().mockResolvedValue(ACTIVE_CTX);
});

describe("claimOrderDispute / releaseOrderDispute", () => {
  it("claim：OPEN + 未领用 → IN_REVIEW + assignedTo；audit 记录", async () => {
    productScenario();

    const result = await claimOrderDispute({ actorId: "reviewer-1", disputeId: "dispute-1" });

    expect(result).toEqual({ disputeId: "dispute-1", assignedToId: "reviewer-1", outcome: "CLAIMED" });
    expect(txStub.orderDispute.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "dispute-1" },
        data: { assignedToId: "reviewer-1", status: "IN_REVIEW" },
      }),
    );
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ORDER_DISPUTE_CLAIMED", targetType: "ORDER_DISPUTE" }),
      txStub,
    );
  });

  it("claim：已是自己 → 幂等 ALREADY_YOURS；他人领用 → DISPUTE_ALREADY_CLAIMED", async () => {
    productScenario({ assignedToId: "reviewer-1" });
    expect(
      await claimOrderDispute({ actorId: "reviewer-1", disputeId: "dispute-1" }),
    ).toMatchObject({ outcome: "ALREADY_YOURS" });

    productScenario({ assignedToId: "reviewer-2" });
    await expect(
      claimOrderDispute({ actorId: "reviewer-1", disputeId: "dispute-1" }),
    ).rejects.toMatchObject({ code: "DISPUTE_ALREADY_CLAIMED" });
  });

  it("release：仅 assignee；未领用幂等；IN_REVIEW → OPEN + assignedTo null；dueAt 不重置", async () => {
    productScenario({ assignedToId: "reviewer-1", status: "IN_REVIEW" });
    expect(
      await releaseOrderDispute({ actorId: "reviewer-1", disputeId: "dispute-1" }),
    ).toMatchObject({ outcome: "RELEASED" });
    expect(txStub.orderDispute.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { assignedToId: null, status: "OPEN" },
      }),
    );

    productScenario({ assignedToId: null });
    expect(
      await releaseOrderDispute({ actorId: "reviewer-1", disputeId: "dispute-1" }),
    ).toMatchObject({ outcome: "ALREADY_RELEASED" });

    productScenario({ assignedToId: "reviewer-2", status: "IN_REVIEW" });
    await expect(
      releaseOrderDispute({ actorId: "reviewer-1", disputeId: "dispute-1" }),
    ).rejects.toMatchObject({ code: "DISPUTE_RELEASE_FORBIDDEN" });
  });

  it("claim/release：terminal dispute → DISPUTE_TERMINAL", async () => {
    for (const status of ["RESOLVED", "CLOSED"]) {
      productScenario({ status });
      await expect(
        claimOrderDispute({ actorId: "reviewer-1", disputeId: "dispute-1" }),
      ).rejects.toMatchObject({ code: "DISPUTE_TERMINAL" });
      await expect(
        releaseOrderDispute({ actorId: "reviewer-1", disputeId: "dispute-1" }),
      ).rejects.toMatchObject({ code: "DISPUTE_TERMINAL" });
    }
  });

  it("claim：dispute 行缺失 → DISPUTE_NOT_FOUND；授权 fail closed", async () => {
    productScenario();
    txStub.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join("|") : String(strings);
      return sql.includes('FROM "OrderDispute"') ? [] : [];
    });
    await expect(
      claimOrderDispute({ actorId: "reviewer-1", disputeId: "dispute-1" }),
    ).rejects.toMatchObject({ code: "DISPUTE_NOT_FOUND" });

    productScenario();
    loadAuthorizationContextMock.mockResolvedValue({
      ...ACTIVE_CTX,
      activeCampusIds: ["campus-b"],
      grants: [
        { roleKey: "CAMPUS_DISPUTE_REVIEWER", scope: "CAMPUS", campusId: "campus-b", permissionKeys: ["dispute.review"] },
      ],
    });
    await expect(
      claimOrderDispute({ actorId: "reviewer-1", disputeId: "dispute-1" }),
    ).rejects.toMatchObject({ code: "AUTH_CAMPUS_SCOPE_MISMATCH" });
  });
});

describe("resolveOrderDispute / closeOrderDispute", () => {
  it("RESTORE PRODUCT：IN_DISPUTE → ACCEPTED；零 Product 投影（restore 不释放）", async () => {
    productScenario();

    const result = await resolveOrderDispute({
      actorId: "reviewer-1",
      disputeId: "dispute-1",
      resolutionCode: "OPERATIONAL_REMEDIATION",
      resolutionAction: "RESTORE_PREVIOUS",
    });

    expect(result).toMatchObject({ status: "RESOLVED", orderStatus: "ACCEPTED", releasedHolds: 2 });
    expect(txStub.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "ACCEPTED" } }),
    );
    expect(projectProductAfterReservationRelease).not.toHaveBeenCalled();
    expect(txStub.errandTask.update).not.toHaveBeenCalled();
  });

  it("RESTORE SERVICE：IN_DISPUTE → IN_PROGRESS；零 ServiceListing 写", async () => {
    productScenario(
      { openedFromOrderStatus: "IN_PROGRESS" },
      { type: "SERVICE", productId: null },
    );

    const result = await resolveOrderDispute({
      actorId: "reviewer-1",
      disputeId: "dispute-1",
      resolutionCode: "MUTUAL_AGREEMENT",
      resolutionAction: "RESTORE_PREVIOUS",
    });

    expect(result).toMatchObject({ orderStatus: "IN_PROGRESS" });
    expect(projectProductAfterReservationRelease).not.toHaveBeenCalled();
  });

  it("RESTORE ERRAND：Order + ErrandTask 原子恢复到 snapshots", async () => {
    productScenario(
      {
        openedFromOrderStatus: "IN_PROGRESS",
        openedFromErrandStatus: "PENDING_CONFIRMATION",
      },
      { type: "ERRAND", productId: null, errandTaskId: "errand-1" },
    );

    const result = await resolveOrderDispute({
      actorId: "reviewer-1",
      disputeId: "dispute-1",
      resolutionCode: "EVIDENCE_INSUFFICIENT",
      resolutionAction: "RESTORE_PREVIOUS",
    });

    expect(result).toMatchObject({ orderStatus: "IN_PROGRESS", errandStatus: "PENDING_CONFIRMATION" });
    expect(txStub.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "IN_PROGRESS" } }),
    );
    expect(txStub.errandTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "errand-1" }, data: { status: "PENDING_CONFIRMATION" } }),
    );
    expect(projectProductAfterReservationRelease).not.toHaveBeenCalled();
  });

  it("RESTORE snapshot 非法（type 不允许的源 / ERRAND Task snapshot 缺失）→ DISPUTE_RESTORE_UNAVAILABLE", async () => {
    productScenario({ openedFromOrderStatus: "PENDING" });
    await expect(
      resolveOrderDispute({
        actorId: "reviewer-1",
        disputeId: "dispute-1",
        resolutionCode: "OTHER",
        resolutionAction: "RESTORE_PREVIOUS",
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_RESTORE_UNAVAILABLE" });

    productScenario(
      { openedFromOrderStatus: "IN_PROGRESS", openedFromErrandStatus: null },
      { type: "ERRAND", productId: null, errandTaskId: "errand-1" },
    );
    await expect(
      resolveOrderDispute({
        actorId: "reviewer-1",
        disputeId: "dispute-1",
        resolutionCode: "OTHER",
        resolutionAction: "RESTORE_PREVIOUS",
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_RESTORE_UNAVAILABLE" });
  });

  it("CLOSE PRODUCT：Order → CLOSED + 共享 release projection（RESERVED 释放路径）", async () => {
    productScenario();

    const result = await closeOrderDispute({
      actorId: "reviewer-1",
      disputeId: "dispute-1",
      resolutionAction: "CLOSE_ORDER",
    });

    expect(result).toMatchObject({ status: "CLOSED", orderStatus: "CLOSED", errandStatus: null });
    expect(txStub.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "CLOSED" } }),
    );
    expect(projectProductAfterReservationRelease).toHaveBeenCalledWith(
      txStub,
      "order-1",
      { productId: "product-1", sellerId: "seller-1" },
    );
  });

  it("CLOSE COMPLETED PRODUCT：投影调用天然 no-op（SOLD 不被穿越，由 projection CASE C 保证）", async () => {
    productScenario(
      { openedFromOrderStatus: "COMPLETED" },
      { status: "IN_DISPUTE" },
    );

    await closeOrderDispute({
      actorId: "reviewer-1",
      disputeId: "dispute-1",
      resolutionAction: "CLOSE_ORDER",
    });

    expect(projectProductAfterReservationRelease).toHaveBeenCalledTimes(1);
  });

  it("CLOSE ERRAND：ErrandTask DISPUTED → CLOSED（canonical terminal pair）", async () => {
    productScenario(
      { openedFromOrderStatus: "IN_PROGRESS", openedFromErrandStatus: "PENDING_CONFIRMATION" },
      { type: "ERRAND", productId: null, errandTaskId: "errand-1" },
    );

    const result = await closeOrderDispute({
      actorId: "reviewer-1",
      disputeId: "dispute-1",
      resolutionAction: "CLOSE_ORDER",
    });

    expect(result).toMatchObject({ orderStatus: "CLOSED", errandStatus: "CLOSED" });
    expect(txStub.errandTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "errand-1" }, data: { status: "CLOSED" } }),
    );
    expect(projectProductAfterReservationRelease).not.toHaveBeenCalled();
  });

  it("terminal dispute 不可再终局（reopen 拒绝）；Order 非 IN_DISPUTE → INVALID_TRANSITION", async () => {
    productScenario({ status: "RESOLVED" });
    await expect(
      closeOrderDispute({
        actorId: "reviewer-1",
        disputeId: "dispute-1",
        resolutionAction: "CLOSE_ORDER",
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_TERMINAL" });

    productScenario({ status: "CLOSED" });
    await expect(
      resolveOrderDispute({
        actorId: "reviewer-1",
        disputeId: "dispute-1",
        resolutionCode: "OTHER",
        resolutionAction: "CLOSE_ORDER",
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_TERMINAL" });

    productScenario({}, { status: "ACCEPTED" });
    await expect(
      closeOrderDispute({
        actorId: "reviewer-1",
        disputeId: "dispute-1",
        resolutionAction: "CLOSE_ORDER",
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_INVALID_TRANSITION" });
  });

  it("hold 释放精确按 source；无关 hold 零触碰由 releaseHoldsBySource 合同保证", async () => {
    productScenario();

    await resolveOrderDispute({
      actorId: "reviewer-1",
      disputeId: "dispute-1",
      resolutionCode: "OTHER",
      resolutionAction: "CLOSE_ORDER",
    });

    expect(releaseHoldsBySourceTxLocked).toHaveBeenCalledWith(txStub, {
      sourceType: "ORDER_DISPUTE",
      sourceId: "dispute-1",
      releasedById: "reviewer-1",
    });
  });

  it("终局通知 generic system copy；audit 带 metadata", async () => {
    productScenario();

    await resolveOrderDispute({
      actorId: "reviewer-1",
      disputeId: "dispute-1",
      resolutionCode: "MUTUAL_AGREEMENT",
      resolutionAction: "RESTORE_PREVIOUS",
    });

    // Phase 9B：canonical 双方通知 = buyer + seller 各一条 ORDER_DISPUTE_RESOLVED
    expect(txNotificationCreateMany).toHaveBeenCalledTimes(2);
    expect(txNotificationCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      userId: "buyer-1",
      orderId: "order-1",
      type: "ORDER",
      title: "订单纠纷已处理",
      content: "你的订单纠纷已解决，订单状态已更新。",
      dedupeKey: "ORDER_DISPUTE_RESOLVED:dispute-1:buyer-1",
      kind: "ORDER_DISPUTE_RESOLVED",
      payload: { orderId: "order-1", disputeId: "dispute-1", resolution: "RESOLVED" },
    });
    expect(txNotificationCreateMany.mock.calls[1][0].data[0]).toMatchObject({
      userId: "seller-1",
      orderId: "order-1",
      dedupeKey: "ORDER_DISPUTE_RESOLVED:dispute-1:seller-1",
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ORDER_DISPUTE_RESOLVED",
        targetType: "ORDER_DISPUTE",
        targetId: "dispute-1",
        campusId: "campus-a",
      }),
      txStub,
    );
  });

  it("锁序：pre-read → 完整 sorted USER set → OrderDispute 行锁 → (ErrandTask) → Order 行锁", async () => {
    productScenario(
      { openedFromErrandStatus: "PENDING_CONFIRMATION" },
      { type: "ERRAND", productId: null, errandTaskId: "errand-1" },
    );

    await resolveOrderDispute({
      actorId: "reviewer-1",
      disputeId: "dispute-1",
      resolutionCode: "OTHER",
      resolutionAction: "CLOSE_ORDER",
    });

    const sqlCalls = txStub.$queryRaw.mock.calls.map((call) =>
      (call[0] as TemplateStringsArray).join("|"),
    );
    const disputeLockAt = sqlCalls.findIndex((sql) => sql.includes('FROM "OrderDispute"'));
    const errandLockAt = sqlCalls.findIndex((sql) => sql.includes('FROM "ErrandTask"'));
    // ErrandTask 锁 SQL 内含 "errandTaskId" FROM "Order" 子查询——Order 行锁取
    // 最后一个匹配（WHERE id = ... FOR UPDATE 的主查询）
    const orderLockAt = sqlCalls.findLastIndex((sql) => sql.includes('FROM "Order"'));
    expect(disputeLockAt).toBeGreaterThan(-1);
    expect(errandLockAt).toBe(disputeLockAt + 1);
    expect(orderLockAt).toBe(errandLockAt + 1);
  });
});
