import Link from "next/link";

import {
  deriveAppealReviewAccess,
} from "@/lib/appeals/reviewer-access";
import { deriveAuditAccess, hasAnyAuditAccess } from "@/lib/audit/audit-access";
import {
  deriveCampusManageAccess,
  hasAnyCampusManageAccess,
} from "@/lib/campus/campus-admin-access";
import {
  deriveVerificationReviewAccess,
  hasAnyVerificationReviewAccess,
} from "@/lib/campus/verification-review-access";
import {
  deriveOperationsOverviewAccess,
  hasAnyOperationsOverviewAccess,
} from "@/lib/governance/operations-overview-access";
import {
  loadOperationsOverview,
  type OperationsQueueSummary,
} from "@/lib/governance/operations-overview-query";
import {
  deriveDisputeReviewAccess,
  hasAnyDisputeReviewAccess,
} from "@/lib/disputes/dispute-access";
import {
  deriveEnforcementReadAccess,
  hasAnyEnforcementReadAccess,
} from "@/lib/enforcement/enforcement-read-access";
import {
  deriveListingModerationAccess,
  hasAnyListingModerationAccess,
} from "@/lib/moderation/listing-moderation-access";
import {
  deriveReportReviewAccess,
  hasAnyReportReviewAccess,
} from "@/lib/reports/report-access";
import {
  deriveRoleManageAccess,
  hasAnyRoleManageAccess,
} from "@/lib/rbac/role-manage-access";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { requireUser } from "@/lib/server-auth";
import {
  deriveSupportManageAccess,
  hasAnySupportManageAccess,
} from "@/lib/support/support-access";
import {
  deriveUserOperationsAccess,
  hasAnyUserOperationsAccess,
} from "@/lib/governance/user-operations-access";

export const dynamic = "force-dynamic";

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

/**
 * Phase 7H：/governance canonical 运营落地仪表盘（CAPABILITY-AWARE /
 * SCOPE-AWARE / PII-MINIMAL / READ-ONLY）。
 *
 * - 入口 = 任何 governance capability（layout root gate 承担 notFound）；
 *   本页对每个模块独立执行 capability visibility：未授权域以 null 传入
 *   loadOperationsOverview，其聚合查询结构性不执行（anti-oracle——
 *   root access ≠ all-card access，且绝不"查完再隐藏"）；
 * - summary 仅 counts/timestamps（§44 PII-MINIMAL），五队列授权谓词复用
 *   各域队列模块的同一分支构造器（§8 count 一致性）；
 * - 快捷入口只显示 actor 实际授权的 sibling（§10），绝不新增"万能 admin"
 *   权限；本页零 mutation、零 audit 写入（§9/§59）。
 */

export default async function GovernanceOverviewPage() {
  const user = await requireUser();
  const context = await loadAuthorizationContext(user.id);

  const appealAccess = deriveAppealReviewAccess(context);
  const roleManageAccess = deriveRoleManageAccess(context);
  const listingModerationAccess = deriveListingModerationAccess(context);
  const auditAccess = deriveAuditAccess(context);
  const enforcementAccess = deriveEnforcementReadAccess(context);
  const reportAccess = deriveReportReviewAccess(context);
  const verificationAccess = deriveVerificationReviewAccess(context);
  const userOperationsAccess = deriveUserOperationsAccess(context);
  const disputeAccess = deriveDisputeReviewAccess(context);
  const supportAccess = deriveSupportManageAccess(context);
  const operationsOverviewAccess = deriveOperationsOverviewAccess(context);
  const campusManageAccess = deriveCampusManageAccess(context);

  // anti-oracle：未授权域传 null → 该域聚合查询结构性不执行
  const summaries = await loadOperationsOverview({
    viewerId: user.id,
    reports: hasAnyReportReviewAccess(reportAccess) ? reportAccess : null,
    verifications: hasAnyVerificationReviewAccess(verificationAccess)
      ? verificationAccess
      : null,
    appeals:
      appealAccess.global || appealAccess.campusIds.length > 0
        ? appealAccess
        : null,
    disputes: hasAnyDisputeReviewAccess(disputeAccess) ? disputeAccess : null,
    support: hasAnySupportManageAccess(supportAccess) ? supportAccess : null,
  });

  const shortcuts = [
    { href: "/governance/listings", label: "列表治理", visible: hasAnyListingModerationAccess(listingModerationAccess) },
    { href: "/governance/users", label: "用户管理", visible: hasAnyUserOperationsAccess(userOperationsAccess) },
    { href: "/governance/enforcement", label: "执法记录", visible: hasAnyEnforcementReadAccess(enforcementAccess) },
    { href: "/governance/audit", label: "审计日志", visible: hasAnyAuditAccess(auditAccess) },
    { href: "/governance/roles", label: "角色管理", visible: hasAnyRoleManageAccess(roleManageAccess) },
    { href: "/governance/campuses", label: "校区管理", visible: hasAnyCampusManageAccess(campusManageAccess) },
    { href: "/governance/system", label: "系统状态", visible: hasAnyOperationsOverviewAccess(operationsOverviewAccess) },
  ].filter((item) => item.visible);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">治理总览</h1>
        <p className="mt-2 text-sm text-slate-600">
          按你的授权范围汇总各运营队列的待办概况。仅统计计数与时限，不含任何个人身份数据。
        </p>
      </div>

      {summaries.length === 0 ? (
        <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          你当前没有运营队列的授权范围。
        </div>
      ) : (
        <section aria-label="运营队列概况">
          <h2 className="mb-4 text-xl font-semibold text-slate-950">运营队列概况</h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {summaries.map((summary) => (
              <QueueSummaryCard key={summary.domain} summary={summary} />
            ))}
          </div>
        </section>
      )}

      {shortcuts.length > 0 ? (
        <section className="mt-10" aria-label="治理入口">
          <h2 className="mb-4 text-xl font-semibold text-slate-950">治理入口</h2>
          <div className="grid gap-3 md:grid-cols-3">
            {shortcuts.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-2xl border border-slate-200 bg-white px-5 py-4 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:text-slate-950"
              >
                {item.label}
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** 队列 summary 卡片（§6：仅 activeCount/overdueCount/assignedToMeCount/oldestDueAt/href）。 */
function QueueSummaryCard({ summary }: { summary: OperationsQueueSummary }) {
  return (
    <article className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-slate-500">{summary.title}</h3>
        {summary.overdueCount > 0 ? (
          <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700">
            超时 {summary.overdueCount}
          </span>
        ) : (
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
            无超时
          </span>
        )}
      </div>
      <p className="mt-3 text-4xl font-semibold text-slate-950">{summary.activeCount}</p>
      <p className="mt-1 text-xs text-slate-500">待办总数</p>
      <div className="mt-4 space-y-1 text-xs text-slate-500">
        {summary.assignedToMeCount !== undefined ? (
          <p>我领用的：{summary.assignedToMeCount}</p>
        ) : null}
        <p>
          最早时限：
          {summary.oldestDueAt ? formatDateTime(summary.oldestDueAt) : "—"}
        </p>
      </div>
      <Link
        href={summary.href}
        className="mt-4 block rounded-full border border-slate-200 px-4 py-2 text-center text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
      >
        查看队列
      </Link>
    </article>
  );
}
