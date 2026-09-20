/**
 * Phase 7G：申诉审核 SLA 收口（7G 唯一允许触碰的既有 7A domain；frozen
 * constant，指令冻结为 48 小时）。
 *
 * 合同：
 * - reviewDueAt 的唯一运行时写路径是申诉提交（提交时刻 + 48h）；历史行由
 *   migration backfill 以行自身 createdAt 为 origin（绝不能用迁移执行时刻）；
 * - OVERDUE 是只读计算：status ∈ {SUBMITTED, IN_REVIEW} 且 reviewDueAt < now；
 * - SLA 绝不改变 Appeal state machine / enforcement reversal 语义，也绝不
 *   驱动任何自动决定（auto GRANTED/UPHELD/DISMISSED 均为冻结禁区）——
 *   超时只影响队列排序与运营展示。
 */

export const APPEAL_REVIEW_SLA_HOURS = 48;

const SLA_MS = APPEAL_REVIEW_SLA_HOURS * 60 * 60 * 1000;

/** 提交时的到期时间：origin 必须是提交时刻（不是 now() 之外的任何时钟）。 */
export function computeAppealReviewDueAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + SLA_MS);
}

const ACTIVE_APPEAL_STATUSES = new Set(["SUBMITTED", "IN_REVIEW"]);

/** 只读 overdue 判定（active 且已过 due；供队列/详情展示与过滤）。 */
export function isAppealReviewOverdue(
  appeal: { status: string; reviewDueAt: Date },
  now: Date = new Date(),
): boolean {
  return ACTIVE_APPEAL_STATUSES.has(appeal.status) && appeal.reviewDueAt.getTime() < now.getTime();
}
