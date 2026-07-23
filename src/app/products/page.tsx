import Link from "next/link";
import { auth } from "@/lib/auth";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { ProductCard } from "@/components/product/product-card";
import { Pagination } from "@/components/site/pagination";
import { getProductFormMeta, getProductList } from "@/repositories/product-repository";
import { Search, RotateCcw, PlusCircle, Filter } from "lucide-react";
import {
  buildListingSearchParams,
  hrefWithQuery,
  parsePageParam,
  withSortParam,
} from "@/lib/listing-search-params";

export const dynamic = "force-dynamic";

const quickSorts = [
  { label: "最新发布", sort: "latest" },
  { label: "最受欢迎", sort: "popular" },
  { label: "低价优先", sort: "price_asc" },
  { label: "高价优先", sort: "price_desc" },
];

const statusLabels = {
  ALL: "全部状态",
  ACTIVE: "在售",
  RESERVED: "已预订",
  SOLD: "已售出",
  OFFLINE: "已下架",
} as const;

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    category?: string;
    status?: "ACTIVE" | "RESERVED" | "SOLD" | "OFFLINE" | "ALL";
    minPrice?: string;
    maxPrice?: string;
    sort?: "latest" | "price_asc" | "price_desc" | "popular";
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const session = await auth();
  const page = parsePageParam(params.page);
  const [result, meta] = await Promise.all([
    getProductList({
      q: params.q?.trim(),
      category: params.category,
      status: params.status ?? "ALL",
      minPrice: params.minPrice,
      maxPrice: params.maxPrice,
      sort: params.sort ?? "latest",
      page,
      currentUserId: session?.user?.id,
    }).catch(() => ({ items: [], total: 0, page: 1, pageSize: 12, totalPages: 1 })),
    getProductFormMeta(),
  ]);

  const search = buildListingSearchParams([
    { key: "q", value: params.q },
    { key: "category", value: params.category },
    { key: "status", value: params.status, omitWhen: "ALL" },
    { key: "minPrice", value: params.minPrice },
    { key: "maxPrice", value: params.maxPrice },
    { key: "sort", value: params.sort, omitWhen: "latest" },
  ]);

  const selectedCategoryName = params.category
    ? meta.categories.find((item) => item.id === params.category)?.name ?? "已选分类"
    : null;

  const activeFilters = [
    params.q ? `关键词：${params.q}` : null,
    selectedCategoryName ? `分类：${selectedCategoryName}` : null,
    params.status && params.status !== "ALL" ? `状态：${statusLabels[params.status]}` : null,
    params.minPrice ? `最低价：¥${params.minPrice}` : null,
    params.maxPrice ? `最高价：¥${params.maxPrice}` : null,
  ].filter(Boolean) as string[];

  return (
    <PageContainer maxWidth="wide">
      {/* 统一 顶栏 */}
      <PageHeader
        title="二手商品广场"
        description="浏览同校区闲置二手商品，同校面对面交易，省心又安全"
        action={
          session?.user ? (
            <Link
              href="/products/new"
              className="inline-flex items-center gap-1.5 rounded-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 px-4 py-2.5 text-xs font-bold text-white shadow-md shadow-indigo-600/20 transition hover:from-indigo-700 hover:to-indigo-800 hover:shadow-lg active:scale-95"
            >
              <PlusCircle className="size-4" />
              <span>发布商品</span>
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

      {/* 快捷排序 Tabs */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {quickSorts.map((item) => {
            const activeSort = params.sort ?? "latest";
            const isActive = activeSort === item.sort;

            const buildSortHref = () =>
              hrefWithQuery("/products", withSortParam(search, item.sort));

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
          共 {result.total} 件在售商品
        </span>
      </div>

      {/* 统一 FilterBar 工具条 */}
      <form className="mb-6 rounded-3xl border border-slate-200/80 bg-white p-4 shadow-sm space-y-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          <div className="relative sm:col-span-2">
            <Search className="absolute left-3.5 top-3 size-4 text-slate-400" />
            <input
              type="text"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="搜索商品标题、描述..."
              className="w-full rounded-2xl border border-slate-200 bg-slate-50/50 pl-10 pr-4 py-2 text-xs text-slate-900 outline-none transition focus:border-indigo-500 focus:bg-white dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>

          <select
            name="category"
            defaultValue={params.category ?? ""}
            className="rounded-2xl border border-slate-200 bg-slate-50/50 px-3 py-2 text-xs font-medium text-slate-900 outline-none transition focus:border-indigo-500 focus:bg-white dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
          >
            <option value="">全部分类</option>
            {meta.categories.map((category) => (
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
            <option value="ACTIVE">在售</option>
            <option value="RESERVED">已预订</option>
            <option value="SOLD">已售出</option>
          </select>

          <input
            type="number"
            min="0"
            step="0.01"
            name="minPrice"
            defaultValue={params.minPrice ?? ""}
            placeholder="最低价 ¥"
            className="rounded-2xl border border-slate-200 bg-slate-50/50 px-3.5 py-2 text-xs text-slate-900 outline-none transition focus:border-indigo-500 focus:bg-white dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
          />

          <input
            type="number"
            min="0"
            step="0.01"
            name="maxPrice"
            defaultValue={params.maxPrice ?? ""}
            placeholder="最高价 ¥"
            className="rounded-2xl border border-slate-200 bg-slate-50/50 px-3.5 py-2 text-xs text-slate-900 outline-none transition focus:border-indigo-500 focus:bg-white dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
          />
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
              href="/products"
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

      {/* 结果列表与空状态 */}
      {result.items.length === 0 ? (
        <EmptyState
          title="没有找到符合条件的商品"
          description="试试调整搜索关键字，或者重置筛选条件。"
          action={
            <Link
              href="/products"
              className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-slate-800 dark:bg-indigo-600"
            >
              <span>查看全部商品</span>
            </Link>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 lg:gap-6">
            {result.items.map((product) => (
              <ProductCard
                key={product.id}
                id={product.id}
                title={product.title}
                description={product.description}
                price={product.price.toString()}
                status={product.status}
                category={product.category.name}
                seller={product.seller.name}
                imageUrl={product.images[0]?.url}
                favoriteCount={product.favoriteCount}
              />
            ))}
          </div>
          <div className="mt-8">
            <Pagination pathname="/products" params={search} page={result.page} totalPages={result.totalPages} />
          </div>
        </>
      )}
    </PageContainer>
  );
}
