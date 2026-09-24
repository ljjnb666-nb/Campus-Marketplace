import type { ErrandTaskStatus, Prisma } from "@prisma/client";

import {
  prepareActiveAccountMutation,
  type ActiveAccountMutationSeams,
} from "@/lib/governance/active-account-mutation";
import { requireMarketplaceCapability } from "@/lib/enforcement/capability-gate";
import { completeErrandOrderTx } from "@/lib/errand-completion";
import { createNotifications } from "@/repositories/notification-repository";

/**
 * RB-03 REVIEW FIX：跑腿任务状态 mutation 的 tx authority（冻结 §14/§15）。
 *
 * 事务外的 errand / isPublisher / isAccepter / canTransition 都是 stale
 * snapshot，不能作为 transition authority。本 helper 在 USER:<actorId>
 * 治理锁 + fresh ACTIVE 复核之后重新读取 fresh row 并重算全部 transition
 * 判定：
 *
 *   USER lock → fresh lifecycle → fresh errand row
 *   → fresh isPublisher/isAccepter + canTransition（既有状态机表，不扩大）
 *   → OPEN（重新暴露为可接单）追加 requireMarketplaceCapability
 *   → 写入 / COMPLETED 委派唯一 completeErrandOrderTx
 *
 * 非 OPEN 目标（IN_PROGRESS/PENDING_CONFIRMATION/COMPLETED/CANCELLED）
 * 是既有义务 wind-down：不要求 marketplace capability，但要求 ACTIVE
 * lifecycle——ACTIVE but RISK_RESTRICTED 仍可 wind-down（Phase 6C-3 语义）。
 *
 * COMPLETED 保持委派唯一 completeErrandOrderTx（其自身不取得 USER
 * governance subject lock，USER → sorted multi-USER 反序不成立）。
 *
 * fresh missing / transition 不合法 / 角色不符 → NO-OP（false），保持
 * 原 action 静默安全语义。seams 仅测试注入。
 */

function getErrandStatusLabel(
  status: "OPEN" | "CLAIMED" | "IN_PROGRESS" | "PENDING_CONFIRMATION" | "COMPLETED" | "CANCELLED",
) {
  switch (status) {
    case "OPEN":
      return "待接单";
    case "CLAIMED":
      return "已接单";
    case "IN_PROGRESS":
      return "进行中";
    case "PENDING_CONFIRMATION":
      return "待确认完成";
    case "COMPLETED":
      return "已完成";
    case "CANCELLED":
      return "已取消";
  }
}

export async function updateErrandStatusTx(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  errandId: string,
  requestedStatus: ErrandTaskStatus,
  seams?: ActiveAccountMutationSeams,
): Promise<boolean> {
  await prepareActiveAccountMutation(tx, actorUserId, seams);

  // ---- fresh row = transition authority（绝不信任事务外 snapshot）----
  const fresh = await tx.errandTask.findFirst({
    where: { id: errandId, deletedAt: null },
    select: {
      id: true,
      publisherId: true,
      accepterId: true,
      status: true,
      campusId: true,
    },
  });

  if (!fresh) {
    return false;
  }

  const isPublisher = fresh.publisherId === actorUserId;
  const isAccepter = fresh.accepterId === actorUserId;

  // 既有 transition table（以 fresh status 重算，不扩大状态机）
  const canTransition =
    (requestedStatus === "OPEN" && isPublisher && fresh.status === "CLAIMED") ||
    (requestedStatus === "IN_PROGRESS" && isAccepter && fresh.status === "CLAIMED") ||
    (requestedStatus === "PENDING_CONFIRMATION" && isAccepter && fresh.status === "IN_PROGRESS") ||
    (requestedStatus === "COMPLETED" && isPublisher && fresh.status === "PENDING_CONFIRMATION") ||
    (requestedStatus === "CANCELLED" && isPublisher && fresh.status === "OPEN");

  if (!canTransition) {
    return false;
  }

  if (requestedStatus === "OPEN") {
    // EXPOSURE_INCREASING：CLAIMED 撤销接单重新暴露为可接单
    await requireMarketplaceCapability(tx, actorUserId, fresh.campusId);
  }

  if (requestedStatus === "COMPLETED") {
    // COMPLETED 走唯一权威实现（completeErrandOrderTx，自身不取 USER
    // governance subject lock）：硬性要求 Order IN_PROGRESS +
    // ErrandTask PENDING_CONFIRMATION，exactly-once 副作用与完成通知
    // 都在 canonical 事务内
    const latestOrder = await tx.order.findFirst({
      where: { errandTaskId: errandId },
      orderBy: { createdAt: "desc" },
      select: { id: true, buyerId: true, sellerId: true },
    });

    if (!latestOrder) {
      return false;
    }

    const completion = await completeErrandOrderTx(tx, {
      orderId: latestOrder.id,
      errandTaskId: errandId,
      buyerId: latestOrder.buyerId,
      sellerId: latestOrder.sellerId,
    });

    return completion.completed;
  }

  await tx.errandTask.update({
    where: { id: errandId },
    data: {
      status: requestedStatus,
      ...(requestedStatus === "OPEN" ? { accepterId: null } : {}),
    },
  });

  const latestOrder = await tx.order.findFirst({
    where: { errandTaskId: errandId },
    orderBy: { createdAt: "desc" },
    select: { id: true, buyerId: true, sellerId: true },
  });

  if (!latestOrder) {
    return true;
  }

  if (requestedStatus === "OPEN") {
    await tx.order.update({
      where: { id: latestOrder.id },
      data: {
        status: "CANCELLED",
        cancelReason: "发布者撤销接单",
      },
    });
  }

  if (requestedStatus === "IN_PROGRESS") {
    await tx.order.update({
      where: { id: latestOrder.id },
      data: { status: "IN_PROGRESS" },
    });
  }

  const statusLabel = getErrandStatusLabel(requestedStatus);

  await createNotifications(tx, [
    {
      userId: fresh.publisherId,
      orderId: latestOrder.id,
      type: "ORDER",
      title: `跑腿任务状态更新：${statusLabel}`,
      content: `当前跑腿任务状态已更新为“${statusLabel}”，请前往订单中心查看。`,
    },
    {
      userId: latestOrder.sellerId,
      orderId: latestOrder.id,
      type: "ORDER",
      title: `跑腿任务状态更新：${statusLabel}`,
      content: `当前跑腿任务状态已更新为“${statusLabel}”，请前往订单中心查看。`,
    },
  ]);

  return true;
}
