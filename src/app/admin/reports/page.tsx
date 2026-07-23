import { reviewReport } from "@/actions/admin";
import { REPORT_REASON_LABELS, REPORT_STATUS_LABELS } from "@/constants/report";
import { requireAdmin } from "@/lib/server-auth";
import { getReportReviewQueue } from "@/repositories/admin-repository";

export const dynamic = "force-dynamic";

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function getTargetSummary(item: Awaited<ReturnType<typeof getReportReviewQueue>>[number]) {
  if (item.product) {
    return `商品：${item.product.title}`;
  }

  if (item.errandTask) {
    return `任务：${item.errandTask.title}`;
  }

  if (item.serviceListing) {
    return `服务：${item.serviceListing.title}`;
  }

  if (item.targetUser) {
    return `用户：${item.targetUser.name}`;
  }

  if (item.message) {
    return `消息：${item.message.content.slice(0, 60)}`;
  }

  return "未知目标";
}

export default async function AdminReportsPage() {
  await requireAdmin();
  const items = await getReportReviewQueue();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">举报处理</h1>
        <p className="mt-2 text-sm text-slate-600">统一处理商品、任务、服务、用户和消息举报。</p>
      </div>

      <div className="grid gap-4">
        {items.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            当前没有待处理举报。
          </div>
        ) : (
          items.map((item) => (
            <article key={item.id} className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
                <div className="space-y-3 text-sm text-slate-600">
                  <h2 className="text-xl font-semibold text-slate-950">{REPORT_REASON_LABELS[item.reason]}</h2>
                  <p>状态：{REPORT_STATUS_LABELS[item.status]}</p>
                  <p>举报人：{item.reporter.name}</p>
                  <p>目标：{getTargetSummary(item)}</p>
                  <p>提交时间：{formatDate(item.createdAt)}</p>
                  <p>说明：{item.detail ?? "无"}</p>
                  {item.handledNote ? <p>上次处理备注：{item.handledNote}</p> : null}
                </div>

                <form action={reviewReport} className="space-y-3 rounded-[24px] bg-slate-50 p-5">
                  <input type="hidden" name="reportId" value={item.id} />
                  <label className="flex flex-col gap-2 text-sm">
                    处理备注
                    <textarea
                      name="handledNote"
                      rows={4}
                      defaultValue={item.handledNote ?? ""}
                      className="rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
                      placeholder="填写处理说明"
                    />
                  </label>
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="submit"
                      name="status"
                      value="IN_REVIEW"
                      className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                    >
                      标记处理中
                    </button>
                    <button
                      type="submit"
                      name="status"
                      value="RESOLVED"
                      className="rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
                    >
                      处理完成
                    </button>
                    <button
                      type="submit"
                      name="status"
                      value="REJECTED"
                      className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                    >
                      驳回举报
                    </button>
                  </div>
                </form>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
