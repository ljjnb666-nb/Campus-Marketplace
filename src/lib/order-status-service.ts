import type { Prisma } from "@prisma/client";

import {
  prepareActiveAccountMutation,
  type ActiveAccountMutationSeams,
} from "@/lib/governance/active-account-mutation";
import { completeErrandOrderTx } from "@/lib/errand-completion";
import { createNotifications } from "@/repositories/notification-repository";

/**
 * RB-03 REVIEW FIX（GROUP 2）：GENERAL ORDER STATUS authority。
 *
 * USER_STATUS_MUTATION_CONTRACT：事务外 Order read 只是 discovery / early
 * UI optimization；最终 owner/participant/status/transition authority 全部
 * 以 USER:<actorId> 治理锁内 fresh row 为准。既有 transition matrix 与
 * 角色关系保持不变；ERRAND COMPLETED 继续委派唯一 completeErrandOrderTx。
 *
 * 不加 marketplace capability：Order progression 属既有义务
 * wind-down/completion——ACTIVE but risk-restricted 用户仍可处理既有义务
 * （Phase 6C-3 合同），只要求 account ACTIVE lifecycle。
 *
 * seams 仅测试注入。
 */

export type UpdateOrderStatusInput = {
  requestedStatus: string;
};

export type UpdateOrderStatusResult = {
  productId: string | null;
  serviceListingId: string | null;
  errandTaskId: string | null;
  isBuyer: boolean;
};


/** 完成订单后双方 completedOrdersCount 累加（order.ts 同款语义）。 */
async function incrementCompletedUsers(
  tx: Prisma.TransactionClient,
  buyerId: string,
  sellerId: string,
): Promise<void> {
  await tx.user.update({ where: { id: buyerId }, data: { completedOrdersCount: { increment: 1 } } });
  await tx.user.update({ where: { id: sellerId }, data: { completedOrdersCount: { increment: 1 } } });
}

function getStatusLabel(status: string): string {
  switch (status) {
    case "ACCEPTED":
      return "已接单";
    case "IN_PROGRESS":
      return "进行中";
    case "COMPLETED":
      return "已完成";
    case "CANCELLED":
      return "已取消";
    default:
      return status;
  }
}

export async function updateOrderStatusTx(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  orderId: string,
  input: UpdateOrderStatusInput,
  seams?: ActiveAccountMutationSeams,
): Promise<UpdateOrderStatusResult | null> {
  await prepareActiveAccountMutation(tx, actorUserId, seams);

  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      type: true,
      status: true,
      buyerId: true,
      sellerId: true,
      productId: true,
      errandTaskId: true,
      serviceListingId: true,
    },
  });

  if (!order) {
    return null;
  }

  const isBuyer = order.buyerId === actorUserId;
  const isSeller = order.sellerId === actorUserId;
  const requestedStatus = input.requestedStatus;

  const canTransition =
    (requestedStatus === "ACCEPTED" &&
      isSeller &&
      order.status === "PENDING" &&
      (order.type === "PRODUCT" || order.type === "SERVICE")) ||
    (requestedStatus === "IN_PROGRESS" &&
      isSeller &&
      order.status === "ACCEPTED" &&
      (order.type === "SERVICE" || order.type === "ERRAND")) ||
    (requestedStatus === "COMPLETED" &&
      ((order.type === "PRODUCT" && isBuyer && order.status === "ACCEPTED") ||
        (order.type === "SERVICE" &&
          ((isBuyer && order.status === "IN_PROGRESS") ||
            (isSeller && order.status === "IN_PROGRESS"))) ||
        (order.type === "ERRAND" && isBuyer && order.status === "IN_PROGRESS"))) ||
    (requestedStatus === "CANCELLED" &&
      ((order.type === "PRODUCT" && order.status === "PENDING" && (isBuyer || isSeller)) ||
        (order.type === "SERVICE" && order.status === "PENDING" && (isBuyer || isSeller))));

  if (!canTransition) {
    return null;
  }

  // ERRAND 最终完成走唯一权威实现（completeErrandOrderTx）
  if (order.type === "ERRAND" && order.errandTaskId && requestedStatus === "COMPLETED") {
    const completion = await completeErrandOrderTx(tx, {
      orderId: order.id,
      errandTaskId: order.errandTaskId,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
    });

    if (!completion.completed) {
      return null;
    }

    return {
      productId: null,
      serviceListingId: null,
      errandTaskId: order.errandTaskId,
      isBuyer,
    };
  }

  // 条件更新充当乐观锁：仅当状态仍是 fresh 读取时的状态才允许流转
  const transitionResult = await tx.order.updateMany({
    where: { id: order.id, status: order.status },
    data: {
      status: requestedStatus,
      completedAt: requestedStatus === "COMPLETED" ? new Date() : null,
      cancelReason: requestedStatus === "CANCELLED" ? "用户主动取消" : null,
    },
  });

  if (transitionResult.count === 0) {
    return null;
  }

  if (order.type === "PRODUCT" && order.productId) {
    if (requestedStatus === "CANCELLED") {
      await tx.product.update({
        where: { id: order.productId },
        data: { status: "ACTIVE" },
      });
    }

    if (requestedStatus === "COMPLETED") {
      await tx.product.update({
        where: { id: order.productId },
        data: { status: "SOLD" },
      });

      await incrementCompletedUsers(tx, order.buyerId, order.sellerId);
    }
  }

  if (order.type === "SERVICE" && order.serviceListingId && requestedStatus === "COMPLETED") {
    await tx.serviceListing.update({
      where: { id: order.serviceListingId },
      data: { completedOrderCount: { increment: 1 } },
    });

    await incrementCompletedUsers(tx, order.buyerId, order.sellerId);
  }

  const actorLabel = isBuyer ? "买家" : "卖家";
  const statusLabel = getStatusLabel(requestedStatus);

  await createNotifications(tx, [
    {
      userId: order.buyerId,
      orderId: order.id,
      type: "ORDER",
      title: `订单状态更新：${statusLabel}`,
      content: `${actorLabel}已将订单状态更新为“${statusLabel}”，请前往订单中心查看。`,
    },
    {
      userId: order.sellerId,
      orderId: order.id,
      type: "ORDER",
      title: `订单状态更新：${statusLabel}`,
      content: `${actorLabel}已将订单状态更新为“${statusLabel}”，请前往订单中心查看。`,
    },
  ]);

  return {
    productId: order.productId,
    serviceListingId: order.serviceListingId,
    errandTaskId: order.errandTaskId,
    isBuyer,
  };
}
