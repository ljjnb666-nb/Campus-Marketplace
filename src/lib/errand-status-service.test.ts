import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const {
  prepareActiveAccountMutation,
  requireMarketplaceCapability,
  completeErrandOrderTx,
  createNotifications,
} = vi.hoisted(() => ({
  prepareActiveAccountMutation: vi.fn(),
  requireMarketplaceCapability: vi.fn(),
  completeErrandOrderTx: vi.fn(),
  createNotifications: vi.fn(),
}));

vi.mock("@/lib/governance/active-account-mutation", () => ({
  prepareActiveAccountMutation,
}));

vi.mock("@/lib/enforcement/capability-gate", () => ({
  requireMarketplaceCapability,
}));

vi.mock("@/lib/errand-completion", () => ({
  completeErrandOrderTx,
}));

vi.mock("@/repositories/notification-repository", () => ({
  createNotifications,
}));

import { updateErrandStatusTx } from "@/lib/errand-status-service";

/**
 * RB-03 REVIEW FIX：errand status tx authority 单元合同。
 * transition authority = USER 锁内 fresh row（绝不信任事务外 snapshot）；
 * OPEN 追加 marketplace capability；wind-down 目标不要求 capability；
 * COMPLETED 委派唯一 completeErrandOrderTx。
 */

const PUBLISHER = "user-publisher";
const ACCEPTER = "user-accepter";

function makeTx(fresh: unknown) {
  return {
    errandTask: {
      findFirst: vi.fn().mockResolvedValue(fresh),
      update: vi.fn().mockResolvedValue({}),
    },
    order: {
      findFirst: vi.fn().mockResolvedValue({
        id: "order-1",
        buyerId: PUBLISHER,
        sellerId: ACCEPTER,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
  } as unknown as Prisma.TransactionClient & {
    errandTask: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    order: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  };
}

beforeEach(() => {
  prepareActiveAccountMutation.mockReset().mockResolvedValue(undefined);
  requireMarketplaceCapability.mockReset().mockResolvedValue(undefined);
  completeErrandOrderTx.mockReset().mockResolvedValue({ completed: true });
  createNotifications.mockReset().mockResolvedValue(undefined);
});

describe("updateErrandStatusTx（ESTATUS）", () => {
  it("ESTATUS-01：fresh CLAIMED + publisher → OPEN → capability + 撤销接单 + Order CANCELLED", async () => {
    const tx = makeTx({
      id: "errand-1",
      publisherId: PUBLISHER,
      accepterId: ACCEPTER,
      status: "CLAIMED",
      campusId: "campus-1",
    });

    const ok = await updateErrandStatusTx(tx, PUBLISHER, "errand-1", "OPEN");

    expect(ok).toBe(true);
    expect(requireMarketplaceCapability).toHaveBeenCalledWith(tx, PUBLISHER, "campus-1");
    expect(tx.errandTask.update).toHaveBeenCalledWith({
      where: { id: "errand-1" },
      data: { status: "OPEN", accepterId: null },
    });
    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { status: "CANCELLED", cancelReason: "发布者撤销接单" },
    });
  });

  it("ESTATUS-02：fresh CLAIMED + accepter → IN_PROGRESS，无 capability", async () => {
    const tx = makeTx({
      id: "errand-1",
      publisherId: PUBLISHER,
      accepterId: ACCEPTER,
      status: "CLAIMED",
      campusId: "campus-1",
    });

    const ok = await updateErrandStatusTx(tx, ACCEPTER, "errand-1", "IN_PROGRESS");

    expect(ok).toBe(true);
    expect(tx.errandTask.update).toHaveBeenCalled();
    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { status: "IN_PROGRESS" },
    });
    expect(requireMarketplaceCapability).not.toHaveBeenCalled();
  });

  it("ESTATUS-03：fresh IN_PROGRESS + accepter → PENDING_CONFIRMATION，无 capability", async () => {
    const tx = makeTx({
      id: "errand-1",
      publisherId: PUBLISHER,
      accepterId: ACCEPTER,
      status: "IN_PROGRESS",
      campusId: "campus-1",
    });

    const ok = await updateErrandStatusTx(tx, ACCEPTER, "errand-1", "PENDING_CONFIRMATION");

    expect(ok).toBe(true);
    expect(requireMarketplaceCapability).not.toHaveBeenCalled();
  });

  it("ESTATUS-04：PENDING_CONFIRMATION + publisher → COMPLETED 委派 completeErrandOrderTx", async () => {
    const tx = makeTx({
      id: "errand-1",
      publisherId: PUBLISHER,
      accepterId: ACCEPTER,
      status: "PENDING_CONFIRMATION",
      campusId: "campus-1",
    });

    const ok = await updateErrandStatusTx(tx, PUBLISHER, "errand-1", "COMPLETED");

    expect(ok).toBe(true);
    expect(completeErrandOrderTx).toHaveBeenCalledWith(tx, {
      orderId: "order-1",
      errandTaskId: "errand-1",
      buyerId: PUBLISHER,
      sellerId: ACCEPTER,
    });
    // canonical completion：不得叠加任务/订单 status 写
    expect(tx.errandTask.update).not.toHaveBeenCalled();
  });

  it("ESTATUS-05：fresh OPEN + publisher → CANCELLED（wind-down，无 capability）", async () => {
    const tx = makeTx({
      id: "errand-1",
      publisherId: PUBLISHER,
      accepterId: null,
      status: "OPEN",
      campusId: "campus-1",
    });

    const ok = await updateErrandStatusTx(tx, PUBLISHER, "errand-1", "CANCELLED");

    expect(ok).toBe(true);
    expect(tx.errandTask.update).toHaveBeenCalledWith({
      where: { id: "errand-1" },
      data: { status: "CANCELLED" },
    });
    expect(requireMarketplaceCapability).not.toHaveBeenCalled();
  });

  it("ESTATUS-06：fresh 状态与请求 transition 不符（CANCELLED）→ NO-OP 零写", async () => {
    const tx = makeTx({
      id: "errand-1",
      publisherId: PUBLISHER,
      accepterId: ACCEPTER,
      status: "CANCELLED",
      campusId: "campus-1",
    });

    const ok = await updateErrandStatusTx(tx, ACCEPTER, "errand-1", "IN_PROGRESS");

    expect(ok).toBe(false);
    expect(tx.errandTask.update).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it("ESTATUS-07：fresh 角色不符（非 accepter 请求 IN_PROGRESS）→ NO-OP 零写", async () => {
    const tx = makeTx({
      id: "errand-1",
      publisherId: PUBLISHER,
      accepterId: "someone-else",
      status: "CLAIMED",
      campusId: "campus-1",
    });

    const ok = await updateErrandStatusTx(tx, ACCEPTER, "errand-1", "IN_PROGRESS");

    expect(ok).toBe(false);
    expect(tx.errandTask.update).not.toHaveBeenCalled();
  });

  it("ESTATUS-08：AUTH_ACCOUNT_INACTIVE → 零 Errand/Order/Notification 写", async () => {
    prepareActiveAccountMutation.mockRejectedValue(
      Object.assign(new Error("账号当前不可用"), { code: "AUTH_ACCOUNT_INACTIVE" }),
    );
    const tx = makeTx(null);

    await expect(
      updateErrandStatusTx(tx, ACCEPTER, "errand-1", "IN_PROGRESS"),
    ).rejects.toMatchObject({ code: "AUTH_ACCOUNT_INACTIVE" });

    expect(tx.errandTask.update).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });
});
