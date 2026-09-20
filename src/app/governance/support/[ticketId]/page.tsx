import Link from "next/link";
import { notFound } from "next/navigation";

import {
  claimSupportTicketAction,
  closeSupportTicketAction,
  releaseSupportTicketAction,
  resolveSupportTicketAction,
} from "@/actions/governance-support";
import {
  ClaimTicketForm,
  ReleaseTicketForm,
  TicketDecisionForms,
} from "@/components/governance/support-review-forms";
import {
  SUPPORT_RESOLUTION_CODE_LABELS,
  SUPPORT_TICKET_STATUS_LABELS,
} from "@/constants/support";
import { requireSupportAgent } from "@/lib/support/support-access";
import { loadAuthorizedSupportDetail } from "@/lib/support/support-query";

export const dynamic = "force-dynamic";

function formatDateTime(value: string | null) {
  if (!value) {
    return "暂无记录";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

/**
 * Phase 7G 支持工单详情（两阶段读；每请求独立重授权，绝不信任队列可见性）：
 * - Stage A 最小锚点 → 授权（missing / malformed scope / 越权 统一
 *   notFound，无存在性 oracle）；
 * - Stage B 敏感水合：description / internalNote / requester 安全身份仅在
 *   授权通过后进入；
 * - 字段分离冻结：internalNote = OPERATOR_ONLY（仅本治理面展示），
 *   resolutionMessage = USER_VISIBLE（requester 读面独立返回）；
 * - terminal 不可 reopen；dueAt 不因 claim/release 重置。
 */
export default async function GovernanceSupportTicketDetailPage({
  params,
}: {
  params: Promise<{ ticketId: string }>;
}) {
  const { user, context, access } = await requireSupportAgent();
  const { ticketId } = await params;

  const result = await loadAuthorizedSupportDetail({
    viewerId: user.id,
    context,
    access,
    ticketId,
  });

  if (!result.ok) {
    notFound();
  }

  const { detail } = result;
  const isActive = detail.status === "OPEN" || detail.status === "IN_PROGRESS";

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <Link href="/governance/support" className="text-sm text-slate-600 hover:text-slate-950">
        ← 返回支持工单
      </Link>

      <div className="mt-6 mb-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold text-slate-950">工单详情</h1>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
            {SUPPORT_TICKET_STATUS_LABELS[detail.status]}
          </span>
          {detail.campusName ? (
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
              校区：{detail.campusName}
            </span>
          ) : (
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
              无校区归属
            </span>
          )}
          {detail.overdue ? (
            <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700">
              已超时
            </span>
          ) : null}
        </div>
      </div>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-xl font-semibold text-slate-950">工单信息</h2>
        <dl className="grid gap-2 text-sm text-slate-600">
          <div>主题：{detail.subject}</div>
          <div>提交人：{detail.requesterName}</div>
          <div>创建时间：{formatDateTime(detail.createdAt)}</div>
          <div>办理时限：{formatDateTime(detail.dueAt)}</div>
        </dl>
        <div className="mt-4 text-sm text-slate-600">
          <p className="font-medium text-slate-900">问题描述</p>
          <p className="mt-2 whitespace-pre-wrap rounded-2xl bg-slate-50 p-4">{detail.description}</p>
        </div>
        {detail.internalNote ? (
          <div className="mt-4 text-sm text-slate-600">
            <p className="font-medium text-slate-900">内部备注（仅操作员）</p>
            <p className="mt-2 whitespace-pre-wrap rounded-2xl bg-slate-50 p-4">{detail.internalNote}</p>
          </div>
        ) : null}
      </section>

      {detail.resolution.resolvedAt ? (
        <section className="mt-6 rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-xl font-semibold text-slate-950">处理结果</h2>
          <dl className="grid gap-2 text-sm text-slate-600">
            <div>状态：{SUPPORT_TICKET_STATUS_LABELS[detail.status]}</div>
            {detail.resolution.code ? (
              <div>
                处理结果：
                {
                  SUPPORT_RESOLUTION_CODE_LABELS[
                    detail.resolution.code as keyof typeof SUPPORT_RESOLUTION_CODE_LABELS
                  ]
                }
              </div>
            ) : null}
            {detail.resolution.message ? (
              <div>结果说明（用户可见）：{detail.resolution.message}</div>
            ) : null}
            <div>处理时间：{formatDateTime(detail.resolution.resolvedAt)}</div>
            {detail.resolution.resolvedByName ? (
              <div>处理人：{detail.resolution.resolvedByName}</div>
            ) : null}
          </dl>
        </section>
      ) : null}

      {isActive && detail.scopeAuthorized ? (
        <section className="mt-6 rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-2 text-xl font-semibold text-slate-950">处理操作</h2>
          <p className="mb-4 text-sm text-slate-600">
            {detail.assignedAgent === null
              ? "当前工单未被领用：可领用后推进，或直接作出终局处理。"
              : detail.selfAssigned
                ? "你已领用该工单：可释放领用或作出终局处理。"
                : `该工单由 ${detail.assignedAgent.displayName} 领用；任一有权专员均可直接作出终局处理。`}
          </p>
          <div className="space-y-6">
            {detail.assignedAgent === null ? (
              <ClaimTicketForm action={claimSupportTicketAction} ticketId={detail.ticketId} />
            ) : null}
            {detail.selfAssigned ? (
              <ReleaseTicketForm action={releaseSupportTicketAction} ticketId={detail.ticketId} />
            ) : null}
            <TicketDecisionForms
              resolveAction={resolveSupportTicketAction}
              closeAction={closeSupportTicketAction}
              ticketId={detail.ticketId}
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}
