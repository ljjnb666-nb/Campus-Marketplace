/**
 * Phase 7F：认证审核 SLA（frozen constant，指令冻结为 48 小时）。
 *
 * 合同：
 * - reviewDueAt 的唯一写路径是提交/重新提交（submittedAt + 48h）与
 *   migration backfill（历史 submittedAt + 48h，绝不能用迁移执行时刻）；
 * - OVERDUE 是只读计算：status == PENDING 且 reviewDueAt < now；
 * - SLA 绝不驱动任何自动决定（auto VERIFIED / REJECTED / REVOKED），
 *   也绝不触发任何 enforcement——超时只影响队列排序与运营展示。
 */

export const VERIFICATION_REVIEW_SLA_HOURS = 48;

const SLA_MS = VERIFICATION_REVIEW_SLA_HOURS * 60 * 60 * 1000;

/** 提交/重新提交时的到期时间：origin 必须是 submittedAt（不是 now() 之外的任何时钟）。 */
export function computeVerificationReviewDueAt(submittedAt: Date): Date {
  return new Date(submittedAt.getTime() + SLA_MS);
}

/** 只读 overdue 判定（PENDING 且已过 due；供队列/详情展示与过滤）。 */
export function isVerificationReviewOverdue(
  verification: { status: string; reviewDueAt: Date },
  now = new Date(),
): boolean {
  return verification.status === "PENDING" && verification.reviewDueAt < now;
}
