import { DISPUTE_ACTIVE_STATUSES } from "@/lib/disputes/dispute-scope";

/**
 * Phase 8E Review Integrity：评价窗口 + 双盲发布 canonical policy（SSOT）。
 *
 * 唯一常量定义（§4 冻结）：REVIEW_WINDOW_MS 只允许存在这一份。
 * 窗口起点 = authoritative Order/RentalOrder.completedAt；禁止以
 * Review.createdAt / Order.createdAt / browser clock / client 时间推导。
 *
 * 双盲合同（§5）：
 *   一方提交 → 对方不可见（评分/内容/tags 均不暴露，零通知零 aggregate）
 *   双方提交 → 两份评价立即公开（publishedAt = now）
 *   单方提交 → blindUntil（= reviewDeadline）到期后 query-time 自动可见，
 *   不依赖任何 scheduler / cron / worker（Phase 9 只做 reminder，不是
 *   8E correctness 前提）。
 *
 * visibility ≠ 存在性（§8）：评价一经提交是 immutable 历史事实，纠纷期间
 * 只是隐藏（canonical visible = FALSE），禁止删除/改写评价行。
 */

/** 评价窗口：7 天（全平台唯一定义，禁止第二份常量） */
export const REVIEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type ReviewPublicationStatus =
  | "BLIND_WAITING"
  | "DEADLINE_WAITING"
  | "DISPUTE_HIDDEN"
  | "PUBLISHED";

/** 用户可见状态文案（§49：禁止把 enum 原文当 UI 文案） */
export const REVIEW_PUBLICATION_STATUS_LABELS: Record<ReviewPublicationStatus, string> = {
  // blind 状态无法（也不允许）区分对方是否已提交——提交动作本身是反报复
  // 信号（§23），故 DEADLINE_WAITING 与 BLIND_WAITING 同态合并展示
  BLIND_WAITING: "等待双方完成评价后公开（评价期结束后自动公开）",
  DEADLINE_WAITING: "等待双方完成评价后公开（评价期结束后自动公开）",
  DISPUTE_HIDDEN: "订单纠纷处理中，评价暂不公开",
  PUBLISHED: "已公开",
};

/** reviewDeadline = completedAt + REVIEW_WINDOW（blindUntil 的唯一推导式） */
export function computeReviewDeadline(completedAt: Date): Date {
  return new Date(completedAt.getTime() + REVIEW_WINDOW_MS);
}

/**
 * 提交资格：now < reviewDeadline（§4：now == deadline 即 DENY；
 * completedAt 缺失 fail closed——WINDOW-04，绝不放行无权威完成时间订单）。
 */
export function isReviewWindowOpen(
  now: Date,
  completedAt: Date | null,
): boolean {
  if (!completedAt) {
    return false;
  }
  return now.getTime() < completedAt.getTime() + REVIEW_WINDOW_MS;
}

/** publication 条件：publishedAt != null OR blindUntil <= now（§6） */
export function isPublicationConditionMet(
  review: { publishedAt: Date | null; blindUntil: Date },
  now: Date,
): boolean {
  return review.publishedAt !== null || review.blindUntil.getTime() <= now.getTime();
}

/**
 * /my/reviews「我写出的评价」状态投影（§9/§27——纯 UI projection，
 * 不新增 DB enum）。作者永远可见自己写出的内容（AUTHOR_CAN_ALWAYS_VIEW_OWN_REVIEW
 * 冻结），本函数只决定展示哪个状态标签。
 */
export function deriveReviewPublicationStatus(
  review: { publishedAt: Date | null; blindUntil: Date },
  context: { now: Date; orderStatus: string; hasActiveDispute: boolean },
): ReviewPublicationStatus {
  if (context.hasActiveDispute) {
    return "DISPUTE_HIDDEN";
  }
  if (isPublicationConditionMet(review, context.now)) {
    // 无 active dispute 时，Order CLOSED（纠纷 CLOSE_ORDER 终局）不满足
    // canonical visible（§8），但仍按隐藏语义展示（历史事实保留）
    return context.orderStatus === "COMPLETED" ? "PUBLISHED" : "DISPUTE_HIDDEN";
  }
  return "BLIND_WAITING";
}

/**
 * canonical visible（§8 完整公开条件，纯函数判定）：
 *   Order COMPLETED AND no active dispute (OPEN/IN_REVIEW)
 *   AND (publishedAt != null OR blindUntil <= now)
 *
 * 调用方必须传入行锁内/查询层 fresh 的 order 状态与 dispute 存在性；
 * 本函数不读库。dispute active 状态集合与 dispute-scope SSOT 同源。
 */
export function isCanonicallyVisibleReview(
  review: { publishedAt: Date | null; blindUntil: Date },
  context: { now: Date; orderStatus: string; hasActiveDispute: boolean },
): boolean {
  if (context.orderStatus !== "COMPLETED") {
    return false;
  }
  if (context.hasActiveDispute) {
    return false;
  }
  return isPublicationConditionMet(review, context.now);
}

/** 查询层复用：active dispute 状态集合（与 dispute-scope SSOT 同源透出） */
export const REVIEW_BLOCKING_DISPUTE_STATUSES = DISPUTE_ACTIVE_STATUSES;
