import type { Prisma } from "@prisma/client";

import {
  assertActiveAccountMutationAllowed,
  type ActiveAccountMutationSeams,
} from "@/lib/governance/active-account-mutation";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { evaluateMarketplaceCapability } from "@/lib/enforcement/capability-gate";
import { createNotifications } from "@/repositories/notification-repository";

/**
 * AUDIT2-RB01（PRODUCT LISTING / ORDER AUTHORITY CLOSURE）：
 *
 * 冻结不变量：ORDER WIND-DOWN ≠ LISTING EXPOSURE AUTHORITY。
 * 订单 PENDING → CANCELLED 只拥有"取消订单自身 + 释放 reservation"的权限；
 * Product 是否重新 ACTIVE 必须依据 fresh locked Product state + fresh seller
 * marketplace capability + 无其它 active Product Order 决定，不得由
 * 订单 wind-down 无条件绕过 marketplace 能力边界。
 *
 * 权威锁序（与 createProductOrderTx 的 participant 锁 → Product 行锁兼容，
 * 全局只允许 USER advisory → Order 行 → Product 行，禁止反序）：
 *   sorted {USER:buyer, USER:seller} advisory locks（一次性完整取得）
 *   → Order 行 FOR UPDATE（participant/status/type 权威复核）
 *   → PENDING → CANCELLED（条件更新安全带）
 *   → Product 行 FOR UPDATE（seller/deletedAt/status 权威复核）
 *   → capability / other-active-order reads
 *   → Product 投影写入 → 通知
 *
 * 参与方资格语义：cancellation 属 existing-obligation wind-down，仅要求
 * actor 满足 ACTIVE account mutation contract；counterparty SUSPENDED /
 * restricted 不阻止取消。seller 重新曝光资格只影响 Product 投影目标
 * （ACTIVE vs OFFLINE），绝不 rollback 已合法的订单取消。
 */

/** 会阻止 Product reactivation 的订单状态（COMPLETED/CANCELLED 不占 reservation）。 */
export const ACTIVE_PRODUCT_ORDER_STATUSES: readonly ["PENDING", "ACCEPTED"] = [
  "PENDING",
  "ACCEPTED",
];

/** 锁键发现用 candidate（非 participant/status 权威；锁后必须重读）。 */
export type ProductOrderCancellationCandidate = {
  buyerId: string;
  sellerId: string;
  productId: string | null;
};

/**
 * seams 仅测试注入（生产一律不传）。beforeLock / afterCheck 与
 * ActiveAccountMutationSeams 语义对齐（afterCheck = 参与方锁 + actor
 * lifecycle 复核之后、Order 行权威之前），供 updateOrderStatusTx 直通。
 */
export type ProductOrderCancellationSeams = ActiveAccountMutationSeams & {
  afterOrderRowLock?: (tx: Prisma.TransactionClient) => Promise<void>;
  afterOrderCancelled?: (tx: Prisma.TransactionClient) => Promise<void>;
  afterProductRowLock?: (tx: Prisma.TransactionClient) => Promise<void>;
};

type LockedOrderRow = {
  id: string;
  type: string;
  status: string;
  buyerId: string;
  sellerId: string;
  productId: string | null;
};

type LockedProductRow = {
  id: string;
  campusId: string;
  sellerId: string;
  status: string;
  deletedAt: Date | null;
};

/**
 * PRODUCT 订单取消的唯一权威实现（updateOrderStatusTx 对
 * PRODUCT + CANCELLED 委派至此；authoritative lock / state machine 只此一份）。
 *
 * 返回 null = 无真实 transition（订单缺失 / 非 PRODUCT / 已非 PENDING /
 * actor 非参与方 / candidate 失配 / 条件更新失抢）——零通知零写入。
 */
export async function cancelProductOrderTx(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  orderId: string,
  candidate: ProductOrderCancellationCandidate,
  seams?: ProductOrderCancellationSeams,
): Promise<{ isBuyer: boolean } | null> {
  if (seams?.beforeLock) {
    await seams.beforeLock(tx);
  }

  // 一次性取得 sorted {USER:buyer, USER:seller} 完整锁集：禁止先 actor 锁
  // 再追加 counterparty 锁（会破坏全局 sorted lock discipline）
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: candidate.buyerId },
    { subjectType: "USER", subjectId: candidate.sellerId },
  ]);

  // 仅 actor 需满足 ACTIVE account mutation contract（wind-down 语义）；
  // 刻意不做 requireParticipantsMarketplaceEligible——counterparty 状态
  // 不得阻止既有订单取消
  await assertActiveAccountMutationAllowed(tx, actorUserId);

  if (seams?.afterCheck) {
    await seams.afterCheck(tx);
  }

  const orderRows = await tx.$queryRaw<LockedOrderRow[]>`
    SELECT id, type, status, "buyerId", "sellerId", "productId"
    FROM "Order"
    WHERE id = ${orderId}
    FOR UPDATE
  `;
  const order = orderRows[0];

  if (
    !order ||
    order.type !== "PRODUCT" ||
    order.status !== "PENDING" ||
    (order.buyerId !== actorUserId && order.sellerId !== actorUserId) ||
    order.buyerId !== candidate.buyerId ||
    order.sellerId !== candidate.sellerId ||
    order.productId !== candidate.productId
  ) {
    return null;
  }

  if (seams?.afterOrderRowLock) {
    await seams.afterOrderRowLock(tx);
  }

  // 条件更新保留为最终谓词安全带（行锁下恒真；双取消并发仅一路成功）
  const transitionResult = await tx.order.updateMany({
    where: { id: order.id, status: "PENDING" },
    data: {
      status: "CANCELLED",
      completedAt: null,
      cancelReason: "用户主动取消",
    },
  });

  if (transitionResult.count === 0) {
    return null;
  }

  if (seams?.afterOrderCancelled) {
    await seams.afterOrderCancelled(tx);
  }

  if (order.productId) {
    await projectProductAfterCancellation(tx, order.id, {
      productId: order.productId,
      sellerId: order.sellerId,
    }, seams);
  }

  const isBuyer = order.buyerId === actorUserId;
  const actorLabel = isBuyer ? "买家" : "卖家";

  await createNotifications(tx, [
    {
      userId: order.buyerId,
      orderId: order.id,
      type: "ORDER",
      title: "订单状态更新：已取消",
      content: `${actorLabel}已将订单状态更新为“已取消”，请前往订单中心查看。`,
    },
    {
      userId: order.sellerId,
      orderId: order.id,
      type: "ORDER",
      title: "订单状态更新：已取消",
      content: `${actorLabel}已将订单状态更新为“已取消”，请前往订单中心查看。`,
    },
  ]);

  return { isBuyer };
}

/**
 * 取消后的 Product 状态投影（CASE A–E）：
 *   A. RESERVED + 未删除 + 无其它 active order + seller capability PASS → ACTIVE
 *   B. RESERVED + 未删除 + 无其它 active order + seller capability FAIL → OFFLINE
 *      （reservation without active obligation 的安全 wind-down 投影；
 *        订单取消本身仍然 COMMIT）
 *   C. 当前 OFFLINE / SOLD / ACTIVE → 不覆盖（卖家显式态不被 wind-down 穿越）
 *   D. deletedAt != null → 不写（禁止复活 contradictory lifecycle state）
 *   E. 存在其它 PENDING/ACCEPTED PRODUCT order → 保持 RESERVED
 */
async function projectProductAfterCancellation(
  tx: Prisma.TransactionClient,
  cancelledOrderId: string,
  input: { productId: string; sellerId: string },
  seams?: ProductOrderCancellationSeams,
): Promise<void> {
  const productRows = await tx.$queryRaw<LockedProductRow[]>`
    SELECT id, "campusId", "sellerId", status, "deletedAt"
    FROM "Product"
    WHERE id = ${input.productId}
    FOR UPDATE
  `;
  const product = productRows[0];

  // 行缺失 / seller 失配（历史异常）→ fail closed：零 listing 写入
  if (!product || product.sellerId !== input.sellerId) {
    return;
  }

  if (seams?.afterProductRowLock) {
    await seams.afterProductRowLock(tx);
  }

  // CASE D：软删除不复活
  if (product.deletedAt !== null) {
    return;
  }

  // CASE C：只有 RESERVED 属于可重新投影的 reservation 态
  if (product.status !== "RESERVED") {
    return;
  }

  // CASE E：其它 active PRODUCT order 仍占用 reservation（历史异常/防御安全带）
  const otherActiveOrder = await tx.order.findFirst({
    where: {
      productId: product.id,
      type: "PRODUCT",
      id: { not: cancelledOrderId },
      status: { in: [...ACTIVE_PRODUCT_ORDER_STATUSES] },
    },
    select: { id: true },
  });
  if (otherActiveOrder) {
    return;
  }

  // CASE A/B：seller USER 锁已持有 → checks-only 能力判定决定重新曝光资格。
  // 刻意不用 requireMarketplaceCapability：seller capability 失败不能
  // rollback 已合法的订单取消
  const capability = await evaluateMarketplaceCapability(
    tx,
    input.sellerId,
    product.campusId,
  );

  await tx.product.update({
    where: { id: product.id },
    data: { status: capability.allowed ? "ACTIVE" : "OFFLINE" },
  });
}
