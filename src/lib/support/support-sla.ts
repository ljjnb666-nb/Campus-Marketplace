/**
 * Phase 7G：支持工单 SLA（frozen constant，指令冻结为 72 小时）。
 *
 * 合同：
 * - dueAt 的唯一运行时写路径是工单创建（createdAt + 72h）；
 * - claim / release 不重置 dueAt（时钟从创建起算，不因领用流转重置）；
 * - OVERDUE 是只读计算：status ∈ {OPEN, IN_PROGRESS} 且 dueAt < now；
 * - SLA 绝不驱动任何自动动作（auto resolve / auto close / auto escalate /
 *   auto enforce 均为冻结禁区）——Phase 9 才有 scheduled reminders/escalation。
 */

export const SUPPORT_RESPONSE_SLA_HOURS = 72;

const SLA_MS = SUPPORT_RESPONSE_SLA_HOURS * 60 * 60 * 1000;

/** 创建时的到期时间：origin 必须是工单创建时刻（不是 now() 之外的任何时钟）。 */
export function computeSupportTicketDueAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + SLA_MS);
}

const ACTIVE_TICKET_STATUSES = new Set(["OPEN", "IN_PROGRESS"]);

/** 只读 overdue 判定（active 且已过 due；供队列/详情展示与过滤）。 */
export function isSupportTicketOverdue(
  ticket: { status: string; dueAt: Date },
  now: Date = new Date(),
): boolean {
  return ACTIVE_TICKET_STATUSES.has(ticket.status) && ticket.dueAt.getTime() < now.getTime();
}
