import Link from "next/link";
import { notFound } from "next/navigation";

import {
  beginGovernanceAppealReview,
  decideGovernanceAppeal,
} from "@/actions/governance-appeals";
import { BeginReviewForm, DecideReviewForm } from "@/components/governance/appeal-review-forms";
import {
  APPEAL_STATUS_LABELS,
  DECISION_REASON_LABELS,
  ENFORCEMENT_REASON_LABELS,
  ENFORCEMENT_TYPE_LABELS,
} from "@/constants/governance";
import { loadAuthorizedAppealDetail } from "@/lib/appeals/review-queue";
import { requireAppealReviewer } from "@/lib/appeals/reviewer-access";

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

function formatPreviousState(value: string | null) {
  if (!value) return "历史记录溯源不足（不可自动恢复）";
  const labels: Record<string, string> = {
    "USER:ACTIVE": "账号正常（ACTIVE）",
    "CAMPUS_MEMBERSHIP:ACTIVE": "成员身份正常（ACTIVE）",
  };
  const riskMatch = /^RISK_STATE:(NORMAL|WATCH)@(.+)$/.exec(value);
  if (riskMatch) {
    return `集市风险状态恢复至 ${riskMatch[1] === "NORMAL" ? "正常" : "观察"}（${riskMatch[2] === "GLOBAL" ? "全平台" : riskMatch[2]}）`;
  }
  return labels[value] ?? value;
}

/**
 * Phase 7A 申诉详情（Planning §21/§22/§23/§25 冻结）：
 * - 每请求独立重授权（missing/malformed/越权/appellant-self 统一 notFound，
 *   无存在性 oracle）；绝不信任队列可见性；
 * - statement 为机密审核材料，仅详情呈现；decisionNote/EA.note/sourceId/
 *   email/phone/审计结构性不在 DTO；
 * - W1：SUBMITTED 仅「开始审核」；IN_REVIEW 终局控件（维持处罚恒可用，
 *   通过申诉仅在有 canonical 恢复权时可用——纯 UI 便利，域服务恒为权威）；
 * - self-review 非阻断警示（域策略 ALLOWED_WITH_AUDIT）；无 ownership 文案。
 */
export default async function GovernanceAppealDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, context, access } = await requireAppealReviewer();
  const { id } = await params;

  const result = await loadAuthorizedAppealDetail({
    viewerId: user.id,
    context,
    access,
    appealId: id,
  });

  if (!result.ok) {
    notFound();
  }

  const { detail, capabilities } = result;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <Link
        href="/governance/appeals"
        className="text-sm text-slate-600 hover:text-slate-950"
      >
        ← 返回申诉审核
      </Link>

      <div className="mt-6 mb-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold text-slate-950">申诉详情</h1>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
            {APPEAL_STATUS_LABELS[detail.status]}
          </span>
        </div>
        {detail.selfReview ? (
          <p
            role="note"
            className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800"
          >
            你是该处罚的原执行者，本次决定将记录为 self-review
          </p>
        ) : null}
      </div>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-xl font-semibold text-slate-950">申诉内容</h2>
        <p className="whitespace-pre-wrap rounded-2xl bg-slate-50 p-5 text-sm leading-6 text-slate-700">
          {detail.statement}
        </p>
        <dl className="mt-4 grid gap-2 text-sm text-slate-600">
          <div>申诉人：{detail.appellantName}</div>
          <div>提交时间：{formatDateTime(detail.createdAt)}</div>
        </dl>
      </section>

      <section className="mt-6 rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-xl font-semibold text-slate-950">被申诉的处罚</h2>
        <dl className="grid gap-2 text-sm text-slate-600">
          <div>处罚类型：{ENFORCEMENT_TYPE_LABELS[detail.enforcement.type]}</div>
          <div>
            作用范围：
            {detail.enforcement.scopeKind === "GLOBAL"
              ? "全平台"
              : `校区：${detail.enforcement.campusName ?? "未知校区"}`}
          </div>
          <div>
            处罚原因：
            {detail.enforcement.reasonCode
              ? (ENFORCEMENT_REASON_LABELS[detail.enforcement.reasonCode] ??
                detail.enforcement.reasonCode)
              : "未记录"}
          </div>
          <div>处罚时间：{formatDateTime(detail.enforcement.createdAt)}</div>
          <div>
            申诉通过后将恢复至：{formatPreviousState(detail.enforcement.previousState)}
          </div>
        </dl>
      </section>

      <section className="mt-6 rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-xl font-semibold text-slate-950">审核操作</h2>
        {detail.status === "SUBMITTED" ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              开始审核后申诉进入「审核中」，此操作不指定处理人；任一有权审核员均可作出最终决定。
            </p>
            <BeginReviewForm
              action={beginGovernanceAppealReview}
              appealId={detail.id}
            />
          </div>
        ) : detail.status === "IN_REVIEW" ? (
          <div className="space-y-4">
            {!capabilities.canGrant ? (
              <p className="text-sm text-slate-600">
                你可以维持或驳回该申诉；「通过申诉」需要对应的处罚恢复权限，如需通过申诉请联系有权限的管理员处理。
              </p>
            ) : null}
            <DecideReviewForm
              action={decideGovernanceAppeal}
              appealId={detail.id}
              canGrant={capabilities.canGrant}
            />
          </div>
        ) : (
          <dl className="grid gap-2 text-sm text-slate-600">
            <div>
              处理结果：
              {detail.status === "GRANTED"
                ? "申诉通过，相关处罚已解除"
                : detail.status === "UPHELD"
                  ? "原处罚维持不变"
                  : detail.status === "DISMISSED"
                    ? `已按平台流程处理完毕${
                        detail.decisionReasonCode &&
                        detail.decisionReasonCode in DECISION_REASON_LABELS
                          ? `（${
                              DECISION_REASON_LABELS[
                                detail.decisionReasonCode as keyof typeof DECISION_REASON_LABELS
                              ]
                            }）`
                          : ""
                      }`
                    : "申诉已撤回"}
            </div>
          </dl>
        )}
      </section>
    </div>
  );
}
