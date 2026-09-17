import type { Prisma, ReportStatus } from "@prisma/client";

/**
 * Phase 7E：ModerationCase 运营元数据同步（唯一实现）。
 *
 * Report 是 canonical decision truth；本模块只搬运算运时钟：
 * - SLA：MODERATION_CASE_SLA_HOURS = 48（v1 冻结代码常量，不可配置）。
 *   dueAt = openedAt + 48h；reopen 时 openedAt/dueAt 以 reopen 时刻重置。
 * - case operational state 由 closedAt 派生（null = ACTIVE，非 null = CLOSED），
 *   禁止 case status enum；终局结果唯一权威是 Report.status。
 * - 不可变合同：review 提交与 case 同步发生在同一 locked transaction
 *   （applyReportReviewTx：REPORT 行锁 → CASE 行锁 → transition 断言 →
 *   写入），commit 后不得出现 report terminal ∧ case active 或反之。
 * - OVERDUE 为只读计算（closedAt == null ∧ dueAt < now）。绝对禁止任何
 *   SLA expiry → 自动 report decision / listing moderation / RiskState /
 *   EnforcementAction 的自动执法路径（frozen）。
 */

/** v1 冻结：SLA 48 小时，不可配置（规划冻结，扩列须显式重新 review）。 */
export const MODERATION_CASE_SLA_HOURS = 48;

/** openedAt + SLA 的唯一计算点（创建与 reopen 共用，防实现漂移）。 */
export function caseSlaDeadline(openedAt: Date): Date {
  return new Date(openedAt.getTime() + MODERATION_CASE_SLA_HOURS * 60 * 60 * 1000);
}

/** OVERDUE 只读判定（绝对不驱动任何自动执法）。 */
export function isModerationCaseOverdue(
  row: { closedAt: Date | null; dueAt: Date },
  now: Date = new Date(),
): boolean {
  return row.closedAt === null && row.dueAt.getTime() < now.getTime();
}

const TERMINAL_REPORT_STATUSES: ReadonlySet<ReportStatus> = new Set(["RESOLVED", "REJECTED"]);

// ── 创建路径：新 Report 的 1:1 case（UNIQUE(reportId) 为 DB 兜底）─────────────

export type ModerationCaseCreateInput = {
  reportId: string;
  campusId: string | null;
  scopeKey: string;
  /** 历史/新建 SLA 起点：新建 = now，回填路径不得使用执行时刻 */
  openedAt: Date;
};

/** 新 Report 创建事务内调用：openedAt = report 创建时刻，dueAt = +48h。 */
export async function createModerationCaseForReportTx(
  tx: Prisma.TransactionClient,
  input: ModerationCaseCreateInput,
): Promise<{ id: string }> {
  return tx.moderationCase.create({
    data: {
      reportId: input.reportId,
      campusId: input.campusId,
      scopeKey: input.scopeKey,
      openedAt: input.openedAt,
      dueAt: caseSlaDeadline(input.openedAt),
      lastActivityAt: input.openedAt,
    },
    select: { id: true },
  });
}

// ── 审核路径：transition ↔ case 时钟同步（applyReportReviewTx 专用）──────────

export type ModerationCaseReviewSyncInput = {
  reportId: string;
  /** applyReportReviewTx 已 FOR UPDATE 取得的 case 行 id（可能缺行=防御重建） */
  existingCaseId: string | null;
  campusId: string | null;
  scopeKey: string;
  /** 防御重建时 openedAt 回落到 report.createdAt（绝不用执行时刻） */
  reportCreatedAt: Date;
  previousStatus: ReportStatus;
  nextStatus: ReportStatus;
};

export type ModerationCaseReviewSyncResult = {
  caseId: string;
  /** terminal → IN_REVIEW 的 reopen（openedAt/dueAt 已重置） */
  reopened: boolean;
  dueAt: Date;
  closedAt: Date | null;
};

/**
 * review transition 的 case 时钟同步（同一 locked transaction 内调用）。
 *
 * 同步矩阵（与 Report.status 一一对应，无第二套 decision state）：
 * - nextStatus IN_REVIEW：
 *   - previousStatus ∈ {RESOLVED, REJECTED}（reopen）→ closedAt=null、
 *     openedAt=now、dueAt=now+48h（reopen clock 重置）；
 *   - 其余（OPEN→IN_REVIEW / 幂等 IN_REVIEW）→ closedAt=null，openedAt/dueAt
 *     保持（首开时钟不重置）；
 * - nextStatus RESOLVED / REJECTED → closedAt=now（ACTIVE → CLOSED）；
 * - lastActivityAt 恒 = now。
 */
export async function syncModerationCaseOnReviewTx(
  tx: Prisma.TransactionClient,
  input: ModerationCaseReviewSyncInput,
): Promise<ModerationCaseReviewSyncResult> {
  const now = new Date();
  const reopened =
    input.nextStatus === "IN_REVIEW" && TERMINAL_REPORT_STATUSES.has(input.previousStatus);

  if (!input.existingCaseId) {
    // 防御重建：post-migration 每行 Report 都有 case；缺行只可能来自
    // 极端历史残缺——按 report.createdAt 重建（fail-safe，不猜测新时钟）。
    const created = await tx.moderationCase.create({
      data: {
        reportId: input.reportId,
        campusId: input.campusId,
        scopeKey: input.scopeKey,
        openedAt: input.reportCreatedAt,
        dueAt: caseSlaDeadline(input.reportCreatedAt),
        lastActivityAt: now,
        closedAt: TERMINAL_REPORT_STATUSES.has(input.nextStatus) ? now : null,
      },
      select: { id: true, dueAt: true, closedAt: true },
    });
    return {
      caseId: created.id,
      reopened: false,
      dueAt: created.dueAt,
      closedAt: created.closedAt,
    };
  }

  const updated = await tx.moderationCase.update({
    where: { id: input.existingCaseId },
    data: {
      lastActivityAt: now,
      ...(input.nextStatus === "IN_REVIEW"
        ? reopened
          ? { closedAt: null, openedAt: now, dueAt: caseSlaDeadline(now) }
          : { closedAt: null }
        : { closedAt: now }),
    },
    select: { id: true, dueAt: true, closedAt: true },
  });

  return {
    caseId: updated.id,
    reopened,
    dueAt: updated.dueAt,
    closedAt: updated.closedAt,
  };
}
