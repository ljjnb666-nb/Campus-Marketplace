import type { Prisma } from "@prisma/client";

import {
  assertActiveAccountMutationAllowed,
  type ActiveAccountMutationSeams,
} from "@/lib/governance/active-account-mutation";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { evaluateMarketplaceCapability } from "@/lib/enforcement/capability-gate";
import {
  isProductReservationExpired,
  PRODUCT_RESERVATION_EXPIRED_CANCEL_REASON,
} from "@/lib/product-reservation";
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
 * Phase 8B-01（PRODUCT RESERVATION DEADLINE）：本模块是 PRODUCT 订单
 * accept / cancel / reservation expiry 的唯一权威（updateOrderStatusTx 对
 * PRODUCT + ACCEPTED / PRODUCT + CANCELLED 均委派至此）。seller 确认截止
 * 由 productReservationExpiresAt 表达，时间边界统一走
 * isProductReservationExpired（now >= expiresAt = EXPIRED）：
 *   - accept 期限内：PENDING → ACCEPTED，resolution = ACCEPTED
 *     （Product remains RESERVED——seller 义务期内显式 OFFLINE 不被 accept 重开）
 *   - accept/cancel 超期：deadline truth > late user intent——同一事务内
 *     materialize EXPIRED（不接受、不记 CANCELLED resolution）
 *   - explicit expire：system lifecycle materialization，无 user actor，
 *     任何参与方生命周期状态都不得阻止关闭（capability 只影响 Product
 *     重新曝光目标，绝不 rollback expiration）
 *
 * 权威锁序（与 createProductOrderTx 的 participant 锁 → Product 行锁兼容，
 * 全局只允许 USER advisory → Order 行 → Product 行，禁止反序）：
 *   candidate discovery（仅锁键/分流发现，非权威）
 *   → sorted {USER:buyer, USER:seller} advisory locks（一次性完整取得）
 *   → Order 行 FOR UPDATE（participant/status/type/deadline 权威复核）
 *   → 条件更新安全带（PENDING → CANCELLED / ACCEPTED）
 *   → Product 行 FOR UPDATE（seller/deletedAt/status 权威复核）
 *   → capability / other-active-order reads
 *   → Product 投影写入 → 通知
 *
 * 参与方资格语义：accept/cancel 属既有义务 progression/wind-down，仅要求
 * actor 满足 ACTIVE account mutation contract；counterparty SUSPENDED /
 * restricted 不阻止。seller 重新曝光资格只影响 Product 投影目标
 * （ACTIVE vs OFFLINE），绝不 rollback 已合法的订单 mutation。
 * explicit expire 无 user actor：不做任何 ACTIVE account 检查。
 */

/**
 * 会阻止 Product reactivation 的订单状态（COMPLETED/CANCELLED/CLOSED 不占
 * reservation）。Phase 8C-01：IN_DISPUTE 属 dispute 治理冻结，仍是 active
 * reservation occupancy——否则其它 release path 可能在 dispute 期间错误释放
 * Product（dispute CLOSE 才触发 release projection）。
 */
export const ACTIVE_PRODUCT_ORDER_STATUSES: readonly [
  "PENDING",
  "ACCEPTED",
  "IN_DISPUTE",
] = ["PENDING", "ACCEPTED", "IN_DISPUTE"];

/** 锁键发现用 candidate（非 participant/status 权威；锁后必须重读）。 */
export type ProductOrderCancellationCandidate = {
  buyerId: string;
  sellerId: string;
  productId: string | null;
};

/** accept 的锁键发现 candidate（语义与 cancellation candidate 一致）。 */
export type ProductOrderAcceptanceCandidate = ProductOrderCancellationCandidate;

/**
 * seams 仅测试注入（生产一律不传）。beforeLock / afterCheck 与
 * ActiveAccountMutationSeams 语义对齐（afterCheck = 参与方锁 + actor
 * lifecycle 复核之后、Order 行权威之前），供 updateOrderStatusTx 直通；
 * afterOrderRowLock = fresh 谓词 + deadline 判定之后、写入之前（accept 与
 * 超期 EXPIRED materialization 共用同一暂停点），供 updateOrderStatusTx 直通。
 */
export type ProductOrderCancellationSeams = ActiveAccountMutationSeams & {
  afterOrderRowLock?: (tx: Prisma.TransactionClient) => Promise<void>;
  afterOrderCancelled?: (tx: Prisma.TransactionClient) => Promise<void>;
  afterProductRowLock?: (tx: Prisma.TransactionClient) => Promise<void>;
};

export type ProductOrderAcceptanceSeams = ActiveAccountMutationSeams & {
  afterOrderRowLock?: (tx: Prisma.TransactionClient) => Promise<void>;
};

/** expiry 的测试 seam（生产不传）：beforeLock = pair 锁前；afterOrderRowLock
 * = fresh 谓词 + due 判定之后、EXPIRED materialization 之前。 */
export type ProductReservationExpirySeams = {
  beforeLock?: (tx: Prisma.TransactionClient) => Promise<void>;
  afterOrderRowLock?: (tx: Prisma.TransactionClient) => Promise<void>;
};

/** accept 的 domain outcome：期限内 ACCEPTED；超期时同一事务内 materialize
 * EXPIRED（两者都非 null——调用方必须 revalidate Order/Product views）。 */
export type ProductOrderAcceptanceOutcome = {
  reservationResolution: "ACCEPTED" | "EXPIRED";
};

/** explicit expire 的 domain outcome（结构异常行 = null，不可重试）。 */
export type ProductReservationExpiryOutcome =
  | { kind: "EXPIRED" }
  | { kind: "NOT_DUE" }
  | { kind: "NOT_PENDING" };

type LockedOrderRow = {
  id: string;
  type: string;
  status: string;
  buyerId: string;
  sellerId: string;
  productId: string | null;
  productReservationExpiresAt: Date | null;
};

type LockedProductRow = {
  id: string;
  campusId: string;
  sellerId: string;
  status: string;
  deletedAt: Date | null;
};

/** PRODUCT 订单取消的唯一权威实现（updateOrderStatusTx 对
 * PRODUCT + CANCELLED 委派至此；authoritative lock / state machine 只此一份）。
 *
 * 返回 null = 无真实 transition（订单缺失 / 非 PRODUCT / 已非 PENDING /
 * actor 非参与方 / candidate 失配 / 条件更新失抢）——零通知零写入。
 * 超期取消：deadline truth > late user intent——同一事务 materialize
 * EXPIRED（不记 CANCELLED resolution），仍返回 { isBuyer } 供 revalidate。
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
    SELECT id, type, status, "buyerId", "sellerId", "productId", "productReservationExpiresAt"
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

  // Phase 8B-01：锁内 fresh deadline 判定（超期取消不记 CANCELLED resolution）
  const now = new Date();
  if (
    order.productReservationExpiresAt != null &&
    isProductReservationExpired(order.productReservationExpiresAt, now)
  ) {
    const expired = await expireLockedProductReservation(tx, order, now);
    if (!expired) {
      return null;
    }
    return { isBuyer: order.buyerId === actorUserId };
  }

  // 条件更新保留为最终谓词安全带（行锁下恒真；双取消并发仅一路成功）
  const transitionResult = await tx.order.updateMany({
    where: { id: order.id, status: "PENDING" },
    data: {
      status: "CANCELLED",
      completedAt: null,
      cancelReason: "用户主动取消",
      productReservationResolvedAt: now,
      productReservationResolution: "CANCELLED",
    },
  });

  if (transitionResult.count === 0) {
    return null;
  }

  if (seams?.afterOrderCancelled) {
    await seams.afterOrderCancelled(tx);
  }

  if (order.productId) {
    await projectProductAfterReservationRelease(tx, order.id, {
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
 * PRODUCT 订单 accept 的唯一权威实现（Phase 8B-01；updateOrderStatusTx 对
 * PRODUCT + ACCEPTED 委派至此，general actor-only path 不再拥有该 transition）。
 *
 * 期限内：PENDING → ACCEPTED + resolution ACCEPTED（Product remains as-is，
 * 通常 RESERVED；seller 义务期内显式 OFFLINE 不被 accept 重开）。
 * 超期：同一事务内 materialize EXPIRED（Order → CANCELLED + Product release
 * + expiry 通知），返回非 null outcome——调用方必须 revalidate views，
 * 且绝不能发“已接单”通知。
 *
 * 返回 null = 无真实 transition（订单缺失 / 非 PRODUCT / 已非 PENDING /
 * actor 非 seller / candidate 失配 / 无 deadline 的异常行 / 条件更新失抢）。
 */
export async function acceptProductOrderTx(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  orderId: string,
  candidate: ProductOrderAcceptanceCandidate,
  seams?: ProductOrderAcceptanceSeams,
  options?: { now?: Date },
): Promise<ProductOrderAcceptanceOutcome | null> {
  if (seams?.beforeLock) {
    await seams.beforeLock(tx);
  }

  // 与 cancel/expire 同一 pair 锁域：一次性 sorted 完整取得
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: candidate.buyerId },
    { subjectType: "USER", subjectId: candidate.sellerId },
  ]);

  // 仅 actor（seller）需满足 ACTIVE account mutation contract
  await assertActiveAccountMutationAllowed(tx, actorUserId);

  if (seams?.afterCheck) {
    await seams.afterCheck(tx);
  }

  const orderRows = await tx.$queryRaw<LockedOrderRow[]>`
    SELECT id, type, status, "buyerId", "sellerId", "productId", "productReservationExpiresAt"
    FROM "Order"
    WHERE id = ${orderId}
    FOR UPDATE
  `;
  const order = orderRows[0];

  if (
    !order ||
    order.type !== "PRODUCT" ||
    order.status !== "PENDING" ||
    order.sellerId !== actorUserId ||
    order.buyerId !== candidate.buyerId ||
    order.sellerId !== candidate.sellerId ||
    order.productId !== candidate.productId
  ) {
    return null;
  }

  const now = options?.now ?? new Date();
  // 无 deadline 的 PENDING PRODUCT 行属约束下不可能的历史异常 → fail closed
  if (order.productReservationExpiresAt == null) {
    return null;
  }
  const overdue = isProductReservationExpired(order.productReservationExpiresAt, now);

  if (seams?.afterOrderRowLock) {
    await seams.afterOrderRowLock(tx);
  }

  if (overdue) {
    const expired = await expireLockedProductReservation(tx, order, now);
    if (!expired) {
      return null;
    }
    return { reservationResolution: "EXPIRED" };
  }

  // 条件更新保留为最终谓词安全带（行锁下恒真）；Product 保持原状
  const transitionResult = await tx.order.updateMany({
    where: { id: order.id, status: "PENDING" },
    data: {
      status: "ACCEPTED",
      completedAt: null,
      cancelReason: null,
      productReservationResolvedAt: now,
      productReservationResolution: "ACCEPTED",
    },
  });

  if (transitionResult.count === 0) {
    return null;
  }

  // 既有 accept 通知语义完全保留（文案与 general path 逐字一致）
  await createNotifications(tx, [
    {
      userId: order.buyerId,
      orderId: order.id,
      type: "ORDER",
      title: "订单状态更新：已接单",
      content: `卖家已将订单状态更新为“已接单”，请前往订单中心查看。`,
    },
    {
      userId: order.sellerId,
      orderId: order.id,
      type: "ORDER",
      title: "订单状态更新：已接单",
      content: `卖家已将订单状态更新为“已接单”，请前往订单中心查看。`,
    },
  ]);

  return { reservationResolution: "ACCEPTED" };
}

/**
 * PRODUCT 预留同步过期的唯一权威实现（Phase 8B-01 canonical domain
 * primitive；本阶段不绑定 scheduler，Phase 9 future reusable）。
 *
 * expiry 是 system lifecycle materialization：无 user actor——不要求任何
 * 参与方 ACTIVE / marketplace capability，任何账号生命周期状态都不得阻止
 * 关闭（capability 只影响 Product 重新曝光目标）。
 *
 * candidate pre-read 仅用于锁键发现（participants/type/productId），
 * status / deadline 权威全部来自 Order FOR UPDATE 后的 fresh row。
 *
 * 返回 null = 结构异常（订单缺失 / pre-read 行异常）；否则：
 *   NOT_PENDING = 已非 PENDING（idempotent replay / 输给并发 winner）
 *   NOT_DUE     = 仍处期限内（now < expiresAt），零写零通知
 *   EXPIRED     = 本事务完成 PENDING → CANCELLED/EXPIRED + Product release
 */
export async function expireProductReservationTx(
  tx: Prisma.TransactionClient,
  orderId: string,
  seams?: ProductReservationExpirySeams,
  options?: { now?: Date },
): Promise<ProductReservationExpiryOutcome | null> {
  // candidate pre-read：仅锁键发现，不信任 status / expiresAt
  const candidateRow = await tx.order.findUnique({
    where: { id: orderId },
    select: { type: true, buyerId: true, sellerId: true, productId: true },
  });

  if (!candidateRow || candidateRow.type !== "PRODUCT") {
    return null;
  }

  if (seams?.beforeLock) {
    await seams.beforeLock(tx);
  }

  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: candidateRow.buyerId },
    { subjectType: "USER", subjectId: candidateRow.sellerId },
  ]);

  // 刻意不做 assertActiveAccountMutationAllowed：expiry 无 user actor，
  // buyer/seller SUSPENDED / RISK_RESTRICTED 不得阻止系统 wind-down

  const orderRows = await tx.$queryRaw<LockedOrderRow[]>`
    SELECT id, type, status, "buyerId", "sellerId", "productId", "productReservationExpiresAt"
    FROM "Order"
    WHERE id = ${orderId}
    FOR UPDATE
  `;
  const order = orderRows[0];

  if (
    !order ||
    order.type !== "PRODUCT" ||
    order.buyerId !== candidateRow.buyerId ||
    order.sellerId !== candidateRow.sellerId ||
    order.productId !== candidateRow.productId ||
    order.productId === null
  ) {
    return null;
  }

  if (order.status !== "PENDING") {
    return { kind: "NOT_PENDING" };
  }

  // 约束下不可能的无 deadline 异常行 → fail closed
  if (order.productReservationExpiresAt == null) {
    return null;
  }

  const now = options?.now ?? new Date();
  if (!isProductReservationExpired(order.productReservationExpiresAt, now)) {
    return { kind: "NOT_DUE" };
  }

  if (seams?.afterOrderRowLock) {
    await seams.afterOrderRowLock(tx);
  }

  const expired = await expireLockedProductReservation(tx, order, now);
  if (!expired) {
    return { kind: "NOT_PENDING" };
  }
  return { kind: "EXPIRED" };
}

/**
 * 已持锁 EXPIRY materialization（Phase 8B-01 §37 共享 helper，禁止
 * accept-overdue / cancel-overdue / explicit-expire 三份实现漂移）。
 *
 * 前置条件（调用方必须已满足）：
 *   sorted {USER:buyer, USER:seller} advisory locks held
 *   → Order 行 FOR UPDATE held
 *   → fresh Order = PRODUCT / PENDING / now >= expiresAt
 *
 * 负责：条件 PENDING → CANCELLED（resolution EXPIRED）→ Product release
 * 投影 → expiry 通知（恰好一次；安全带失抢时零副作用返回 false）。
 */
async function expireLockedProductReservation(
  tx: Prisma.TransactionClient,
  lockedOrder: LockedOrderRow,
  now: Date,
): Promise<boolean> {
  // 条件更新保留为最终谓词安全带（行锁下恒真；并发 winner 仅一路成功）
  const transitionResult = await tx.order.updateMany({
    where: { id: lockedOrder.id, status: "PENDING" },
    data: {
      status: "CANCELLED",
      completedAt: null,
      cancelReason: PRODUCT_RESERVATION_EXPIRED_CANCEL_REASON,
      productReservationResolvedAt: now,
      productReservationResolution: "EXPIRED",
    },
  });

  if (transitionResult.count === 0) {
    return false;
  }

  if (lockedOrder.productId) {
    await projectProductAfterReservationRelease(tx, lockedOrder.id, {
      productId: lockedOrder.productId,
      sellerId: lockedOrder.sellerId,
    });
  }

  // 禁止 user-authored 内容（Product title / note / meetingLocation）
  await createNotifications(tx, [
    {
      userId: lockedOrder.buyerId,
      orderId: lockedOrder.id,
      type: "ORDER",
      title: "商品预留已过期",
      content: "卖家未在确认期限内接受订单，商品预留已自动释放。",
    },
    {
      userId: lockedOrder.sellerId,
      orderId: lockedOrder.id,
      type: "ORDER",
      title: "商品预留已过期",
      content: "该商品订单已超过确认期限，预留已自动释放。",
    },
  ]);

  return true;
}

/**
 * reservation 关闭（manual cancellation / deadline expiry 共享）后的 Product
 * 状态投影（CASE A–E，8A-02 已验证语义保持不变）：
 *   A. RESERVED + 未删除 + 无其它 active order + seller capability PASS → ACTIVE
 *   B. RESERVED + 未删除 + 无其它 active order + seller capability FAIL → OFFLINE
 *      （reservation without active obligation 的安全 wind-down 投影；
 *        订单取消/过期本身仍然 COMMIT——capability failure 绝不 rollback）
 *   C. 当前 OFFLINE / SOLD / ACTIVE → 不覆盖（卖家显式态不被 wind-down 穿越）
 *   D. deletedAt != null → 不写（禁止复活 contradictory lifecycle state）
 *   E. 存在其它 PENDING/ACCEPTED PRODUCT order → 保持 RESERVED
 */
export async function projectProductAfterReservationRelease(
  tx: Prisma.TransactionClient,
  releasedOrderId: string,
  input: { productId: string; sellerId: string },
  seams?: Pick<ProductOrderCancellationSeams, "afterProductRowLock">,
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
      id: { not: releasedOrderId },
      status: { in: [...ACTIVE_PRODUCT_ORDER_STATUSES] },
    },
    select: { id: true },
  });
  if (otherActiveOrder) {
    return;
  }

  // CASE A/B：seller USER 锁已持有 → checks-only 能力判定决定重新曝光资格。
  // 刻意不用 requireMarketplaceCapability：seller capability 失败不能
  // rollback 已合法的 reservation 关闭
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
