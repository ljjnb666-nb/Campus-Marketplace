import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  recordAdminAudit,
  createNotifications,
  loadAuthorizationContextMock,
} = vi.hoisted(() => ({
  recordAdminAudit: vi.fn(),
  createNotifications: vi.fn(),
  loadAuthorizationContextMock: vi.fn(),
}));

vi.mock("@/lib/governance/admin-audit", () => ({ recordAdminAudit }));
vi.mock("@/repositories/notification-repository", () => ({ createNotifications }));
vi.mock("@/lib/rbac/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rbac/service")>();
  return { ...actual, loadAuthorizationContext: loadAuthorizationContextMock };
});

const txStub = {
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  rentalDispute: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  rentalOrder: {
    update: vi.fn(),
  },
  rentalOrderStatusLog: {
    create: vi.fn(),
  },
  dataHold: {
    updateMany: vi.fn(),
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  withTransaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(txStub)),
}));

import { disputeError } from "@/lib/disputes/errors";
import type { AuthorizationContext } from "@/lib/rbac/service";
import {
  claimDispute,
  closeDispute,
  releaseDispute,
  resolveDispute,
} from "@/lib/disputes/dispute-service";

/**
 * Phase 7G：claim/release/resolve/close 的锁序前段 + 状态机 + order 收敛 +
 * hold 释放 + 审计合同（mock tx；真实 PG 线性化在 tests/integration/phase7g）。
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
    campusId: "campus-a",
    scopeKey: "CAMPUS:campus-a",
    status: "OPEN",
    assignedToId: null,
    openedFromOrderStatus: "IN_RENTAL",
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of [
    txStub.$executeRaw,
    txStub.$queryRaw,
    txStub.rentalDispute.findUnique,
    txStub.rentalDispute.update,
    txStub.rentalOrder.update,
    txStub.rentalOrderStatusLog.create,
    txStub.dataHold.updateMany,
    recordAdminAudit,
    createNotifications,
    loadAuthorizationContextMock,
  ]) {
    fn.mockReset();
  }

  txStub.$executeRaw.mockResolvedValue(0);
  txStub.rentalDispute.update.mockResolvedValue({});
  txStub.rentalOrder.update.mockResolvedValue({});
  txStub.rentalOrderStatusLog.create.mockResolvedValue({});
  txStub.dataHold.updateMany.mockResolvedValue({ count: 2 });
  recordAdminAudit.mockResolvedValue(undefined);
  createNotifications.mockResolvedValue({});
  loadAuthorizationContextMock.mockResolvedValue(ACTIVE_CTX);

  // 默认锁读：dispute FOR UPDATE（第一个 $queryRaw）→ order FOR UPDATE（含
  // FROM "RentalOrder" 的那个）
  txStub.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join("");
    if (sql.includes('FROM "RentalOrder"')) {
      return [{ id: "order-1", ownerId: "owner-1", renterId: "renter-1", status: "IN_DISPUTE" }];
    }
    return [disputeRow()];
  });
  // resolve/close 的 lock discovery pre-read（typed client）
  txStub.rentalDispute.findUnique.mockResolvedValue({
    order: { ownerId: "owner-1", renterId: "renter-1" },
  });
});

describe("claimDispute / releaseDispute（USER:actor → dispute 行锁）", () => {
  it("claim：未领用 OPEN → assignedToId=actor ∧ IN_REVIEW + DISPUTE_CLAIMED 审计", async () => {
    const result = await claimDispute({ actorId: "reviewer-1", disputeId: "dispute-1" });

    expect(result).toEqual({
      disputeId: "dispute-1",
      assignedToId: "reviewer-1",
      outcome: "CLAIMED",
    });
    expect(txStub.rentalDispute.update).toHaveBeenCalledWith({
      where: { id: "dispute-1" },
      data: { assignedToId: "reviewer-1", status: "IN_REVIEW" },
      select: { id: true },
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "DISPUTE_CLAIMED", targetId: "dispute-1" }),
      txStub,
    );
    // dueAt 不被 claim 触碰（update data 无 dueAt）
    expect(JSON.stringify(txStub.rentalDispute.update.mock.calls[0]![0].data)).not.toContain("dueAt");
  });

  it("claim：self 重入幂等（ALREADY_YOURS，零写入）", async () => {
    txStub.$queryRaw.mockResolvedValue([
      disputeRow({ status: "IN_REVIEW", assignedToId: "reviewer-1" }),
    ]);

    const result = await claimDispute({ actorId: "reviewer-1", disputeId: "dispute-1" });
    expect(result.outcome).toBe("ALREADY_YOURS");
    expect(txStub.rentalDispute.update).not.toHaveBeenCalled();
  });

  it("claim：他人已领用 → DISPUTE_ALREADY_CLAIMED（fail closed）", async () => {
    txStub.$queryRaw.mockResolvedValue([
      disputeRow({ status: "IN_REVIEW", assignedToId: "other-1" }),
    ]);

    await expect(claimDispute({ actorId: "reviewer-1", disputeId: "dispute-1" })).rejects.toMatchObject({
      code: "DISPUTE_ALREADY_CLAIMED",
    });
    expect(txStub.rentalDispute.update).not.toHaveBeenCalled();
  });

  it("release：非领用人 → DISPUTE_RELEASE_FORBIDDEN", async () => {
    txStub.$queryRaw.mockResolvedValue([
      disputeRow({ status: "IN_REVIEW", assignedToId: "other-1" }),
    ]);

    await expect(releaseDispute({ actorId: "reviewer-1", disputeId: "dispute-1" })).rejects.toMatchObject({
      code: "DISPUTE_RELEASE_FORBIDDEN",
    });
    expect(txStub.rentalDispute.update).not.toHaveBeenCalled();
  });

  it("release：self → IN_REVIEW→OPEN ∧ assignedToId=null + DISPUTE_RELEASED 审计", async () => {
    txStub.$queryRaw.mockResolvedValue([
      disputeRow({ status: "IN_REVIEW", assignedToId: "reviewer-1" }),
    ]);

    const result = await releaseDispute({ actorId: "reviewer-1", disputeId: "dispute-1" });
    expect(result).toEqual({
      disputeId: "dispute-1",
      assignedToId: null,
      outcome: "RELEASED",
    });
    expect(txStub.rentalDispute.update).toHaveBeenCalledWith({
      where: { id: "dispute-1" },
      data: { assignedToId: null, status: "OPEN" },
      select: { id: true },
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "DISPUTE_RELEASED" }),
      txStub,
    );
  });

  it("claim/release：terminal dispute → DISPUTE_TERMINAL（禁止 reopen 路径）", async () => {
    txStub.$queryRaw.mockResolvedValue([disputeRow({ status: "RESOLVED" })]);
    await expect(claimDispute({ actorId: "reviewer-1", disputeId: "dispute-1" })).rejects.toMatchObject({
      code: "DISPUTE_TERMINAL",
    });
    await expect(releaseDispute({ actorId: "reviewer-1", disputeId: "dispute-1" })).rejects.toMatchObject({
      code: "DISPUTE_TERMINAL",
    });
  });

  it("claim：dispute 不存在 → DISPUTE_NOT_FOUND（行锁查询空）", async () => {
    txStub.$queryRaw.mockResolvedValue([]);
    await expect(claimDispute({ actorId: "reviewer-1", disputeId: "d" })).rejects.toMatchObject({
      code: "DISPUTE_NOT_FOUND",
    });
  });

  it("release：未领用幂等 ALREADY_RELEASED；racePoint seam 被调用；malformed pair fail closed", async () => {
    // 未领用 → ALREADY_RELEASED
    txStub.$queryRaw.mockResolvedValue([disputeRow({ assignedToId: null })]);
    const racePoint = vi.fn();
    const result = await releaseDispute({ actorId: "reviewer-1", disputeId: "dispute-1", racePoint });
    expect(result.outcome).toBe("ALREADY_RELEASED");
    expect(racePoint).toHaveBeenCalled();

    // malformed scope pair（DB CHECK 下不可达，纵深防御臂）
    txStub.$queryRaw.mockResolvedValue([
      disputeRow({ campusId: "campus-a", scopeKey: "CAMPUS:other" }),
    ]);
    await expect(releaseDispute({ actorId: "reviewer-1", disputeId: "dispute-1" })).rejects.toMatchObject({
      code: "AUTH_PERMISSION_DENIED",
    });
  });

  it("claim：dispute 行存在但 campus 畸形 → AUTH_PERMISSION_DENIED（fail closed）", async () => {
    txStub.$queryRaw.mockResolvedValue([
      disputeRow({ campusId: null, scopeKey: "CAMPUS:campus-a" }),
    ]);
    await expect(claimDispute({ actorId: "reviewer-1", disputeId: "dispute-1" })).rejects.toMatchObject(
      { code: "AUTH_PERMISSION_DENIED" },
    );
  });

  it("锁后授权重读失败（账号停用）→ AUTH_ACCOUNT_INACTIVE（先于任何写入）", async () => {
    loadAuthorizationContextMock.mockResolvedValue({ ...ACTIVE_CTX, accountActive: false });

    await expect(claimDispute({ actorId: "reviewer-1", disputeId: "dispute-1" })).rejects.toMatchObject({
      code: "AUTH_ACCOUNT_INACTIVE",
    });
    expect(txStub.rentalDispute.update).not.toHaveBeenCalled();
  });
});

describe("resolveDispute / closeDispute（sorted set → 双行锁 → 收敛 → holds → audit）", () => {
  it("resolve RESTORE_PREVIOUS：订单回到 openedFromOrderStatus + holds 释放 + 审计 + 双方通知", async () => {
    const result = await resolveDispute({
      actorId: "reviewer-1",
      disputeId: "dispute-1",
      resolutionCode: "MUTUAL_AGREEMENT",
      resolutionAction: "RESTORE_PREVIOUS",
      adminNote: "协商一致",
    });

    expect(result).toEqual({
      disputeId: "dispute-1",
      status: "RESOLVED",
      orderStatus: "IN_RENTAL",
      releasedHolds: 2,
    });
    expect(txStub.rentalDispute.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "dispute-1" },
        data: expect.objectContaining({
          status: "RESOLVED",
          resolutionCode: "MUTUAL_AGREEMENT",
          resolutionAction: "RESTORE_PREVIOUS",
          resolvedById: "reviewer-1",
          resolvedAt: expect.any(Date),
        }),
      }),
    );
    expect(txStub.rentalOrder.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { status: "IN_RENTAL" },
      select: { id: true },
    });
    expect(txStub.rentalOrderStatusLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ fromStatus: "IN_DISPUTE", toStatus: "IN_RENTAL" }),
    });
    // source-linked holds 精确释放（sourceType=RENTAL_DISPUTE + sourceId=dispute id）
    expect(txStub.dataHold.updateMany).toHaveBeenCalledWith({
      where: {
        sourceType: "RENTAL_DISPUTE",
        sourceId: "dispute-1",
        status: "ACTIVE",
      },
      data: expect.objectContaining({ status: "RELEASED" }),
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DISPUTE_RESOLVED",
        metadata: expect.objectContaining({
          resolutionCode: "MUTUAL_AGREEMENT",
          resolutionAction: "RESTORE_PREVIOUS",
        }),
      }),
      txStub,
    );
    expect(createNotifications).toHaveBeenCalledTimes(1);
  });

  it("RESTORE_PREVIOUS 且 openedFromOrderStatus=null → DISPUTE_RESTORE_UNAVAILABLE（绝不猜历史）", async () => {
    txStub.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join("");
      if (sql.includes('FROM "RentalOrder"')) {
        return [{ id: "order-1", ownerId: "owner-1", renterId: "renter-1", status: "IN_DISPUTE" }];
      }
      return [disputeRow({ openedFromOrderStatus: null })];
    });

    await expect(
      resolveDispute({
        actorId: "reviewer-1",
        disputeId: "dispute-1",
        resolutionCode: "OTHER",
        resolutionAction: "RESTORE_PREVIOUS",
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_RESTORE_UNAVAILABLE" });
    expect(txStub.rentalDispute.update).not.toHaveBeenCalled();
    expect(txStub.rentalOrder.update).not.toHaveBeenCalled();
    expect(txStub.dataHold.updateMany).not.toHaveBeenCalled();
  });

  it("CLOSE_ORDER：订单 → CLOSED + dispute CLOSED（close 无 resolutionCode）", async () => {
    const result = await closeDispute({
      actorId: "reviewer-1",
      disputeId: "dispute-1",
      resolutionAction: "CLOSE_ORDER",
    });

    expect(result.status).toBe("CLOSED");
    expect(result.orderStatus).toBe("CLOSED");
    expect(txStub.rentalDispute.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CLOSED", resolutionAction: "CLOSE_ORDER" }),
      }),
    );
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "DISPUTE_CLOSED" }),
      txStub,
    );
  });

  it("terminal dispute 再终局 → DISPUTE_TERMINAL（禁止 reopen）", async () => {
    txStub.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join("");
      if (sql.includes('FROM "RentalOrder"')) {
        return [{ id: "order-1", ownerId: "owner-1", renterId: "renter-1", status: "CLOSED" }];
      }
      return [disputeRow({ status: "RESOLVED" })];
    });

    await expect(
      resolveDispute({
        actorId: "reviewer-1",
        disputeId: "dispute-1",
        resolutionCode: "OTHER",
        resolutionAction: "CLOSE_ORDER",
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_TERMINAL" });
  });

  it("订单不在 IN_DISPUTE（合同不变量破坏）→ DISPUTE_INVALID_TRANSITION", async () => {
    txStub.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join("");
      if (sql.includes('FROM "RentalOrder"')) {
        return [{ id: "order-1", ownerId: "owner-1", renterId: "renter-1", status: "IN_RENTAL" }];
      }
      return [disputeRow()];
    });

    await expect(
      resolveDispute({
        actorId: "reviewer-1",
        disputeId: "dispute-1",
        resolutionCode: "OTHER",
        resolutionAction: "CLOSE_ORDER",
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_INVALID_TRANSITION" });
  });

  it("锁 discovery pre-read 缺行 → DISPUTE_NOT_FOUND（sorted set 未取）", async () => {
    txStub.rentalDispute.findUnique.mockResolvedValue(null);
    await expect(
      resolveDispute({
        actorId: "reviewer-1",
        disputeId: "ghost",
        resolutionCode: "OTHER",
        resolutionAction: "CLOSE_ORDER",
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_NOT_FOUND" });
  });

  it("终局防御臂：dispute 行锁空 / order 行锁空 / 当事人漂移 → fail closed", async () => {
    // dispute FOR UPDATE 空
    txStub.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join("");
      if (sql.includes('FROM "RentalOrder"')) {
        return [{ id: "order-1", ownerId: "owner-1", renterId: "renter-1", status: "IN_DISPUTE" }];
      }
      return [];
    });
    await expect(
      resolveDispute({
        actorId: "reviewer-1",
        disputeId: "dispute-1",
        resolutionCode: "OTHER",
        resolutionAction: "CLOSE_ORDER",
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_NOT_FOUND" });

    // order FOR UPDATE 空
    txStub.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join("");
      if (sql.includes('FROM "RentalOrder"')) return [];
      return [disputeRow()];
    });
    await expect(
      resolveDispute({
        actorId: "reviewer-1",
        disputeId: "dispute-1",
        resolutionCode: "OTHER",
        resolutionAction: "CLOSE_ORDER",
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_NOT_FOUND" });

    // 当事人漂移（pre-read 与行锁现势不一致）
    txStub.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join("");
      if (sql.includes('FROM "RentalOrder"')) {
        return [{ id: "order-1", ownerId: "owner-X", renterId: "renter-1", status: "IN_DISPUTE" }];
      }
      return [disputeRow()];
    });
    await expect(
      resolveDispute({
        actorId: "reviewer-1",
        disputeId: "dispute-1",
        resolutionCode: "OTHER",
        resolutionAction: "CLOSE_ORDER",
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_INVALID_TRANSITION" });
  });

  it("锁后授权失败 → RbacError 且零副作用（含零 hold 释放）", async () => {
    // 锁内授权重读：context 不可用（null/非激活）统一 AUTH_ACCOUNT_INACTIVE
    loadAuthorizationContextMock.mockResolvedValue(null);
    await expect(
      resolveDispute({
        actorId: "reviewer-1",
        disputeId: "dispute-1",
        resolutionCode: "OTHER",
        resolutionAction: "CLOSE_ORDER",
      }),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });
    expect(txStub.rentalDispute.update).not.toHaveBeenCalled();
    expect(txStub.dataHold.updateMany).not.toHaveBeenCalled();
  });

  it("disputeError 错误码机器可读（status 映射）", () => {
    expect(disputeError("DISPUTE_RESTORE_UNAVAILABLE").status).toBe(409);
    expect(disputeError("DISPUTE_FORBIDDEN").status).toBe(403);
  });
});
