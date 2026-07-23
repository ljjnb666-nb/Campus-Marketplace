import Link from "next/link";
import { auth } from "@/lib/auth";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { ServiceCard } from "@/components/service/service-card";
import { Pagination } from "@/components/site/pagination";
import { getServiceList } from "@/repositories/service-repository";
import { Search, RotateCcw, PlusCircle, Filter } from "lucide-react";
import {
  buildListingSearchParams,
  hrefWithQuery,
  parsePageParam,
  withSortParam,
} from "@/lib/listing-search-params";

export const dynamic = "force-dynamic";

const pricingUnits = [
  { value: "ALL", label: "全部计费方式" },
  { value: "PER_SESSION", label: "按次" },
  { value: "PER_HOUR", label: "按小时" },
  { value: "PER_ORDER", label: "按单" },
  { value: "NEGOTIABLE", label: "面议" },
] as const;

const statusLabels = {
  ALL: "全部状态",
  ACTIVE: "接单中",
  PAUSED: "暂停接单",
  OFFLINE: "已下架",
} as const;

const quickSorts = [
  { label: "最新发布", sort: "latest" },
  { label: "成交优先", sort: "orders_desc" },
  { label: "低价优先", sort: "price_asc" },
  { label: "高价优先", sort: "price_desc" },
];

export default async function ServicesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: "ACTIVE" | "PAUSED" | "OFFLINE" | "ALL";
    pricingUnit?: "PER_SESSION" | "PER_HOUR" | "PER_ORDER" | "NEGOTIABLE" | "ALL";
    category?: string;
    verifiedOnly?: string;
    sort?: "latest" | "price_asc" | "price_desc" | "orders_desc";
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const session = await auth();
  const page = parsePageParam(params.page);
  const verifiedOnly = params.verifiedOnly === "true";
  const result = await getServiceList({
    q: params.q?.trim(),
    status: params.status ?? "ALL",
    pricingUnit: params.pricingUnit ?? "ALL",
    categorySlug: params.category?.trim() || undefined,
    verifiedOnly,
    sort: params.sort ?? "latest",
    page,
  }).catch(() => ({ items: [], total: 0, page: 1, pageSize: 12, totalPages: 1, categories: [] }));

  const search = buildListingSearchParams([
    { key: "q", value: params.q },
    { key: "status", value: params.status, omitWhen: "ALL" },
    { key: "pricingUnit", value: params.pricingUnit, omitWhen: "ALL" },
    { key: "category", value: params.category },
    { key: "verifiedOnly", value: verifiedOnly ? "true" : undefined },
    { key: "sort", value: params.sort, omitWhen: "latest" },
  ]);

  const selectedCategory = result.categories.find((item) => item.slug === params.category);
  const selectedPricingUnit =
    params.pricingUnit && params.pricingUnit !== "ALL"
      ? pricingUnits.find((item) => item.value === params.pricingUnit)?.label ?? params.pricingUnit
      : null;

  const activeFilters = [
    params.q ? `关键词：${params.q}` : null,
    params.status && params.status !== "ALL" ? `状态：${statusLabels[params.status]}` : null,
    selectedPricingUnit ? `计费：${selectedPricingUnit}` : null,
    selectedCategory ? `分类：${selectedCategory.name}` : null,
    verifiedOnly ? "仅看已认证服务者" : null,
  ].filter(Boolean) as string[];

  return (
    <PageContainer maxWidth="wide">
      {/* 页头 */}
      <PageHeader
        title="技能服务广场"
        description="寻找同校学长学姐摄影、辅导、设计、修电脑等技能服务"
        action={
          session?.user ? (
            <Link
              href="/services/new"
              className="inline-flex items-center gap-1.5 rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 px-4 py-2.5 text-xs font-bold text-white shadow-md shadow-indigo-600/20 transition hover:from-indigo-700 hover:to-indigo-800 hover:shadow-lg active:scale-95"
            >
              <PlusCircle className="size-4" />
              <span>发布技能服务</span>
            </Link>
          ) : (
            <Link
              href="/login"
              className="inline-flex items-center gap-1.5 rounded-2xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white shadow-md transition hover:bg-slate-800 dark:bg-indigo-600"
            >
              <span>登录后发布</span>
            </Link>
          )
        }
      />

      {/* 快捷排序 */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {quickSorts.map((item) => {
            const activeSort = params.sort ?? "latest";
            const isActive = activeSort === item.sort;

            const buildSortHref = () =>
              hrefWithQuery("/services", withSortParam(search, item.sort));

            return (
              <Link
                key={item.sort}
                href={buildSortHref()}
                className={`rounded-full px-4 py-1.5 text-xs font-semibold transition ${
                  isActive
                    ? "bg-slate-900 text-white dark:bg-indigo-600"
                    : "bg-white text-slate-600 border border-slate-200 hover:border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>

        <span className="text-xs text-slate-400 font-medium">
          共 {result.total} 项技能服务
        </span>
      </div>

      {/* 筛选条 */}
      <form className="mb-6 rounded-3xl border border-slate-200/80 bg-white p-4 shadow-sm space-y-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
          <div className="relative sm:col-span-2">
            <Search className="absolute left-3.5 top-3 size-4 text-slate-400" />
            <input
              type="text"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="搜索技能服务标题、描述或服务位置..."
              className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 pl-10 pr-4 py-2 text-xs text-slate-900 outline-none transition focus:border-indigo-500 focus:bg-white dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>

          <select
            name="category"
            defaultValue={params.category ?? ""}
            className="rounded-2xl border border-slate-200 bg-slate-50/50 px-3 py-2 text-xs font-medium text-slate-900 outline-none transition focus:border-indigo-500 focus:bg-white dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
          >
            <option value="">全部分类</option>
            {result.categories.map((category) => (
              <option key={category.id} value={category.slug}>
                {category.name}
              </option>
            ))}
          </select>

          <select
            name="pricingUnit"
            defaultValue={params.pricingUnit ?? "ALL"}
            className="rounded-2xl border border-slate-200 bg-slate-50/50 px-3 py-2 text-xs font-medium text-slate-900 outline-none transition focus:border-indigo-500 focus:bg-white dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
          >
            {pricingUnits.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-2.5 rounded-2xl border border-slate-200/80 bg-slate-50/50 px-3.5 py-2 text-xs text-slate-700 cursor-pointer dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
            <input
              type="checkbox"
              name="verifiedOnly"
              value="true"
              defaultChecked={verifiedOnly}
              className="size-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span>仅看已认证学生</span>
          </label>
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 pt-3 dark:border-slate-800">
          <div className="flex items-center gap-2 flex-wrap">
            {activeFilters.map((item) => (
              <span
                key={item}
                className="inline-flex items-center gap-1 rounded-md bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700 border border-indigo-200/50 dark:bg-indigo-950/40 dark:text-indigo-300"
              >
                {item}
              </span>
            ))}
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <Link
              href="/services"
              className="inline-flex items-center gap-1 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-400"
            >
              <RotateCcw className="size-3.5" />
              <span>重置</span>
            </Link>
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-1.5 text-xs font-bold text-white shadow-xs hover:bg-slate-800 dark:bg-indigo-600 dark:hover:bg-indigo-700"
            >
              <Filter className="size-3.5" />
              <span>筛选</span>
            </button>
          </div>
        </div>
      </form>

      {/* 结果列表 */}
      {result.items.length === 0 ? (
        <EmptyState
          title="没有找到符合条件的技能服务"
          description="试试调整搜索关键字，或者展示你自己的技能吧。"
          action={
            <Link
              href="/services/new"
              className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-slate-800 dark:bg-indigo-600"
            >
              <span>发布技能服务</span>
            </Link>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 lg:gap-6">
            {result.items.map((item) => (
              <ServiceCard
                key={item.id}
                id={item.id}
                title={item.title}
                description={item.description}
                price={item.price.toString()}
                pricingUnit={item.pricingUnit}
                status={item.status as "ACTIVE" | "PAUSED" | "OFFLINE"}
                provider={item.provider.name}
                locationText={item.locationText}
                categoryName={item.category.name}
                coverImageUrl={item.coverImageUrl}
                completedOrderCount={item.completedOrderCount}
              />
            ))}
          </div>
          <div className="mt-8">
            <Pagination pathname="/services" params={search} page={result.page} totalPages={result.totalPages} />
          </div>
        </>
      )}
    </PageContainer>
  );
}
