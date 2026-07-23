import Link from "next/link";
import { REPORT_REASON_LABELS } from "@/constants/report";
import { requireAdmin } from "@/lib/server-auth";
import { getAdminDashboardData } from "@/repositories/admin-repository";

export const dynamic = "force-dynamic";

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

const entries = [
  { href: "/admin/verifications", label: "认证审核" },
  { href: "/admin/reports", label: "举报处理" },
  { href: "/admin/users", label: "用户管理" },
  { href: "/admin/products", label: "商品管理" },
  { href: "/admin/errands", label: "任务管理" },
  { href: "/admin/services", label: "服务管理" },
  { href: "/admin/categories", label: "分类管理" },
  { href: "/admin/keywords", label: "关键词管理" },
] as const;

const overviewCards = [
  { key: "totalUsers", label: "用户总数" },
  { key: "todayNewUsers", label: "今日新增用户" },
  { key: "totalProducts", label: "商品总数" },
  { key: "activeProducts", label: "在售商品数" },
  { key: "todayNewProducts", label: "今日发布商品数" },
  { key: "totalErrands", label: "跑腿任务总数" },
  { key: "completedErrands", label: "已完成任务数" },
  { key: "totalReports", label: "举报总数" },
  { key: "latestReports", label: "待处理举报数" },
] as const;

function getReportTargetSummary(item: Awaited<ReturnType<typeof getAdminDashboardData>>["openReports"][number]) {
  if (item.product) return `商品：${item.product.title}`;
  if (item.errandTask) return `任务：${item.errandTask.title}`;
  if (item.serviceListing) return `服务：${item.serviceListing.title}`;
  if (item.targetUser) return `用户：${item.targetUser.name}`;
  if (item.message) return `消息：${item.message.content.slice(0, 30)}`;
  return "未知目标";
}

export default async function AdminPage() {
  await requireAdmin();
  const data = await getAdminDashboardData();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">管理后台</h1>
        <p className="mt-2 text-sm text-slate-600">
          集中处理认证审核、举报工单和平台内容巡检。
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Link
          href="/admin/verifications"
          className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300"
        >
          <p className="text-sm text-slate-500">待审核认证</p>
          <p className="mt-3 text-4xl font-semibold text-slate-950">{data.latestVerifications}</p>
        </Link>
        <Link
          href="/admin/reports"
          className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300"
        >
          <p className="text-sm text-slate-500">待处理举报</p>
          <p className="mt-3 text-4xl font-semibold text-slate-950">{data.latestReports}</p>
        </Link>
        <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-500">今日新增认证</p>
          <p className="mt-3 text-4xl font-semibold text-slate-950">{data.todayNewVerifications}</p>
        </div>
        <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-500">今日新增举报</p>
          <p className="mt-3 text-4xl font-semibold text-slate-950">{data.todayNewReports}</p>
        </div>
      </div>

      <section className="mt-8">
        <div className="mb-4">
          <h2 className="text-xl font-semibold text-slate-950">平台数据总览</h2>
          <p className="mt-1 text-sm text-slate-600">
            覆盖用户、商品、跑腿任务与举报的核心统计指标。
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {overviewCards.map((item) => (
            <div key={item.key} className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-sm text-slate-500">{item.label}</p>
              <p className="mt-3 text-4xl font-semibold text-slate-950">{data[item.key]}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="mt-6 grid gap-3 md:grid-cols-3">
        {entries.map((entry) => (
          <Link
            key={entry.href}
            href={entry.href}
            className="rounded-2xl border border-slate-200 bg-white px-5 py-4 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:text-slate-950"
          >
            {entry.label}
          </Link>
        ))}
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-xl font-semibold text-slate-950">最新认证申请</h2>
            <Link href="/admin/verifications" className="text-sm text-slate-600 hover:text-slate-950">
              查看全部
            </Link>
          </div>
          <div className="grid gap-4">
            {data.pendingVerifications.length === 0 ? (
              <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">暂无待审核认证。</div>
            ) : (
              data.pendingVerifications.map((item) => (
                <div key={item.id} className="rounded-2xl border border-slate-200 p-4 text-sm text-slate-600">
                  <p className="font-medium text-slate-950">{item.user.name}</p>
                  <p className="mt-1">
                    {item.schoolName} · {item.campusName}
                  </p>
                  <p className="mt-1">提交时间：{formatDate(item.submittedAt)}</p>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-xl font-semibold text-slate-950">最新举报工单</h2>
            <Link href="/admin/reports" className="text-sm text-slate-600 hover:text-slate-950">
              查看全部
            </Link>
          </div>
          <div className="grid gap-4">
            {data.openReports.length === 0 ? (
              <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">暂无待处理举报。</div>
            ) : (
              data.openReports.map((item) => (
                <div key={item.id} className="rounded-2xl border border-slate-200 p-4 text-sm text-slate-600">
                  <p className="font-medium text-slate-950">{REPORT_REASON_LABELS[item.reason]}</p>
                  <p className="mt-1">举报人：{item.reporter.name}</p>
                  <p className="mt-1">目标：{getReportTargetSummary(item)}</p>
                  <p className="mt-1">提交时间：{formatDate(item.createdAt)}</p>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
