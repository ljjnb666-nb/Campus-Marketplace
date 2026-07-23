import Link from "next/link";
import { ErrandCard } from "@/components/errand/errand-card";
import { ProductCard } from "@/components/product/product-card";
import { ServiceCard } from "@/components/service/service-card";
import { getSearchResults } from "@/repositories/search-repository";

export const dynamic = "force-dynamic";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const params = await searchParams;
  const keyword = params.q?.trim() ?? "";
  const results = keyword
    ? await getSearchResults(keyword)
    : { products: [], errands: [], services: [], users: [] };
  const total =
    results.products.length + results.errands.length + results.services.length + results.users.length;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8 space-y-3">
        <h1 className="text-3xl font-semibold text-slate-950">全站搜索</h1>
        <p className="text-sm text-slate-600">搜索商品、跑腿、服务和校园用户。</p>
        <form className="flex max-w-2xl gap-3">
          <input
            type="text"
            name="q"
            defaultValue={keyword}
            placeholder="输入关键词，例如：自行车、代取、PPT、考研"
            className="flex-1 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
          />
          <button
            type="submit"
            className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            搜索
          </button>
        </form>
        {keyword ? (
          <p className="text-sm text-slate-500">关键词“{keyword}”共找到 {total} 条结果。</p>
        ) : (
          <p className="text-sm text-slate-500">先输入关键词，再查看搜索结果。</p>
        )}
      </div>

      {keyword && total === 0 ? (
        <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          没有找到相关内容，可以换一个关键词再试。
        </div>
      ) : null}

      {results.products.length > 0 ? (
        <section className="mb-10">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-2xl font-semibold text-slate-950">二手商品</h2>
            <Link
              href={`/products?q=${encodeURIComponent(keyword)}`}
              className="text-sm text-slate-600 hover:text-slate-950"
            >
              查看更多
            </Link>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {results.products.map((product) => (
              <ProductCard
                key={product.id}
                id={product.id}
                title={product.title}
                description={product.description}
                price={`¥${product.price.toString()}`}
                status={product.status}
                category={product.category.name}
                seller={product.seller.name}
                imageUrl={product.images[0]?.url}
                favoriteCount={product.favoriteCount}
              />
            ))}
          </div>
        </section>
      ) : null}

      {results.errands.length > 0 ? (
        <section className="mb-10">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-2xl font-semibold text-slate-950">校园跑腿</h2>
            <Link
              href={`/errands?q=${encodeURIComponent(keyword)}`}
              className="text-sm text-slate-600 hover:text-slate-950"
            >
              查看更多
            </Link>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {results.errands.map((errand) => (
              <ErrandCard
                key={errand.id}
                id={errand.id}
                title={errand.title}
                reward={errand.reward.toString()}
                pickupLocation={errand.pickupLocation}
                deliveryLocation={errand.deliveryLocation}
                publisher={errand.publisher.name}
                status={errand.status}
              />
            ))}
          </div>
        </section>
      ) : null}

      {results.services.length > 0 ? (
        <section className="mb-10">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-2xl font-semibold text-slate-950">技能服务</h2>
            <Link
              href={`/services?q=${encodeURIComponent(keyword)}`}
              className="text-sm text-slate-600 hover:text-slate-950"
            >
              查看更多
            </Link>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {results.services.map((service) => (
              <ServiceCard
                key={service.id}
                id={service.id}
                title={service.title}
                description={service.description}
                price={`¥${service.price.toString()}`}
                pricingUnit={service.pricingUnit}
                status={service.status as "ACTIVE" | "PAUSED" | "OFFLINE"}
                provider={service.provider.name}
                locationText={service.locationText}
                coverImageUrl={service.coverImageUrl}
                completedOrderCount={service.completedOrderCount}
              />
            ))}
          </div>
        </section>
      ) : null}

      {results.users.length > 0 ? (
        <section>
          <div className="mb-4">
            <h2 className="text-2xl font-semibold text-slate-950">校园用户</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {results.users.map((user) => (
              <Link
                key={user.id}
                href={`/users/${user.id}`}
                className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-slate-950">{user.name}</h3>
                    <p className="mt-1 text-sm text-slate-500">
                      {user.schoolName} · {user.campus.name}
                    </p>
                  </div>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                    {Math.round(user.positiveReviewRate * 100)}% 好评
                  </span>
                </div>
                <p className="mt-3 line-clamp-2 text-sm text-slate-600">
                  {user.bio ?? "这个同学还没有填写个人简介。"}
                </p>
                <div className="mt-4 flex flex-wrap gap-4 text-xs text-slate-500">
                  <span>商品 {user.visibleCounts.products}</span>
                  <span>任务 {user.visibleCounts.createdErrandTasks}</span>
                  <span>服务 {user.visibleCounts.serviceListings}</span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
