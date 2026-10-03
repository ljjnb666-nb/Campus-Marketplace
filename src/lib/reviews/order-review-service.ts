import type { Prisma } from "@prisma/client";

import { assertActiveAccountMutationAllowed } from "@/lib/governance/active-account-mutation";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { computeReviewDeadline, isReviewWindowOpen } from "@/lib/reviews/review-integrity";
import { visibleGeneralReviewCondition } from "@/lib/reviews/review-query";
import { emitNotificationsTx } from "@/lib/notifications/notification-service";
import { ORDER_REVIEW_PUBLISHED_KIND } from "@/lib/notifications/notification-registry";

/**
 * Phase 8E：General Review（PRODUCT / SERVICE / ERRAND）提交的唯一领域
 * authority——createReview 的 canonical Tx service（§10）。
 *
 * 权威锁序（与 initiateOrderDisputeTx / dispute resolution / erasure 同一
 * 全局全序，禁止反序；与 dispute 共享 serialization point）：
 *   PRODUCT / SERVICE：
 *     candidate discovery（仅锁键发现，非权威）
 *     → sorted {USER:buyer, USER:seller} advisory locks（一次性完整取得）
 *     → actor ACTIVE account mutation contract（checks-only）
 *     → Order FOR UPDATE（participants/type/type-FK/status/completedAt fresh 权威）
 *   ERRAND（服从既有 canonical ErrandTask → Order 方向，禁止 Order → ErrandTask）：
 *     candidate discovery → sorted USER pair → actor ACTIVE
 *     → ErrandTask FOR UPDATE → Order FOR UPDATE → canonical pair 校验
 *
 * 锁后 fresh 谓词（§12，任何失败 → 零 Review / 零通知 / 零 aggregate mutation）：
 *   Order exists；actor = buyer OR seller；Order.status == COMPLETED；
 *   completedAt != null（WINDOW-04 fail closed）；type-FK consistency；
 *   ERRAND 另需 ErrandTask COMPLETED + publisher/accepter pair 一致；
 *   no active OrderDispute（OPEN/IN_REVIEW，ordinary read——不取 dispute 行锁，
 *   避免与 dispute resolution 的 OrderDispute → Order 锁序成环）；
 *   now < completedAt + REVIEW_WINDOW（§4，now == deadline 即 DENY）；
 *   author 未评价过（duplicate，DB unique 兜底）。
 *
 * targetUserId 不属于客户端 authority（§13）：一律由锁内 Order 行推导
 * （actor == buyer → seller；actor == seller → buyer）。
 *
 * 双盲发布（§5/§14）：
 *   第一方提交 → Review(blindUntil = deadline, publishedAt = null)，
 *   counterparty 侧零通知（FIRST_BLIND_REVIEW → ZERO notification，§23）、
 *   stored 评分缓存零 mutation。
 *   第二方提交 → 同一事务内 update 双方 publishedAt = now（同一 publication
 *   episode；Order 行锁线性化 buyer||seller 并发），随后双方均 canonical
 *   visible，并各收一条 generic event 通知（不携带 rating/content/tags/author，
 *   §24）。
 *
 * Review ≠ Enforcement（§32）：任何评分/内容绝不触发 RiskFlag / RiskState /
 * EnforcementAction。Review submission immutable（§31）：本服务零 update/delete
 * 评价内容的路径（publishedAt 仅是 visibility metadata）。
 */

export type OrderReviewRacePoint = (tx: Prisma.TransactionClient) => Promise<void>;

export type OrderReviewTxError = { error: string };

type CandidateRow = {
  type: string;
  buyerId: string;
  sellerId: string;
  errandTaskId: string | null;
};

type LockedOrderRow = {
  id: string;
  type: string;
  status: string;
  buyerId: string;
  sellerId: string;
  completedAt: Date | null;
  productId: string | null;
  serviceListingId: string | null;
  errandTaskId: string | null;
};

type LockedErrandRow = {
  id: string;
  status: string;
  publisherId: string;
  accepterId: string | null;
};

/** 对目标用户的 stored 评分缓存做 visible-only 重算。
 * NON_AUTHORITATIVE_DERIVED_CACHE（§19/§20）：User.positiveReviewRate 不再被
 * 任何 PUBLIC/USER_VISIBLE 读面信任，canonical truth 是 visible 评价的
 * query-time 聚合；本缓存仅为兼容保留，绝不包含 blind/disputed/closed 评价。 */
export async function refreshUserReviewRateCache(
  tx: Prisma.TransactionClient,
  userId: string,
) {
  const aggregate = await tx.review.aggregate({
    where: visibleGeneralReviewCondition({ now: new Date(), targetUserId: userId }),
    _avg: { rating: true },
    _count: { rating: true },
  });

  const averageRating = aggregate._avg.rating ?? 0;
  const count = aggregate._count.rating ?? 0;

  await tx.user.update({
    where: { id: userId },
    data: {
      // 原口径冻结（§18/§48）：positiveReviewRate = avg(rating) / 5
      positiveReviewRate: count === 0 ? 0 : averageRating / 5,
    },
  });
}

// Phase 9B：双方评价公开时的 generic event 通知（§24：零评分/内容/tags/
// 作者名复制）；文案由 notification-registry 渲染器生成。

export async function submitOrderReviewTx(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string;
    userId: string;
    rating: number;
    content?: string;
    tags?: string[];
    /** 测试 seam：fresh 谓词通过后、首个写入之前（生产不传） */
    racePoint?: OrderReviewRacePoint;
    /** 测试 seam：sorted participant USER locks 取得之前（生产不传） */
    beforeSubjectLocks?: OrderReviewRacePoint;
  },
): Promise<OrderReviewTxError | { success: true; targetUserId: string; published: boolean }> {
  // ---- 步骤 1：candidate pre-read（无锁，仅锁键发现；不信任业务状态）----
  const candidateRow = await tx.order.findUnique({
    where: { id: input.orderId },
    select: {
      type: true,
      buyerId: true,
      sellerId: true,
      errandTaskId: true,
    },
  });
  const candidate: CandidateRow | null = candidateRow;
  if (!candidate) {
    return { error: "无效请求" };
  }

  if (input.beforeSubjectLocks) {
    await input.beforeSubjectLocks(tx);
  }

  // ---- 步骤 2：ONE sorted set：USER:buyer + USER:seller（与 dispute 同锁域）----
  await acquireGovernanceSubjectLocks(tx, [
    { subjectType: "USER", subjectId: candidate.buyerId },
    { subjectType: "USER", subjectId: candidate.sellerId },
  ]);

  // ---- 步骤 3：actor lifecycle 复核（checks-only——完整 pair 锁已持有）----
  await assertActiveAccountMutationAllowed(tx, input.userId);

  // ---- 步骤 4：行锁（type 决定 ErrandTask → Order 或 Order 权威）----
  let lockedErrand: LockedErrandRow | null = null;
  if (candidate.type === "ERRAND") {
    // 与 dispute initiation 同向：先 ErrandTask 后 Order，禁止反序成新 deadlock surface
    const errandRows = await tx.$queryRaw<LockedErrandRow[]>`
      SELECT "id", "status", "publisherId", "accepterId"
      FROM "ErrandTask"
      WHERE "id" = ${candidate.errandTaskId}
      FOR UPDATE
    `;
    lockedErrand = errandRows[0] ?? null;
  }

  const orderRows = await tx.$queryRaw<LockedOrderRow[]>`
    SELECT "id", "type", "status", "buyerId", "sellerId", "completedAt",
           "productId", "serviceListingId", "errandTaskId"
    FROM "Order"
    WHERE "id" = ${input.orderId}
    FOR UPDATE
  `;
  const order = orderRows[0];
  if (!order) {
    return { error: "无效请求" };
  }

  // ---- 步骤 5：locked fresh revalidate（fail closed，不信任 pre-read）----
  if (order.buyerId !== candidate.buyerId || order.sellerId !== candidate.sellerId) {
    return { error: "订单状态已变化，请重试" };
  }
  if (order.type !== candidate.type) {
    return { error: "订单状态已变化，请重试" };
  }
  if (order.buyerId !== input.userId && order.sellerId !== input.userId) {
    return { error: "无效请求" };
  }

  // type-FK consistency（与 dispute initiation 同款 fail closed 拒绝）
  if (
    (order.type === "PRODUCT" &&
      (order.productId === null || order.serviceListingId !== null || order.errandTaskId !== null)) ||
    (order.type === "SERVICE" &&
      (order.serviceListingId === null || order.productId !== null || order.errandTaskId !== null)) ||
    (order.type === "ERRAND" &&
      (order.errandTaskId === null || order.productId !== null || order.serviceListingId !== null))
  ) {
    return { error: "无效请求" };
  }

  if (order.type === "ERRAND") {
    if (
      !lockedErrand ||
      lockedErrand.id !== order.errandTaskId ||
      lockedErrand.publisherId !== order.buyerId ||
      lockedErrand.accepterId !== order.sellerId ||
      lockedErrand.status !== "COMPLETED"
    ) {
      return { error: "只有已完成订单可以评价" };
    }
  }

  // ---- 步骤 6：review 资格 fresh 谓词（全部通过才允许任何写入）----
  if (order.status !== "COMPLETED") {
    return { error: "只有已完成订单可以评价" };
  }
  // WINDOW-04：COMPLETED 但无权威完成时间 → fail closed
  if (!order.completedAt) {
    return { error: "只有已完成订单可以评价" };
  }

  // 评价窗口（§4）：now < completedAt + 7d；now == deadline 即 DENY
  if (!isReviewWindowOpen(new Date(), order.completedAt)) {
    return { error: "评价期已结束（订单完成后 7 天内可评价）" };
  }

  // active dispute defense（ordinary read，见函数头锁序说明）
  const activeDispute = await tx.orderDispute.findFirst({
    where: { orderId: order.id, status: { in: ["OPEN", "IN_REVIEW"] } },
    select: { id: true },
  });
  if (activeDispute) {
    return { error: "该订单存在进行中的纠纷，无法评价" };
  }

  // duplicate（提前给稳定产品结果，DB unique 兜底并发）
  const exist = await tx.review.findFirst({
    where: { orderId: order.id, authorId: input.userId },
    select: { id: true },
  });
  if (exist) {
    return { error: "你已经评价过该订单" };
  }

  if (input.racePoint) {
    await input.racePoint(tx);
  }

  // ---- 步骤 7：targetUserId 由锁内 Order 行推导（§13，客户端无 authority）----
  const targetUserId = order.buyerId === input.userId ? order.sellerId : order.buyerId;

  await tx.review.create({
    data: {
      orderId: order.id,
      authorId: input.userId,
      targetUserId,
      rating: input.rating,
      content: input.content || null,
      tags: input.tags ?? [],
      blindUntil: computeReviewDeadline(order.completedAt),
      publishedAt: null,
    },
  });

  // ---- 步骤 8：双方均提交 → 同一 publication episode 提前公开（§14）----
  const counterpartyReview = await tx.review.findFirst({
    where: { orderId: order.id, authorId: targetUserId },
    select: { id: true },
  });

  if (!counterpartyReview) {
    // FIRST_BLIND_REVIEW：对 counterparty 零通知（§23）、缓存零 mutation
    return { success: true, targetUserId, published: false };
  }

  const now = new Date();
  await tx.review.updateMany({
    where: { orderId: order.id, authorId: { in: [input.userId, targetUserId] } },
    data: { publishedAt: now },
  });

  // visible-only 缓存重算（双方都成为他人评价的 target）
  await refreshUserReviewRateCache(tx, targetUserId);
  await refreshUserReviewRateCache(tx, input.userId);

  await emitNotificationsTx(tx, [
    {
      kind: ORDER_REVIEW_PUBLISHED_KIND,
      recipientUserId: order.buyerId,
      orderId: order.id,
      dedupeKey: `${ORDER_REVIEW_PUBLISHED_KIND}:${order.id}:${order.buyerId}`,
      payload: { orderId: order.id },
    },
    {
      kind: ORDER_REVIEW_PUBLISHED_KIND,
      recipientUserId: order.sellerId,
      orderId: order.id,
      dedupeKey: `${ORDER_REVIEW_PUBLISHED_KIND}:${order.id}:${order.sellerId}`,
      payload: { orderId: order.id },
    },
  ]);

  return { success: true, targetUserId, published: true };
}
