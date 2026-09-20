/**
 * Phase 7G：纠纷处理 SLA（frozen constant，指令冻结为 48 小时）。
 *
 * 合同：
 * - dueAt 的唯一运行时写路径是 dispute 创建（createdAt + 48h）；历史行由
 *   migration backfill 以行自身 createdAt 为 origin（绝不能用迁移执行时刻）；
 * - claim / release 不重置 dueAt（时钟从创建起算，不因领用流转重置）；
 * - OVERDUE 是只读计算：status ∈ {OPEN, IN_REVIEW} 且 dueAt < now；
 * - SLA 绝不驱动任何自动动作（auto RESOLVED / auto CLOSED / auto restriction /
 *   auto suspension 均为冻结禁区）——超时只影响队列排序与运营展示。
 */

export const DISPUTE_REVIEW_SLA_HOURS = 48;

const SLA_MS = DISPUTE_REVIEW_SLA_HOURS * 60 * 60 * 1000;

/** 创建时的到期时间：origin 必须是 dispute 创建时刻（不是 now() 之外的任何时钟）。 */
export function computeDisputeDueAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + SLA_MS);
}

const ACTIVE_DISPUTE_STATUSES = new Set(["OPEN", "IN_REVIEW"]);

/** 只读 overdue 判定（active 且已过 due；供队列/详情展示与过滤）。 */
export function isDisputeOverdue(
  dispute: { status: string; dueAt: Date },
  now: Date = new Date(),
): boolean {
  return ACTIVE_DISPUTE_STATUSES.has(dispute.status) && dispute.dueAt.getTime() < now.getTime();
}
