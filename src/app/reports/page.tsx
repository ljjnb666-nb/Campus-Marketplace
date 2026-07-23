import Link from "next/link";
import { REPORT_REASON_LABELS, REPORT_STATUS_LABELS } from "@/constants/report";
import { requireUser } from "@/lib/server-auth";
import { getMyReports } from "@/repositories/trust-repository";

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

function getReportTarget(report: Awaited<ReturnType<typeof getMyReports>>[number]) {
  if (report.product) return `商品：${report.product.title}`;
  if (report.errandTask) return `任务：${report.errandTask.title}`;
  if (report.serviceListing) return `服务：${report.serviceListing.title}`;
  if (report.targetUser) return `用户：${report.targetUser.name}`;
  if (report.message) return `消息：${report.message.content.slice(0, 30)}`;
  return "未知目标";
}

export default async function ReportsPage() {
  const user = await requireUser();
  const reports = await getMyReports(user.id);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">举报中心</h1>
        <p className="mt-2 text-sm text-slate-600">
          查看你提交过的举报记录。商品、任务、服务、用户主页和私信消息都可以直接发起举报。
        </p>
      </div>

      <div className="mb-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Link href="/products" className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-950">从商品页举报</h2>
          <p className="mt-2 text-sm text-slate-600">
            在商品详情页可以直接举报虚假信息、价格欺诈和违禁商品。
          </p>
        </Link>
        <Link href="/errands" className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-950">从任务页举报</h2>
          <p className="mt-2 text-sm text-slate-600">
            在任务详情页可以举报违规跑腿、作弊代做等内容。
          </p>
        </Link>
        <Link href="/services" className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-950">从服务页举报</h2>
          <p className="mt-2 text-sm text-slate-600">
            在服务详情页和用户主页可以举报违规服务或可疑用户。
          </p>
        </Link>
        <Link href="/messages" className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-950">从会话页举报</h2>
          <p className="mt-2 text-sm text-slate-600">
            在站内会话详情页可以直接举报骚扰消息、广告引流和其他违规私信内容。
          </p>
        </Link>
      </div>

      <div className="grid gap-4">
        {reports.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            你还没有提交过举报。
          </div>
        ) : (
          reports.map((report) => (
            <article key={report.id} className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <div className="grid gap-2 text-sm text-slate-600">
                <h2 className="text-xl font-semibold text-slate-950">{getReportTarget(report)}</h2>
                <p>状态：{REPORT_STATUS_LABELS[report.status]}</p>
                <p>原因：{REPORT_REASON_LABELS[report.reason]}</p>
                <p>说明：{report.detail ?? "无"}</p>
                <p>提交时间：{formatDate(report.createdAt)}</p>
                {report.handledNote ? <p>处理备注：{report.handledNote}</p> : null}
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
