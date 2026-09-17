import Link from "next/link";
import { notFound } from "next/navigation";

import {
  claimGovernanceReportCase,
  releaseGovernanceReportCase,
  reviewGovernanceReport,
} from "@/actions/governance-reports";
import { ClaimCaseForm, ReleaseCaseForm, ReportReviewForm } from "@/components/governance/report-review-forms";
import {
  REPORT_REASON_LABELS,
  REPORT_STATUS_LABELS,
  REPORT_TARGET_TYPE_LABELS,
} from "@/constants/report";
import { requireReportReviewer } from "@/lib/reports/report-access";
import { loadAuthorizedReportDetail } from "@/lib/reports/report-query";

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
 * Phase 7E 举报详情（每请求独立重授权，绝不信任队列可见性）：
 * - missing / malformed scope / 越权 统一 notFound（无存在性 oracle——P05/P06）；
 * - 详情为机密审核材料面：report detail / handledNote 仅在此呈现，队列
 *   结构性不含；身份走安全水合，零 email/phone/studentId（P04）；
 * - case 时钟只读呈现（openedAt/dueAt/overdue）；SLA 超时零自动执法；
 * - 领用人 ≠ 审核权：任何授权审核员均可推进，claim 仅为运营协调。
 */
export default async function GovernanceReportDetailPage({
  params,
}: {
  params: Promise<{ reportId: string }>;
}) {
  const { user, context, access } = await requireReportReviewer();
  const { reportId } = await params;

  const result = await loadAuthorizedReportDetail({
    viewerId: user.id,
    context,
    access,
    reportId,
  });

  if (!result.ok) {
    notFound();
  }

  const { detail } = result;
  const caseOpen = detail.caseTiming.closedAt === null;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <Link href="/governance/reports" className="text-sm text-slate-600 hover:text-slate-950">
        ← 返回举报处理
      </Link>

      <div className="mt-6 mb-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold text-slate-950">举报详情</h1>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
            {REPORT_STATUS_LABELS[detail.status]}
          </span>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
            {detail.scopeLabel}
          </span>
          {detail.caseTiming.overdue ? (
            <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700">
              办理已超时
            </span>
          ) : null}
        </div>
      </div>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-xl font-semibold text-slate-950">举报内容</h2>
        <p className="whitespace-pre-wrap rounded-2xl bg-slate-50 p-5 text-sm leading-6 text-slate-700">
          {detail.detail ?? "（举报人未填写说明）"}
        </p>
        <dl className="mt-4 grid gap-2 text-sm text-slate-600">
          <div>举报原因：{REPORT_REASON_LABELS[detail.reason]}</div>
          <div>目标类型：{REPORT_TARGET_TYPE_LABELS[detail.targetType]}</div>
          <div>目标：{detail.safeTargetLabel}</div>
          <div>举报人：{detail.reporterName}</div>
          <div>提交时间：{formatDateTime(detail.createdAt)}</div>
        </dl>
      </section>

      <section className="mt-6 rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-xl font-semibold text-slate-950">运营 case</h2>
        <dl className="grid gap-2 text-sm text-slate-600">
          <div>开案时间：{formatDateTime(detail.caseTiming.openedAt)}</div>
          <div>办理时限：{formatDateTime(detail.caseTiming.dueAt)}</div>
          <div>最近活动：{formatDateTime(detail.caseTiming.lastActivityAt)}</div>
          <div>
            case 状态：
            {caseOpen ? (
              <span className="font-medium text-emerald-700">ACTIVE</span>
            ) : (
              <span className="font-medium text-slate-500">CLOSED</span>
            )}
          </div>
          {detail.caseTiming.closedAt ? (
            <div>关闭时间：{formatDateTime(detail.caseTiming.closedAt)}</div>
          ) : null}
          <div>
            领用人：
            {detail.assignedReviewer ? detail.assignedReviewer.displayName : "未领用"}
          </div>
        </dl>

        {caseOpen && !detail.assignedReviewer ? (
          <div className="mt-4">
            <ClaimCaseForm action={claimGovernanceReportCase} reportId={detail.reportId} />
          </div>
        ) : null}
        {caseOpen && detail.selfAssigned ? (
          <div className="mt-4">
            <ReleaseCaseForm action={releaseGovernanceReportCase} reportId={detail.reportId} />
          </div>
        ) : null}
      </section>

      {detail.handledNote || detail.handledAt ? (
        <section className="mt-6 rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-xl font-semibold text-slate-950">上次处理记录</h2>
          <dl className="grid gap-2 text-sm text-slate-600">
            {detail.handledAt ? <div>处理时间：{formatDateTime(detail.handledAt)}</div> : null}
            <div>处理备注：{detail.handledNote ?? "无"}</div>
          </dl>
        </section>
      ) : null}

      <section className="mt-6 rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-xl font-semibold text-slate-950">审核操作</h2>
        <p className="text-sm text-slate-600">
          {detail.status === "RESOLVED" || detail.status === "REJECTED"
            ? "该举报已终局。重新标记为「处理中」将重新开案并重置办理时限（reopen clock）。"
            : "标记「处理中」后可继续推进至「处理完成」或「驳回」。"}
        </p>
        <div className="mt-4">
          <ReportReviewForm
            action={reviewGovernanceReport}
            reportId={detail.reportId}
            showReviewAction={detail.scopeAuthorized}
          />
        </div>
      </section>
    </div>
  );
}
