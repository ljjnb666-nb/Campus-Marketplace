import { notFound } from "next/navigation";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/server-auth";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import {
  canReadAnalyticsCampus, deriveAnalyticsReadAccess, hasAnyAnalyticsReadAccess,
} from "@/lib/analytics/analytics-read-access";
import { loadAuthorizedAnalyticsOverview } from "@/lib/analytics/analytics-overview-query";

export const dynamic = "force-dynamic";
const CAMPUS_ID = /^[A-Za-z0-9_-]{1,128}$/;

function fmtDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

export default async function GovernanceAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireUser();
  const access = deriveAnalyticsReadAccess(await loadAuthorizationContext(actor.id));
  if (!hasAnyAnalyticsReadAccess(access)) notFound();

  const params = await searchParams;
  if (Object.keys(params).some(key => key !== "campusId" && key !== "days")) notFound();
  if (Array.isArray(params.campusId) || Array.isArray(params.days)) notFound();
  const rawScope = params.campusId;
  if (rawScope !== undefined && (typeof rawScope !== "string" || !CAMPUS_ID.test(rawScope))) notFound();
  if (params.days !== undefined && params.days !== "7" && params.days !== "30") notFound();
  const periodDays = params.days === "7" ? 7 : 30;

  // Discovery only: the service rechecks current user/membership permission
  // before querying tenant facts. A campus-only grant never becomes global.
  const campuses = await prisma.campus.findMany({
    where: access.global ? {} : { id: { in: access.campusIds } },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 100,
  });
  const campusId = rawScope ?? campuses[0]?.id ?? null;
  if (campusId !== null && !canReadAnalyticsCampus(access, campusId)) notFound();

  // An authorized scope may sort beyond the first 100 options.
  if (campusId && !campuses.some(item => item.id === campusId)) {
    const extra = await prisma.campus.findUnique({
      where: { id: campusId }, select: { id: true, name: true },
    });
    if (!extra) notFound();
    campuses.push(extra);
  }

  const overview = campusId
    ? await loadAuthorizedAnalyticsOverview({ actorId: actor.id, campusId, periodDays })
    : null;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-10 sm:px-6">
      <header className="rounded-3xl bg-slate-950 p-7 text-white sm:p-9">
        <p className="text-xs font-semibold tracking-widest text-indigo-200">治理控制台 / 运营分析</p>
        <h1 className="mt-3 text-3xl font-semibold">校园交易分析</h1>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
          校区流动性概览。当前可见供给来自业务最新状态；期间数据来自异步领域事件投影。
          两者口径不同，不用于审计、处罚、账户权限或真实支付结算。
        </p>
      </header>

      <form method="get" action="/governance/analytics" aria-label="运营分析范围"
        className="grid gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="text-sm font-semibold text-slate-700">
          分析校区
          <select name="campusId" defaultValue={campusId ?? ""}
            className="mt-2 block w-full rounded-xl border border-slate-300 px-3 py-3 text-sm font-normal text-slate-950">
            {campuses.length === 0 && <option value="">没有可用校区</option>}
            {campuses.map(campus => <option key={campus.id} value={campus.id}>{campus.name}</option>)}
          </select>
        </label>
        <label className="text-sm font-semibold text-slate-700">
          事件统计区间
          <select name="days" defaultValue={String(periodDays)}
            className="mt-2 block w-full rounded-xl border border-slate-300 px-3 py-3 text-sm font-normal text-slate-950">
            <option value="7">最近 7 × 24 小时</option>
            <option value="30">最近 30 × 24 小时</option>
          </select>
        </label>
        <button type="submit"
          className="rounded-xl bg-indigo-700 px-6 py-3 text-sm font-semibold text-white hover:bg-indigo-800">
          更新视图
        </button>
      </form>

      {!overview ? (
        <section className="rounded-3xl border border-slate-200 bg-white p-10 text-sm text-slate-600">
          当前没有可以分析的授权校区。
        </section>
      ) : (
        <>
          <section aria-label="当前在售供给" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold tracking-wide text-indigo-700">业务当前状态 · 非历史事件</p>
                <h2 className="mt-2 text-xl font-semibold text-slate-900">当前可见供给</h2>
                <p className="mt-1 text-xs text-slate-500">{overview.campusName} · 快照时间 {fmtDate(overview.currentSupply.capturedAt)}（北京时间）</p>
              </div>
              <p className="text-4xl font-semibold tabular-nums text-slate-950">{overview.currentSupply.total}<span className="ml-2 text-sm font-normal text-slate-600">条</span></p>
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              {[
                { label: "二手商品", value: overview.currentSupply.product },
                { label: "技能服务", value: overview.currentSupply.service },
                { label: "物品租赁", value: overview.currentSupply.rental },
              ].map(item => (
                <div key={item.label} className="rounded-2xl bg-slate-50 px-5 py-4">
                  <p className="text-xs text-slate-600">{item.label}</p>
                  <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-900">{item.value}</p>
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs leading-6 text-slate-500">
              已排除已删除、未上架、不可租或治理隐藏的供给。跑腿是需求，不计入供给总数。
            </p>
          </section>

          <section aria-label="期间流动性指标" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <h2 className="text-xl font-semibold text-slate-950">期间流动性指标</h2>
            <p className="mt-2 text-xs leading-6 text-slate-600">
              {fmtDate(overview.from)} 至 {fmtDate(overview.until)}（北京时间）
              · 投影 v{overview.projectionVersion} · 以事件发生时间计算（闭区间）。
            </p>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              {overview.metrics.map(metric => (
                <article key={metric.metricKey} className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                  <p className="text-sm font-semibold text-slate-700">{metric.label}</p>
                  <p className="mt-3 text-3xl font-semibold tabular-nums text-slate-950">{metric.total}</p>
                  <p className="mt-1 text-xs text-slate-500">指标定义 v{metric.metricVersion}</p>
                  <div className="mt-4 space-y-2">
                    {metric.dimensions.length === 0 ? (
                      <p className="text-xs text-slate-500">暂无已投影的事件</p>
                    ) : metric.dimensions.map(row => (
                      <div key={row.label} className="flex justify-between gap-4 border-t border-slate-200 pt-2 text-xs text-slate-700">
                        <span>{row.label}</span><span className="font-semibold tabular-nums">{row.value}</span>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
            <p role="note" className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs leading-6 text-amber-950">
              统计基于异步投影，处理延迟、历史补录或重新投影期间可能暂时不完整；零值表示本版本已投影数据为零，
              不保证真实业务完全没有发生。当前「完成交易记账对价」只计有可靠价格的商品、跑腿与租赁完成事实，
              不包含技能服务、押金、赔付、平台抽成；不能称为 GMV、收款或结算额。
            </p>
          </section>

          <section aria-label="暂未提供的指标" className="rounded-3xl border border-slate-200 bg-white p-6 sm:p-8">
            <h2 className="text-lg font-semibold text-slate-950">待建立可信口径</h2>
            <p className="mt-3 text-sm leading-7 text-slate-600">
              搜索零结果率、首次互动耗时、列表到会话转化率、会话到订单转化率、留存率与供需匹配缺口，
              尚无可直接复用的完整权威统计，因此不展示估算数值或伪造趋势。
            </p>
          </section>
        </>
      )}
    </main>
  );
}
