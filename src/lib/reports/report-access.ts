import { notFound } from "next/navigation";

import { requireUser } from "@/lib/server-auth";
import {
  loadAuthorizationContext,
  type AuthorizationContext,
} from "@/lib/rbac/service";
import type { ReportReviewScope } from "@/lib/reports/report-scope";

/**
 * Phase 7E：report reviewer 有效 access 派生（纯函数，DEFAULT_DENY）。
 *
 * 语义与中央 RBAC `hasPermission` / 7A `deriveAppealReviewAccess` 逐条同构：
 * - null / 非激活账号 → 空 access；
 * - GLOBAL grant 含 report.review → global=true（不要求任何 membership，
 *   与 hasPermission 的 GLOBAL-supersedes-campus 合同一致）；
 * - CAMPUS grant 含 report.review@A → 仅当 A ∈ activeCampusIds（grant ∧
 *   ACTIVE membership 同时成立）才纳入 campusIds；
 * - campusIds 去重；绝不读取 User.role 字段。
 *
 * 授权模型（规划冻结）：
 *   GLOBAL report.review → 全部 Report（含 UNSCOPED）；
 *   CAMPUS report.review@A → 仅 (campusId=A, scopeKey=CAMPUS:A) exact pair；
 *   UNSCOPED → 仅 GLOBAL 读者。
 * permission 复用既有 report.review（不新增 moderation.case.manage）；
 * 本派生仅供发现/呈现与查询分支构造，canonical mutation（claim/release/
 * review 锁后授权重读）始终是最终权威。
 */

export const REPORT_REVIEW_PERMISSION = "report.review" as const;

export type ReportReviewAccess = {
  /** GLOBAL report.review：可发现全部 Report（含 UNSCOPED） */
  global: boolean;
  /** 有效的 campus-scoped 审核 scope（grant ∧ ACTIVE membership 已求交） */
  campusIds: string[];
};

export function deriveReportReviewAccess(
  context: AuthorizationContext | null,
): ReportReviewAccess {
  const access: ReportReviewAccess = { global: false, campusIds: [] };
  if (!context || !context.accountActive) {
    return access;
  }

  for (const grant of context.grants) {
    if (!grant.permissionKeys.includes(REPORT_REVIEW_PERMISSION)) {
      continue;
    }
    if (grant.scope === "GLOBAL") {
      access.global = true;
    } else if (
      grant.campusId !== null &&
      context.activeCampusIds.includes(grant.campusId)
    ) {
      if (!access.campusIds.includes(grant.campusId)) {
        access.campusIds.push(grant.campusId);
      }
    }
  }

  return access;
}

/**
 * 单个 canonical scope 的授权判定（与 hasPermission 同语义）：
 * UNSCOPED 仅 GLOBAL 读者可见；CAMPUS 对 GLOBAL 读者或该校区有效 grant 放行。
 */
export function canReviewReportScope(
  access: ReportReviewAccess,
  scope: ReportReviewScope,
): boolean {
  if (scope.kind === "UNSCOPED") {
    return access.global;
  }
  return access.global || access.campusIds.includes(scope.campusId);
}

// ── Phase 7E 治理页入口 resolver（独立于 requireAdmin，零桥接）────────────────

export type ReportReviewerPageSession = {
  user: Awaited<ReturnType<typeof requireUser>>;
  context: AuthorizationContext;
  access: ReportReviewAccess;
};

/**
 * /governance/reports 页面统一入口（每次请求独立执行，绝不缓存）：
 *   requireUser()（session → DB ACTIVE 复查 → consent）
 *   → loadAuthorizationContext
 *   → deriveReportReviewAccess
 *   → 无任何有效 scope → notFound()（不泄露治理面存在性）。
 *
 * 与 legacy requireAdmin() 完全分离：CAMPUS_REPORT_REVIEWER 经本门进入，
 * 但 hasFullAdminSurfaceAccess 对其恒 false（7A 隔离不变）。
 */
export async function requireReportReviewer(): Promise<ReportReviewerPageSession> {
  const user = await requireUser();
  const context = await loadAuthorizationContext(user.id);
  const access = deriveReportReviewAccess(context);

  if (!context || (!access.global && access.campusIds.length === 0)) {
    notFound();
  }

  return { user, context, access };
}

/**
 * 服务端逐请求计算的 UI 便利提示（域服务恒为最终权威）：
 * - canClaim/canRelease：scope 对该 report 授权即可呈现控件（case 是否可
 *   claim 由域在锁内判定）；
 * - availableTransitions：仅按 Report.status 静态呈现（transition 合法性由
 *   applyReportReviewTx 锁内断言）。
 */
/** root gate / 导航可见性用：是否持有任何有效 report review scope。 */
export function hasAnyReportReviewAccess(access: ReportReviewAccess): boolean {
  return access.global || access.campusIds.length > 0;
}
