import type { Prisma } from "@prisma/client";

import { emitNotificationsTx } from "@/lib/notifications/notification-service";
import { ERRAND_ORDER_COMPLETED_KIND } from "@/lib/notifications/notification-registry";
import { recordDomainEventTx } from "@/lib/domain-events/domain-event";
import {
  ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_AGGREGATE_TYPE,
  ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_SCHEMA_VERSION,
  ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_TYPE,
} from "@/lib/domain-events/domain-event-registry";
import { recordLiquidityTransactionCompletedTx } from "@/lib/analytics/liquidity-domain-events";

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
 * - 落败/过期重试返回 { completed: false }，不产生任何计数、通知或事件；
 * - 闸门通过但 Order 条件更新落空（数据不一致的防御分支）时抛错，
 *   整个事务回滚，两表都不留半程状态；
 * - Phase 10A：胜者在同一事务内追加 ERRAND_ORDER_COMPLETED DomainEvent。
 *   campusId 必须来自 winner ErrandTask 的事务内 canonical row，绝不信任
 *   request/input；事件写失败必须回滚订单完成与全部副作用。
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

  // 2) Order 条件流转（乐观锁）。occurredAt 与 completedAt 共用同一业务时钟，
  //    后续 metric/replay 禁止使用 worker/recordedAt 冒充业务发生时间。
  const occurredAt = new Date();
  const orderResult = await tx.order.updateMany({
    where: { id: input.orderId, status: "IN_PROGRESS" },
    data: { status: "COMPLETED", completedAt: occurredAt },
  });

  if (orderResult.count === 0) {
    throw new Error("ERRAND_COMPLETION_CONFLICT");
  }

  // 3) Aggregate binding safety belt：即使未来新增 caller，也不能靠 input
  //    拼接一个 Task 与另一张 Order。两个正式 lifecycle caller 已在锁内验证，
  //    此处仍由 completion authority 自己复核 participant + relation。
  const [taskScope, orderScope] = await Promise.all([
    tx.errandTask.findUnique({
      where: { id: input.errandTaskId },
      select: { campusId: true, publisherId: true, accepterId: true },
    }),
    tx.order.findUnique({
      where: { id: input.orderId },
      select: { errandTaskId: true, buyerId: true, sellerId: true },
    }),
  ]);
  if (!taskScope || !orderScope) {
    throw new Error("ERRAND_COMPLETION_SCOPE_MISSING");
  }
  if (
    taskScope.publisherId !== input.buyerId ||
    taskScope.accepterId !== input.sellerId ||
    orderScope.errandTaskId !== input.errandTaskId ||
    orderScope.buyerId !== input.buyerId ||
    orderScope.sellerId !== input.sellerId
  ) {
    throw new Error("ERRAND_COMPLETION_AUTHORITY_MISMATCH");
  }

  // 4) authoritative fact ledger：domain mutation + event 同一事务原子提交。
  await recordDomainEventTx(tx, {
    eventType: ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_TYPE,
    schemaVersion: ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_SCHEMA_VERSION,
    aggregateType: ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_AGGREGATE_TYPE,
    aggregateId: input.orderId,
    campusId: taskScope.campusId,
    occurredAt,
    payload: {
      orderId: input.orderId,
      errandTaskId: input.errandTaskId,
    },
  });

  // 10C-1 unified liquidity fact。旧 10A ERRAND_ORDER_COMPLETED 继续保留
  // 作为历史兼容事实；projection v2 只消费本统一事件，避免双计。
  await recordLiquidityTransactionCompletedTx(tx, {
    transactionId: input.orderId,
    transactionType: "ERRAND",
    campusId: taskScope.campusId,
    occurredAt,
  });

  // 5) 副作用仅由胜者事务执行：完成计数 + 完成通知（每个接收者恰好一条）
  await tx.user.update({
    where: { id: input.buyerId },
    data: { completedOrdersCount: { increment: 1 } },
  });

  await tx.user.update({
    where: { id: input.sellerId },
    data: { completedOrdersCount: { increment: 1 } },
  });

  await emitNotificationsTx(tx, [
    {
      kind: ERRAND_ORDER_COMPLETED_KIND,
      recipientUserId: input.buyerId,
      orderId: input.orderId,
      dedupeKey: `${ERRAND_ORDER_COMPLETED_KIND}:${input.orderId}:${input.buyerId}`,
      payload: { orderId: input.orderId },
    },
    {
      kind: ERRAND_ORDER_COMPLETED_KIND,
      recipientUserId: input.sellerId,
      orderId: input.orderId,
      dedupeKey: `${ERRAND_ORDER_COMPLETED_KIND}:${input.orderId}:${input.sellerId}`,
      payload: { orderId: input.orderId },
    },
  ]);

  return { completed: true };
}
