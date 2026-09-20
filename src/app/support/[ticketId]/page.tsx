import Link from "next/link";
import { notFound } from "next/navigation";

import {
  SUPPORT_RESOLUTION_CODE_LABELS,
  SUPPORT_TICKET_CATEGORY_LABELS,
  SUPPORT_TICKET_STATUS_LABELS,
} from "@/constants/support";
import { requireUser } from "@/lib/server-auth";
import { loadOwnSupportTicket } from "@/lib/support/support-service";

export const dynamic = "force-dynamic";

function formatDateTime(value: Date | null) {
  if (!value) {
    return "暂无记录";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

/**
 * Phase 7G：用户工单详情（own 读模型）。loadOwnSupportTicket 的 select
 * 结构性不含 internalNote（字段分离冻结：OPERATOR_ONLY 永不出现在
 * requester 读面）；非本人查询统一 notFound（无存在性 oracle）。
 */
export default async function SupportTicketDetailPage({
  params,
}: {
  params: Promise<{ ticketId: string }>;
}) {
  const user = await requireUser();
  const { ticketId } = await params;

  const ticket = await loadOwnSupportTicket(user.id, ticketId);
  if (!ticket) {
    notFound();
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <Link href="/support" className="text-sm text-slate-600 hover:text-slate-950">
        ← 返回支持与帮助
      </Link>

      <div className="mt-6 mb-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold text-slate-950">工单详情</h1>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
            {SUPPORT_TICKET_STATUS_LABELS[ticket.status]}
          </span>
          {ticket.overdue ? (
            <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700">
              处理已超时
            </span>
          ) : null}
        </div>
      </div>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <dl className="grid gap-2 text-sm text-slate-600">
          <div>主题：{ticket.subject}</div>
          <div>类型：{SUPPORT_TICKET_CATEGORY_LABELS[ticket.category]}</div>
          {ticket.campusName ? <div>校区：{ticket.campusName}</div> : null}
          <div>提交时间：{formatDateTime(ticket.createdAt)}</div>
        </dl>
        <div className="mt-4 text-sm text-slate-600">
          <p className="font-medium text-slate-900">问题描述</p>
          <p className="mt-2 whitespace-pre-wrap rounded-2xl bg-slate-50 p-4">{ticket.description}</p>
        </div>
      </section>

      {ticket.resolution ? (
        <section className="mt-6 rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-xl font-semibold text-slate-950">处理结果</h2>
          <dl className="grid gap-2 text-sm text-slate-600">
            <div>状态：{SUPPORT_TICKET_STATUS_LABELS[ticket.status]}</div>
            {ticket.resolution.code ? (
              <div>
                处理结果：
                {
                  SUPPORT_RESOLUTION_CODE_LABELS[
                    ticket.resolution.code as keyof typeof SUPPORT_RESOLUTION_CODE_LABELS
                  ]
                }
              </div>
            ) : null}
            {ticket.resolution.message ? (
              <div className="whitespace-pre-wrap">结果说明：{ticket.resolution.message}</div>
            ) : null}
            <div>处理时间：{formatDateTime(ticket.resolution.resolvedAt)}</div>
          </dl>
        </section>
      ) : null}
    </div>
  );
}
