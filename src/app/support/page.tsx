import Link from "next/link";

import { createSupportTicketAction } from "@/actions/support";
import { SupportTicketCreateForm } from "@/components/support/support-create-form";
import { SUPPORT_TICKET_CATEGORY_LABELS, SUPPORT_TICKET_STATUS_LABELS } from "@/constants/support";
import { listActiveMembershipCampuses } from "@/repositories/user-repository";
import { requireUser } from "@/lib/server-auth";
import { listOwnSupportTickets } from "@/lib/support/support-service";

export const dynamic = "force-dynamic";

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

/**
 * Phase 7G：用户支持面（authenticated minimal surface；不做 Phase 11 UX
 * polish）。允许 create + own list；campus 下拉仅列本人 ACTIVE membership
 * 校区（scope 真相由 canonical 服务锁内复核）。
 */
export default async function SupportPage() {
  const user = await requireUser();

  const [tickets, memberships] = await Promise.all([
    listOwnSupportTickets(user.id),
    listActiveMembershipCampuses(user.id),
  ]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">支持与帮助</h1>
        <p className="mt-2 text-sm text-slate-600">
          提交问题工单后，平台或校区支持人员会尽快处理（响应时限 72 小时）。
        </p>
      </div>

      <section className="mb-10 rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold text-slate-900">提交新工单</h2>
        <SupportTicketCreateForm
          action={createSupportTicketAction}
          campuses={memberships.map((m) => m.campus)}
        />
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold text-slate-900">我的工单</h2>
        {tickets.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            你还没有提交过工单。
          </div>
        ) : (
          <div className="grid gap-4">
            {tickets.map((ticket) => (
              <article
                key={ticket.id}
                className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                    {SUPPORT_TICKET_STATUS_LABELS[ticket.status]}
                  </span>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                    {SUPPORT_TICKET_CATEGORY_LABELS[ticket.category]}
                  </span>
                  {ticket.campusName ? (
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                      校区：{ticket.campusName}
                    </span>
                  ) : null}
                  {ticket.overdue ? (
                    <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-700">
                      处理已超时
                    </span>
                  ) : null}
                </div>
                <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_180px]">
                  <div className="space-y-2 text-sm text-slate-600">
                    <p>主题：{ticket.subject}</p>
                    <p>提交时间：{formatDateTime(ticket.createdAt)}</p>
                  </div>
                  <Link
                    href={`/support/${ticket.id}`}
                    className="block h-fit rounded-full border border-slate-200 px-4 py-2 text-center text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                  >
                    查看详情
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
