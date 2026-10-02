import type { Prisma, ReportStatus } from "@prisma/client";

import { applyReportReviewTx } from "@/lib/enforcement/report-projection";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { withTransaction } from "@/lib/prisma";
import { REPORT_REVIEW_PERMISSION } from "@/lib/reports/report-access";
import { resolveReportReviewScope } from "@/lib/reports/report-scope";
import { emitNotificationTx } from "@/lib/notifications/notification-service";
import { REPORT_REVIEW_STATUS_CHANGED_KIND } from "@/lib/notifications/notification-registry";
import { rbacError } from "@/lib/rbac/errors";
import { loadAuthorizationContext, requirePermissionInContext } from "@/lib/rbac/service";

/**
 * Phase 7E：举报审核 canonical 治理服务（唯一 mutation authority）。
 *
 * legacy `reviewReport`（admin action）退化为本服务的薄 adapter；
 * /admin/reports 页面退役为 canonical redirect——全仓不存在第二份
 * report mutation 写路径（6B applyReportReviewTx 的锁内核被复用，核心
 * 语义保持：locked status → transition 断言 → canonical update →
 * projection → 审计）。
 *
 * 冻结链（单个 locked transaction）：
 *   USER:actor subject lock（sorted subject-lock contract；FR01：真正获取，
 *   与 claim/release 同源序列化 role revoke / 账号停用 / membership 停用）
 *   → REPORT 行 FOR UPDATE
 *   → MODERATION_CASE 行 FOR UPDATE
 *   → 锁后授权复核（report.review；UNSCOPED 仅 GLOBAL，campus exact-pair）
 *   → transition 断言（REPORT_STATUS_TRANSITIONS）
 *   → Report update + case 时钟同步 + RiskFlag 投影 + AdminLog
 *   → reporter notification（既有事务性合同 §35/§36 原样保留——同事务、
 *     同文案、失败随事务回滚，语义零改动）
 *   → commit。
 */

export type ReviewReportInput = {
  actorId: string;
  reportId: string;
  status: Extract<ReportStatus, "IN_REVIEW" | "RESOLVED" | "REJECTED">;
  handledNote?: string | null;
  racePoint?: (tx: Prisma.TransactionClient) => Promise<void>;
};

export type ReviewReportResult = {
  reportId: string;
  status: ReportStatus;
  reporterId: string;
  caseId: string;
  reopened: boolean;
  dueAt: Date;
};

/** Phase 9B：reporter 通知文案由 notification-registry 按 status 渲染
 * （§6/§17：handledNote 属 operator 自由文本，不再复制进通知 content——
 * 处理说明的唯一权威在 Report.handledNote 本体）。 */

export async function reviewReportInGovernance(
  input: ReviewReportInput,
): Promise<ReviewReportResult> {
  return withTransaction(async (tx) => {
    // FR01（Final Review Repair 1）：USER:actor advisory lock 与 claim/release
    // 同源——在同一事务内、REPORT 行锁之前取得，序列化 role revoke / 账号停用
    // / membership 停用 vs 治理写（7C R2-01 同源合同），关闭"锁后授权重读"
    // 之前的角色/状态变更窗口（TOCTOU）。失败随事务回滚，零吞错。
    await acquireGovernanceSubjectLocks(tx, [
      { subjectType: "USER", subjectId: input.actorId },
    ]);

    const review = await applyReportReviewTx(tx, {
      reportId: input.reportId,
      actorId: input.actorId,
      status: input.status,
      handledNote: input.handledNote || null,
      racePoint: input.racePoint,
      authorizeAfterLock: async (authTx, locked) => {
        const scope = resolveReportReviewScope({
          campusId: locked.campusId,
          scopeKey: locked.scopeKey,
        });
        if (scope === null) {
          // malformed scope pair：fail closed（DB CHECK 下结构不可达）
          throw rbacError("AUTH_PERMISSION_DENIED");
        }
        const context = await loadAuthorizationContext(input.actorId, authTx);
        if (!context || !context.accountActive) {
          throw rbacError("AUTH_ACCOUNT_INACTIVE");
        }
        // UNSCOPED → campusId=null → 仅 GLOBAL grant 放行（UNSCOPED 授权模型）
        await requirePermissionInContext(
          context,
          REPORT_REVIEW_PERMISSION,
          scope.kind === "CAMPUS" ? scope.campusId : null,
        );
      },
    });

    // dedupe 携带 per-invocation epoch：报告 reopen 后可再次进入同一 status，
    // 每次治理动作都是独立真实事件（事务回滚则本行一并消失）。
    await emitNotificationTx(tx, {
      kind: REPORT_REVIEW_STATUS_CHANGED_KIND,
      recipientUserId: review.reporterId,
      dedupeKey: `${REPORT_REVIEW_STATUS_CHANGED_KIND}:${input.reportId}:${input.status}:${new Date().toISOString()}`,
      payload: { reportId: input.reportId, status: input.status },
    });

    return review;
  });
}
