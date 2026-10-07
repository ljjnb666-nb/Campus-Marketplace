import type { Prisma } from "@prisma/client";

import { transitionErrandOrderTx, type ErrandLifecycleSeams } from "@/lib/errand-lifecycle";
import { prepareActiveAccountMutation } from "@/lib/governance/active-account-mutation";
import {
  acceptProductOrderTx,
  cancelProductOrderTx,
} from "@/lib/product-order-lifecycle";
import { emitNotificationsTx } from "@/lib/notifications/notification-service";
import { ORDER_STATUS_CHANGED_KIND } from "@/lib/notifications/notification-registry";
import { recordLiquidityTransactionCompletedTx } from "@/lib/analytics/liquidity-domain-events";

/**
 * RB-03 REVIEW FIX（GROUP 2）：GENERAL ORDER STATUS authority。
 *
 * USER_STATUS_MUTATION_CONTRACT：事务外 Order read 只是 discovery / early
 * UI optimization；最终 owner/participant/status/transition authority 全部
 * 以治理锁内 fresh row 为准。既有 transition matrix 与角色关系保持不变。
 *
 * 不加 marketplace capability：Order progression 属既有义务
 * wind-down/completion——ACTIVE but risk-restricted 用户仍可处理既有义务
 * （Phase 6C-3 合同），只要求 account ACTIVE lifecycle。
 *
 * AUDIT2-RB01：PRODUCT + CANCELLED 不再走本函数的 actor-only general 路径
 * （旧实现曾无条件 Product → ACTIVE，使订单取消错误拥有 listing 重曝光
 * 权威），改为委派唯一权威实现 cancelProductOrderTx（sorted participant
 * 锁 → Order 行锁 → Product 行锁 → 条件投影）。
 *
 * AUDIT2-RB02：ERRAND + IN_PROGRESS / COMPLETED 不再走 general Order-only
 * transition（两个入口各自可写同一业务状态 = cross-entity 竞态），改为在
 * 入口处发现 candidate 后委派唯一 canonical errand lifecycle authority
 * （participant locks → ErrandTask 行锁 → Order 行锁 → pair 谓词 → 写入）。
 * general canTransition 从此不拥有任何 ERRAND 业务 transition。
 *
 * PHASE 8B-01：PRODUCT + ACCEPTED 同样不再走 general 路径（无法与
 * reservation expiry 以同一 deadline 谓词竞争），委派唯一权威实现
 * acceptProductOrderTx（sorted participant 锁 → Order 行锁 → fresh
 * deadline 判定：期限内 ACCEPTED / 超期同一事务 materialize EXPIRED）。
 * general canTransition 从此不拥有任何 PRODUCT ACCEPTED transition。
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

export async function updateOrderStatusTx(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  orderId: string,
  input: UpdateOrderStatusInput,
  seams?: ErrandLifecycleSeams,
): Promise<UpdateOrderStatusResult | null> {
  // AUDIT2-RB02：ERRAND IN_PROGRESS / COMPLETED 入口处委派 canonical errand
  // lifecycle authority。candidate pre-read 只用于分流与锁键发现（type /
  // errandTaskId / buyerId / sellerId），不是 status / participant 权威——
  // 锁后由 transitionErrandOrderTx 重读复核。必须在任何 USER 锁之前委派，
  // 避免先取 actor 锁再追加参与者锁破坏全局 sorted lock discipline。
  if (input.requestedStatus === "IN_PROGRESS" || input.requestedStatus === "COMPLETED") {
    const candidate = await tx.order.findUnique({
      where: { id: orderId },
      select: { type: true, errandTaskId: true, buyerId: true, sellerId: true },
    });

    if (candidate?.type === "ERRAND" && candidate.errandTaskId) {
      const outcome = await transitionErrandOrderTx(
        tx,
        actorUserId,
        orderId,
        {
          errandTaskId: candidate.errandTaskId,
          buyerId: candidate.buyerId,
          sellerId: candidate.sellerId,
        },
        input.requestedStatus,
        seams,
      );

      if (!outcome) {
        return null;
      }

      // RESULT COMPATIBILITY（action/UI 契约不变）
      return {
        productId: null,
        serviceListingId: null,
        errandTaskId: candidate.errandTaskId,
        isBuyer: outcome.isBuyer,
      };
    }
    // 非 ERRAND（或缺失 errandTaskId 的异常行）→ 既有 general 路径（fail closed）
  }

  // PHASE 8B-01：PRODUCT ACCEPTED 委派 canonical accept 权威（期限内
  // ACCEPTED；超期同一事务 materialize EXPIRED 并返回非 null outcome，
  // 确保 action 端 revalidate views——绝不能让页面停留 stale PENDING）。
  // candidate pre-read 只用于锁键发现与分流（type/buyerId/sellerId/
  // productId），不是 status/participant/deadline 权威——锁后由
  // acceptProductOrderTx 重读复核。必须在任何 actor-only USER 锁之前委派
  // （与 PRODUCT CANCELLED 当前 delegation 模式一致），避免先取 actor 锁
  // 再追加参与者锁破坏全局 sorted lock discipline。
  if (input.requestedStatus === "ACCEPTED") {
    const candidate = await tx.order.findUnique({
      where: { id: orderId },
      select: { type: true, buyerId: true, sellerId: true, productId: true },
    });

    if (candidate?.type === "PRODUCT") {
      const acceptance = await acceptProductOrderTx(
        tx,
        actorUserId,
        orderId,
        {
          buyerId: candidate.buyerId,
          sellerId: candidate.sellerId,
          productId: candidate.productId,
        },
        seams,
      );

      if (!acceptance) {
        return null;
      }

      // EXPIRED materialization 同样非 null：revalidate 必须发生
      return {
        productId: candidate.productId,
        serviceListingId: null,
        errandTaskId: null,
        isBuyer: false,
      };
    }
    // SERVICE ACCEPTED → 既有 general actor-only 路径
  }

  // AUDIT2-RB01：PRODUCT CANCELLED 委派 canonical 参与方锁路径。candidate
  // pre-read 只用于锁键发现（buyerId/sellerId/productId/type 分流），
  // 不是 participant/status 权威——锁后由 cancelProductOrderTx 重读复核。
  if (input.requestedStatus === "CANCELLED") {
    const candidate = await tx.order.findUnique({
      where: { id: orderId },
      select: { type: true, buyerId: true, sellerId: true, productId: true },
    });

    if (candidate?.type === "PRODUCT") {
      const cancellation = await cancelProductOrderTx(
        tx,
        actorUserId,
        orderId,
        {
          buyerId: candidate.buyerId,
          sellerId: candidate.sellerId,
          productId: candidate.productId,
        },
        seams,
      );

      if (!cancellation) {
        return null;
      }

      return {
        productId: candidate.productId,
        serviceListingId: null,
        errandTaskId: null,
        isBuyer: cancellation.isBuyer,
      };
    }
    // SERVICE CANCELLED / 订单缺失 → 既有 general actor-only 路径
  }

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
    // PHASE 8B-01：PRODUCT ACCEPTED 已在入口委派 acceptProductOrderTx；
    // general 路径只剩 SERVICE ACCEPTED（defensive：不可达 PRODUCT）
    (requestedStatus === "ACCEPTED" &&
      isSeller &&
      order.status === "PENDING" &&
      order.type === "SERVICE") ||
    // AUDIT2-RB02：ERRAND IN_PROGRESS / COMPLETED 已在入口委派 canonical
    // errand lifecycle；general 路径不再拥有任何 ERRAND 业务 transition
    (requestedStatus === "IN_PROGRESS" &&
      isSeller &&
      order.status === "ACCEPTED" &&
      order.type === "SERVICE") ||
    (requestedStatus === "COMPLETED" &&
      ((order.type === "PRODUCT" && isBuyer && order.status === "ACCEPTED") ||
        (order.type === "SERVICE" &&
          ((isBuyer && order.status === "IN_PROGRESS") ||
            (isSeller && order.status === "IN_PROGRESS"))))) ||
    // AUDIT2-RB01：PRODUCT CANCELLED 的唯一权威是入口处委派的
    // cancelProductOrderTx（type 不可变，正常不可达；防御性 fail closed）
    (requestedStatus === "CANCELLED" &&
      order.type === "SERVICE" &&
      order.status === "PENDING" &&
      (isBuyer || isSeller));

  if (!canTransition) {
    return null;
  }

  // 条件更新充当乐观锁：COMPLETED 的 Order.completedAt 与 liquidity
  // DomainEvent.occurredAt 必须共享同一个业务时钟。
  const completedAt = requestedStatus === "COMPLETED" ? new Date() : null;
  const transitionResult = await tx.order.updateMany({
    where: { id: order.id, status: order.status },
    data: {
      status: requestedStatus,
      completedAt,
      cancelReason: requestedStatus === "CANCELLED" ? "用户主动取消" : null,
    },
  });

  if (transitionResult.count === 0) {
    return null;
  }

  // AUDIT2-RB01：PRODUCT CANCELLED 已在函数入口委派 cancelProductOrderTx
  // （条件化 Product 投影）；本 general 路径只保留 COMPLETED 投影。
  if (order.type === "PRODUCT" && order.productId) {
    if (requestedStatus === "COMPLETED" && completedAt) {
      const product = await tx.product.update({
        where: { id: order.productId },
        data: { status: "SOLD" },
        select: { campusId: true },
      });

      await recordLiquidityTransactionCompletedTx(tx, {
        transactionId: order.id,
        transactionType: "PRODUCT",
        campusId: product.campusId,
        occurredAt: completedAt,
      });
      await incrementCompletedUsers(tx, order.buyerId, order.sellerId);
    }
  }

  if (
    order.type === "SERVICE" &&
    order.serviceListingId &&
    requestedStatus === "COMPLETED" &&
    completedAt
  ) {
    const service = await tx.serviceListing.update({
      where: { id: order.serviceListingId },
      data: { completedOrderCount: { increment: 1 } },
      select: { campusId: true },
    });

    await recordLiquidityTransactionCompletedTx(tx, {
      transactionId: order.id,
      transactionType: "SERVICE",
      campusId: service.campusId,
      occurredAt: completedAt,
    });
    await incrementCompletedUsers(tx, order.buyerId, order.sellerId);
  }

  const actorRole = isBuyer ? "BUYER" : "SELLER";

  await emitNotificationsTx(tx, [
    {
      kind: ORDER_STATUS_CHANGED_KIND,
      recipientUserId: order.buyerId,
      orderId: order.id,
      dedupeKey: `${ORDER_STATUS_CHANGED_KIND}:${order.id}:${requestedStatus}:${order.buyerId}`,
      payload: { orderId: order.id, status: requestedStatus, actorRole },
    },
    {
      kind: ORDER_STATUS_CHANGED_KIND,
      recipientUserId: order.sellerId,
      orderId: order.id,
      dedupeKey: `${ORDER_STATUS_CHANGED_KIND}:${order.id}:${requestedStatus}:${order.sellerId}`,
      payload: { orderId: order.id, status: requestedStatus, actorRole },
    },
  ]);

  return {
    productId: order.productId,
    serviceListingId: order.serviceListingId,
    errandTaskId: order.errandTaskId,
    isBuyer,
  };
}
