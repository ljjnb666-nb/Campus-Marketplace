import Link from "next/link";
import { auth } from "@/lib/auth";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrandCard } from "@/components/errand/errand-card";
import { Pagination } from "@/components/site/pagination";
import { getErrandList } from "@/repositories/errand-repository";
import { Search, RotateCcw, PlusCircle, Filter } from "lucide-react";
import {
  buildListingSearchParams,
  hrefWithQuery,
  parsePageParam,
  withSortParam,
} from "@/lib/listing-search-params";

export const dynamic = "force-dynamic";

const quickSorts = [
  { label: "最新发布", sort: "latest", deadline: "" },
  { label: "高赏金优先", sort: "reward_desc", deadline: "" },
  { label: "即将截止", sort: "deadline_asc", deadline: "" },
  { label: "今日内截止", sort: "deadline_asc", deadline: "today" },
];

const deadlineLabels = {
  today: "今天内截止",
  "3days": "3 天内截止",
  "7days": "7 天内截止",
} as const;

const statusLabels = {
  OPEN: "待接单",
  CLAIMED: "已接单",
  IN_PROGRESS: "进行中",
  PENDING_CONFIRMATION: "待确认",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
} as const;

export default async function ErrandsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    category?: string;
    status?:
      | "OPEN"
      | "CLAIMED"
      | "IN_PROGRESS"
      | "PENDING_CONFIRMATION"
      | "COMPLETED"
      | "CANCELLED"
      | "ALL";
    deadline?: "today" | "3days" | "7days" | "all";
    sort?: "latest" | "reward_desc" | "reward_asc" | "deadline_asc";
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const session = await auth();
  const page = parsePageParam(params.page);
  const result = await getErrandList({
    q: params.q?.trim(),
    category: params.category,
    status: params.status ?? "ALL",
    deadline: params.deadline ?? "all",
    sort: params.sort ?? "latest",
    page,
  }).catch(() => ({ items: [], total: 0, categories: [], page: 1, pageSize: 12, totalPages: 1 }));

  const search = buildListingSearchParams([
    { key: "q", value: params.q },
    { key: "category", value: params.category },
    { key: "status", value: params.status, omitWhen: "ALL" },
    { key: "deadline", value: params.deadline, omitWhen: "all" },
    { key: "sort", value: params.sort, omitWhen: "latest" },
  ]);

  const selectedCategoryName = params.category
    ? result.categories.find((item) => item.id === params.category)?.name ?? "已选分类"
    : null;

  const activeFilters = [
    params.q ? `关键词：${params.q}` : null,
    selectedCategoryName ? `分类：${selectedCategoryName}` : null,
    params.status && params.status !== "ALL" ? `状态：${statusLabels[params.status]}` : null,
    params.deadline && params.deadline !== "all" ? `截止时间：${deadlineLabels[params.deadline]}` : null,
  ].filter(Boolean) as string[];

  return (
    <PageContainer maxWidth="wide">
      {/* 页头 */}
      <PageHeader
        title="跑腿求助大厅"
        description="校内代取快递、代购、帮送物品，同校互帮互助"
        action={
          session?.user ? (
            <Link
              href="/errands/new"
              className="inline-flex items-center gap-1.5 rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 px-4 py-2.5 text-xs font-bold text-white shadow-md shadow-indigo-600/20 transition hover:from-indigo-700 hover:to-indigo-800 hover:shadow-lg active:scale-95"
            >
              <PlusCircle className="size-4" />
              <span>发布跑腿</span>
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
            const activeDeadline = params.deadline ?? "all";
            const isActive =
              item.deadline === "today"
                ? activeDeadline === "today"
                : activeSort === item.sort && activeDeadline !== "today";

            const buildSortHref = () => {
              const nextParams = withSortParam(search, item.sort);
              if (item.deadline) {
                nextParams.set("deadline", item.deadline);
              } else {
                nextParams.delete("deadline");
              }
              return hrefWithQuery("/errands", nextParams);
            };

            return (
              <Link
                key={item.label}
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
          共 {result.total} 条跑腿任务
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
              placeholder="搜索任务标题、描述或路线地点..."
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
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>

          <select
            name="status"
            defaultValue={params.status ?? "ALL"}
            className="rounded-2xl border border-slate-200 bg-slate-50/50 px-3 py-2 text-xs font-medium text-slate-900 outline-none transition focus:border-indigo-500 focus:bg-white dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
          >
            <option value="ALL">全部状态</option>
            <option value="OPEN">待接单</option>
            <option value="CLAIMED">已接单</option>
            <option value="IN_PROGRESS">进行中</option>
            <option value="COMPLETED">已完成</option>
          </select>

          <select
            name="deadline"
            defaultValue={params.deadline ?? "all"}
            className="rounded-2xl border border-slate-200 bg-slate-50/50 px-3 py-2 text-xs font-medium text-slate-900 outline-none transition focus:border-indigo-500 focus:bg-white dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
          >
            <option value="all">全部截止时间</option>
            <option value="today">今天内截止</option>
            <option value="3days">3 天内截止</option>
            <option value="7days">7 天内截止</option>
          </select>
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
              href="/errands"
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

      {/* 内容网格 */}
      {result.items.length === 0 ? (
        <EmptyState
          title="没有找到符合条件的跑腿任务"
          description="试试调整搜索关键字，或者发布一个新跑腿吧。"
          action={
            <Link
              href="/errands/new"
              className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-slate-800 dark:bg-indigo-600"
            >
              <span>发布跑腿任务</span>
            </Link>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 lg:gap-6">
            {result.items.map((item) => (
              <ErrandCard
                key={item.id}
                id={item.id}
                title={`${item.category.name} · ${item.title}`}
                reward={item.reward.toString()}
                pickupLocation={item.pickupLocation}
                deliveryLocation={item.deliveryLocation}
                publisher={item.publisher.name}
                status={item.status}
              />
            ))}
          </div>
          <div className="mt-8">
            <Pagination pathname="/errands" params={search} page={result.page} totalPages={result.totalPages} />
          </div>
        </>
      )}
    </PageContainer>
  );
}
