import type { Prisma } from "@prisma/client";
import { createNotifications } from "@/repositories/notification-repository";

/**
 * ERRAND 订单完成的唯一权威实现（exactly-once）。
 *
 * 业务不变量：仅当 Order.status === IN_PROGRESS 且
 * ErrandTask.status === PENDING_CONFIRMATION 时才允许最终完成——
 * "接单者开始履约"（Order → IN_PROGRESS）不等于"可确认完成"，
 * 发布者不得在接单者提交完成之前提前结单。
 *
 * 订单中心（updateOrderStatus）与跑腿详情页（updateErrandStatus）
 * 两个入口都收敛到这里，完成副作用只有这一份实现：
 *
 * - 资源更新顺序固定为 ErrandTask → Order（单一实现天然无锁序倒置）；
 * - ErrandTask 的条件 updateMany 是胜者闸门：并发下只有一个事务能把
 *   PENDING_CONFIRMATION 推到 COMPLETED（READ COMMITTED 下落败方的
 *   UPDATE 在行锁释放后重新评估 WHERE，count=0）；
 * - 落败/过期重试返回 { completed: false }，不产生任何计数与通知；
 * - 闸门通过但 Order 条件更新落空（数据不一致的防御分支）时抛错，
 *   整个事务回滚，两表都不留半程状态。
 */
export type ErrandCompletionResult = { completed: boolean };

export async function completeErrandOrderTx(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string;
    errandTaskId: string;
    buyerId: string;
    sellerId: string;
  },
): Promise<ErrandCompletionResult> {
  // 1) 胜者闸门：ErrandTask 必须处于 PENDING_CONFIRMATION。
  //    ErrandTask 仍在 IN_PROGRESS（接单者未提交完成）时在此被拒——
  //    即使伪造 Server Action 请求绕过 UI 也不能提前完成。
  const taskResult = await tx.errandTask.updateMany({
    where: { id: input.errandTaskId, status: "PENDING_CONFIRMATION" },
    data: { status: "COMPLETED" },
  });

  if (taskResult.count === 0) {
    return { completed: false };
  }

  // 2) Order 条件流转（乐观锁）
  const orderResult = await tx.order.updateMany({
    where: { id: input.orderId, status: "IN_PROGRESS" },
    data: { status: "COMPLETED", completedAt: new Date() },
  });

  if (orderResult.count === 0) {
    throw new Error("ERRAND_COMPLETION_CONFLICT");
  }

  // 3) 副作用仅由胜者事务执行：完成计数 + 完成通知（每个接收者恰好一条）
  await tx.user.update({
    where: { id: input.buyerId },
    data: { completedOrdersCount: { increment: 1 } },
  });

  await tx.user.update({
    where: { id: input.sellerId },
    data: { completedOrdersCount: { increment: 1 } },
  });

  await createNotifications(tx, [
    {
      userId: input.buyerId,
      orderId: input.orderId,
      type: "ORDER",
      title: "跑腿订单已完成",
      content: "跑腿任务已确认完成，订单正式结算归档。",
    },
    {
      userId: input.sellerId,
      orderId: input.orderId,
      type: "ORDER",
      title: "跑腿订单已完成",
      content: "跑腿任务已确认完成，订单正式结算归档。",
    },
  ]);

  return { completed: true };
}
