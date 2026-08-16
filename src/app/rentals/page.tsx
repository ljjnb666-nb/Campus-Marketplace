import React from "react";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { RentalCard } from "@/components/rental/rental-card";
import { Pagination } from "@/components/site/pagination";
import { getRentalListings, getRentalFormMeta } from "@/repositories/rental-listing-repository";
import type { RentalListingStatus } from "@prisma/client";
import { Search, RotateCcw, PlusCircle, Filter } from "lucide-react";
import {
  buildListingSearchParams,
  parsePageParam,
} from "@/lib/listing-search-params";

export const dynamic = "force-dynamic";

const quickSorts = [
  { label: "最新发布", sort: "latest" },
  { label: "最受欢迎", sort: "popular" },
  { label: "低价优先", sort: "price_asc" },
  { label: "高价优先", sort: "price_desc" },
];

export default async function RentalsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    categoryId?: string;
    pricingUnit?: string;
    minPrice?: string;
    maxPrice?: string;
    noDeposit?: string;
    sort?: "latest" | "price_asc" | "price_desc" | "popular";
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const session = await auth();
  const page = parsePageParam(params.page);

  const [result, meta] = await Promise.all([
    getRentalListings({
      q: params.q?.trim(),
      categoryId: params.categoryId,
      pricingUnit: params.pricingUnit as "PER_HOUR" | "PER_DAY" | "PER_WEEK" | "PER_MONTH" | "PER_SESSION" | undefined,
      minPrice: params.minPrice,
      maxPrice: params.maxPrice,
      noDeposit: params.noDeposit === "true",
      sort: params.sort ?? "latest",
      page,
    }).catch(() => ({ items: [], total: 0, page: 1, pageSize: 12, totalPages: 1 })),
    getRentalFormMeta(),
  ]);

  const search = buildListingSearchParams([
    { key: "q", value: params.q },
    { key: "categoryId", value: params.categoryId },
    { key: "pricingUnit", value: params.pricingUnit },
    { key: "minPrice", value: params.minPrice },
    { key: "maxPrice", value: params.maxPrice },
    { key: "noDeposit", value: params.noDeposit === "true" ? "true" : undefined },
    { key: "sort", value: params.sort, omitWhen: "latest" },
  ]);

  return (
    <PageContainer maxWidth="wide">
      {/* 页头 */}
      <PageHeader
        title="物品租赁广场"
        description="发掘同校优质闲置设备与工具，按天/按周短租，省钱物尽其用"
        action={
          session?.user ? (
            <Link
              href="/rentals/new"
              className="inline-flex items-center gap-1.5 rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 px-4 py-2.5 text-xs font-bold text-white shadow-md shadow-indigo-600/20 transition hover:from-indigo-700 hover:to-indigo-800 hover:shadow-lg active:scale-95"
            >
              <PlusCircle className="size-4" />
              <span>发布出租</span>
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

            const buildSortHref = () => {
              const nextParams = new URLSearchParams(search.toString());
              if (item.sort === "latest") {
                nextParams.delete("sort");
              } else {
                nextParams.set("sort", item.sort);
              }
              const query = nextParams.toString();
              return query ? `/rentals?${query}` : "/rentals";
            };

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
          共 {result.total} 件可租物品
        </span>
      </div>

      {/* 筛选条 */}
      <form className="mb-6 rounded-3xl border border-slate-200/80 bg-white p-4 shadow-sm space-y-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          <div className="relative sm:col-span-2">
            <Search className="absolute left-3.5 top-3 size-4 text-slate-400" />
            <input
              type="text"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="搜索相机、自行车、游戏机、计算器等..."
              className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 pl-10 pr-4 py-2 text-xs text-slate-900 outline-none transition focus:border-indigo-500 focus:bg-white dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>

          <select
            name="categoryId"
            defaultValue={params.categoryId ?? ""}
            className="rounded-2xl border border-slate-200 bg-slate-50/50 px-3 py-2 text-xs font-medium text-slate-900 outline-none transition focus:border-indigo-500 focus:bg-white dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
          >
            <option value="">全部分类</option>
            {meta.categories?.map((category: { id: string; name: string }) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>

          <select
            name="pricingUnit"
            defaultValue={params.pricingUnit ?? ""}
            className="rounded-2xl border border-slate-200 bg-slate-50/50 px-3 py-2 text-xs font-medium text-slate-900 outline-none transition focus:border-indigo-500 focus:bg-white dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
          >
            <option value="">全部计价模式</option>
            <option value="PER_HOUR">按小时</option>
            <option value="PER_DAY">按天</option>
            <option value="PER_WEEK">按周</option>
            <option value="PER_MONTH">按月</option>
            <option value="PER_SESSION">按次</option>
          </select>

          <label className="flex items-center gap-2.5 rounded-2xl border border-slate-200/80 bg-slate-50/50 px-3.5 py-2 text-xs text-slate-700 cursor-pointer dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
            <input
              type="checkbox"
              name="noDeposit"
              value="true"
              defaultChecked={params.noDeposit === "true"}
              className="size-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span>只看免押金物品</span>
          </label>
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 pt-3 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="0"
              step="0.01"
              name="minPrice"
              defaultValue={params.minPrice ?? ""}
              placeholder="最低租金"
              className="w-24 rounded-xl border border-slate-200 bg-slate-50/50 px-3 py-1.5 text-xs outline-none dark:border-slate-800 dark:bg-slate-950"
            />
            <span className="text-slate-400 text-xs">-</span>
            <input
              type="number"
              min="0"
              step="0.01"
              name="maxPrice"
              defaultValue={params.maxPrice ?? ""}
              placeholder="最高租金"
              className="w-24 rounded-xl border border-slate-200 bg-slate-50/50 px-3 py-1.5 text-xs outline-none dark:border-slate-800 dark:bg-slate-950"
            />
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <Link
              href="/rentals"
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
          title="没有找到符合条件的租赁物品"
          description="试试调整搜索关键字，或者出租你闲置的单车或相机吧。"
          action={
            <Link
              href="/rentals/new"
              className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-slate-800 dark:bg-indigo-600"
            >
              <span>发布租赁物品</span>
            </Link>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 lg:gap-6">
            {result.items.map((item) => (
              <RentalCard
                key={item.id}
                id={item.id}
                title={item.title}
                price={item.price.toString()}
                pricingUnit={item.pricingUnit as "PER_HOUR" | "PER_DAY" | "PER_WEEK" | "PER_MONTH" | "PER_SESSION"}
                depositAmount={item.depositAmount.toString()}
                pickupLocation={item.pickupLocation}
                status={item.status as RentalListingStatus}
                imageUrl={item.images?.[0]?.url}
                ownerName={item.owner.name}
                ownerVerified={item.owner.verificationStatus === "VERIFIED"}
                favoriteCount={item.favoriteCount || 0}
                categoryName={item.category.name}
              />
            ))}
          </div>
          <div className="mt-8">
            <Pagination pathname="/rentals" params={search} page={result.page} totalPages={result.totalPages} />
          </div>
        </>
      )}
    </PageContainer>
  );
}
