import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const { createNotifications } = vi.hoisted(() => ({
  createNotifications: vi.fn(),
}));

vi.mock("@/repositories/notification-repository", () => ({
  createNotifications,
}));

import { completeErrandOrderTx } from "@/lib/errand-completion";

function buildTx() {
  return {
    errandTask: { updateMany: vi.fn() },
    order: { updateMany: vi.fn() },
    user: { update: vi.fn() },
  };
}

function asTx(tx: ReturnType<typeof buildTx>): Prisma.TransactionClient {
  return tx as unknown as Prisma.TransactionClient;
}

const baseInput = {
  orderId: "order-1",
  errandTaskId: "errand-1",
  buyerId: "user-buyer",
  sellerId: "user-seller",
};

describe("completeErrandOrderTx（ERRAND 完成 exactly-once）", () => {
  beforeEach(() => {
    createNotifications.mockReset();
    createNotifications.mockResolvedValue(undefined);
  });

  it("闸门拒绝：ErrandTask 仍为 IN_PROGRESS（接单者未提交完成）时不产生任何变更", async () => {
    const tx = buildTx();
    tx.errandTask.updateMany.mockResolvedValue({ count: 0 });

    const result = await completeErrandOrderTx(asTx(tx), baseInput);

    expect(result).toEqual({ completed: false });
    // 除闸门外不得触碰任何其它资源：Order/计数/通知全部不变
    expect(tx.errandTask.updateMany).toHaveBeenCalledWith({
      where: { id: "errand-1", status: "PENDING_CONFIRMATION" },
      data: { status: "COMPLETED" },
    });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("过期重试：ErrandTask 已 COMPLETED 时 no-op", async () => {
    const tx = buildTx();
    tx.errandTask.updateMany.mockResolvedValue({ count: 0 });

    const result = await completeErrandOrderTx(asTx(tx), baseInput);

    expect(result).toEqual({ completed: false });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("胜者路径：条件流转两表、双方计数各 +1、每个接收者恰好一条完成通知", async () => {
    const tx = buildTx();
    tx.errandTask.updateMany.mockResolvedValue({ count: 1 });
    tx.order.updateMany.mockResolvedValue({ count: 1 });

    const result = await completeErrandOrderTx(asTx(tx), baseInput);

    expect(result).toEqual({ completed: true });
    expect(tx.errandTask.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "order-1", status: "IN_PROGRESS" },
      data: { status: "COMPLETED", completedAt: expect.any(Date) },
    });
    expect(tx.user.update).toHaveBeenCalledTimes(2);
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "user-buyer" },
      data: { completedOrdersCount: { increment: 1 } },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "user-seller" },
      data: { completedOrdersCount: { increment: 1 } },
    });
    // 每个预期接收者恰好一条完成通知
    expect(createNotifications).toHaveBeenCalledTimes(1);
    const payloads = createNotifications.mock.calls[0][1] as Array<{ userId: string }>;
    expect(payloads).toHaveLength(2);
    expect(payloads.map((p) => p.userId).sort()).toEqual(["user-buyer", "user-seller"]);
  });

  it("冲突防御：闸门通过但 Order 条件更新落空时抛错（调用方事务整体回滚）", async () => {
    const tx = buildTx();
    tx.errandTask.updateMany.mockResolvedValue({ count: 1 });
    tx.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(completeErrandOrderTx(asTx(tx), baseInput)).rejects.toThrow(
      "ERRAND_COMPLETION_CONFLICT",
    );
    // 抛错路径不得已执行任何副作用
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("落败并发：闸门 count=0 直接 no-op，不触碰 Order/计数/通知", async () => {
    const tx = buildTx();
    // 并发场景：胜者已把任务推到 COMPLETED，落败方 updateMany 重新评估后 count=0
    tx.errandTask.updateMany.mockResolvedValue({ count: 0 });

    const result = await completeErrandOrderTx(asTx(tx), baseInput);

    expect(result).toEqual({ completed: false });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(createNotifications).not.toHaveBeenCalled();
  });
});
