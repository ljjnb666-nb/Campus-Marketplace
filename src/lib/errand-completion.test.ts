import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const {
  txNotificationCreateMany,
  txNotificationFindUnique,
} = vi.hoisted(() => ({
  // Phase 9B：canonical notification emit（emitNotificationTx 写边界）
  txNotificationCreateMany: vi.fn(),
  txNotificationFindUnique: vi.fn(),
}));

import { completeErrandOrderTx } from "@/lib/errand-completion";

function buildTx() {
  const tx = {
    errandTask: {
      updateMany: vi.fn(),
      findUnique: vi.fn().mockResolvedValue({
        campusId: "campus-1",
        publisherId: "user-buyer",
        accepterId: "user-seller",
      }),
    },
    order: {
      updateMany: vi.fn(),
      findUnique: vi.fn().mockResolvedValue({
        errandTaskId: "errand-1",
        buyerId: "user-buyer",
        sellerId: "user-seller",
      }),
    },
    domainEvent: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn(),
    },
    asyncJob: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: { update: vi.fn() },
    notification: {
      createMany: txNotificationCreateMany,
      findUnique: txNotificationFindUnique,
    },
  };

  tx.domainEvent.findUnique.mockImplementation(async () => ({
    id: "event-1",
    eventType: "ERRAND_ORDER_COMPLETED",
    schemaVersion: 1,
    aggregateType: "ORDER",
    aggregateId: "order-1",
    campusId: "campus-1",
    actorUserId: null,
    subjectUserId: null,
    payload: { orderId: "order-1", errandTaskId: "errand-1" },
    occurredAt:
      (tx.order.updateMany.mock.calls[0]?.[0]?.data?.completedAt as Date | undefined) ??
      new Date(0),
    sourceType: "DOMAIN_TX",
    sourceId: null,
  }));

  return tx;
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
    // Phase 9B：emitNotificationTx 写边界（createMany + dedupe winner 读回）
    txNotificationCreateMany.mockReset().mockResolvedValue({ count: 1 });
    txNotificationFindUnique.mockReset().mockResolvedValue({ id: "notification-1" });
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
    expect(tx.errandTask.findUnique).not.toHaveBeenCalled();
    expect(tx.domainEvent.createMany).not.toHaveBeenCalled();
    expect(tx.asyncJob.createMany).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(txNotificationCreateMany).not.toHaveBeenCalled();
  });

  it("过期重试：ErrandTask 已 COMPLETED 时 no-op", async () => {
    const tx = buildTx();
    tx.errandTask.updateMany.mockResolvedValue({ count: 0 });

    const result = await completeErrandOrderTx(asTx(tx), baseInput);

    expect(result).toEqual({ completed: false });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.errandTask.findUnique).not.toHaveBeenCalled();
    expect(tx.domainEvent.createMany).not.toHaveBeenCalled();
    expect(tx.asyncJob.createMany).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(txNotificationCreateMany).not.toHaveBeenCalled();
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
    const completedAt = tx.order.updateMany.mock.calls[0]![0].data.completedAt as Date;
    expect(tx.errandTask.findUnique).toHaveBeenCalledWith({
      where: { id: "errand-1" },
      select: { campusId: true, publisherId: true, accepterId: true },
    });
    expect(tx.order.findUnique).toHaveBeenCalledWith({
      where: { id: "order-1" },
      select: { errandTaskId: true, buyerId: true, sellerId: true },
    });
    expect(tx.domainEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          eventType: "ERRAND_ORDER_COMPLETED",
          schemaVersion: 1,
          aggregateType: "ORDER",
          aggregateId: "order-1",
          campusId: "campus-1",
          actorUserId: null,
          subjectUserId: null,
          occurrenceKey: "ERRAND_ORDER_COMPLETED:order-1",
          payload: { orderId: "order-1", errandTaskId: "errand-1" },
          occurredAt: completedAt,
          sourceType: "DOMAIN_TX",
          sourceId: null,
        },
      ],
      skipDuplicates: true,
    });
    expect(tx.asyncJob.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          kind: "ANALYTICS_PROJECT_DOMAIN_EVENT",
          schemaVersion: 1,
          dedupeKey: "ANALYTICS_PROJECT_DOMAIN_EVENT:schema1:projection1:event-1",
          payload: { eventId: "event-1" },
          runAt: expect.any(Date),
        }),
      ],
      skipDuplicates: true,
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
    // 每个预期接收者恰好一条完成通知（Phase 9B：ERRAND_ORDER_COMPLETED 逐条 emit）
    expect(txNotificationCreateMany).toHaveBeenCalledTimes(2);
    const rows = txNotificationCreateMany.mock.calls.map(
      (call) => call[0].data[0] as { userId: string; dedupeKey: string },
    );
    expect(rows.map((row) => row.userId).sort()).toEqual(["user-buyer", "user-seller"]);
    for (const row of rows) {
      expect(row).toMatchObject({
        orderId: "order-1",
        type: "ORDER",
        title: "跑腿订单已完成",
        content: "跑腿任务已确认完成，订单正式结算归档。",
        kind: "ERRAND_ORDER_COMPLETED",
        payload: { orderId: "order-1" },
      });
    }
    expect(rows.map((row) => row.dedupeKey).sort()).toEqual([
      "ERRAND_ORDER_COMPLETED:order-1:user-buyer",
      "ERRAND_ORDER_COMPLETED:order-1:user-seller",
    ]);
  });

  it("scope authority 缺失时 fail closed：事件/计数/通知均不写", async () => {
    const tx = buildTx();
    tx.errandTask.updateMany.mockResolvedValue({ count: 1 });
    tx.order.updateMany.mockResolvedValue({ count: 1 });
    tx.errandTask.findUnique.mockResolvedValue(null);

    await expect(completeErrandOrderTx(asTx(tx), baseInput)).rejects.toThrow(
      "ERRAND_COMPLETION_SCOPE_MISSING",
    );
    expect(tx.domainEvent.createMany).not.toHaveBeenCalled();
    expect(tx.asyncJob.createMany).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(txNotificationCreateMany).not.toHaveBeenCalled();
  });

  it("aggregate binding mismatch 时 fail closed：不能拼接其它 Task/Order 的 tenant scope", async () => {
    const tx = buildTx();
    tx.errandTask.updateMany.mockResolvedValue({ count: 1 });
    tx.order.updateMany.mockResolvedValue({ count: 1 });
    tx.order.findUnique.mockResolvedValue({
      errandTaskId: "other-errand",
      buyerId: "user-buyer",
      sellerId: "user-seller",
    });

    await expect(completeErrandOrderTx(asTx(tx), baseInput)).rejects.toThrow(
      "ERRAND_COMPLETION_AUTHORITY_MISMATCH",
    );
    expect(tx.domainEvent.createMany).not.toHaveBeenCalled();
    expect(tx.asyncJob.createMany).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(txNotificationCreateMany).not.toHaveBeenCalled();
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
    expect(txNotificationCreateMany).not.toHaveBeenCalled();
  });

  it("落败并发：闸门 count=0 直接 no-op，不触碰 Order/计数/通知", async () => {
    const tx = buildTx();
    // 并发场景：胜者已把任务推到 COMPLETED，落败方 updateMany 重新评估后 count=0
    tx.errandTask.updateMany.mockResolvedValue({ count: 0 });

    const result = await completeErrandOrderTx(asTx(tx), baseInput);

    expect(result).toEqual({ completed: false });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.errandTask.findUnique).not.toHaveBeenCalled();
    expect(tx.domainEvent.createMany).not.toHaveBeenCalled();
    expect(tx.asyncJob.createMany).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(txNotificationCreateMany).not.toHaveBeenCalled();
  });
});
