 
import Link from "next/link";
import { deleteProduct } from "@/actions/product";
import { ProductStatusActions } from "@/components/product/product-status-actions";
import { PRODUCT_STATUS_LABELS } from "@/constants/product";
import { requireUser } from "@/lib/server-auth";
import { getMyProducts } from "@/repositories/product-repository";

export const dynamic = "force-dynamic";

export default async function MyProductsPage() {
  const user = await requireUser();
  const products = await getMyProducts(user.id);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-slate-950">我的发布</h1>
          <p className="mt-2 text-sm text-slate-600">
            这里可以查看、编辑和管理你发布的商品状态。
          </p>
        </div>
        <Link
          href="/products/new"
          className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
        >
          发布新商品
        </Link>
      </div>

      <div className="grid gap-4">
        {products.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            你还没有发布商品。
          </div>
        ) : (
          products.map((product) => (
            <article
              key={product.id}
              className="grid gap-4 rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm lg:grid-cols-[180px_1fr_auto]"
            >
              <img
                src={product.images[0]?.url ?? "/uploads/placeholders/product-cover.svg"}
                alt={product.title}
                className="h-40 w-full rounded-2xl object-cover"
              />
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
                  <span>{product.category.name}</span>
                  <span>·</span>
                  <span>{PRODUCT_STATUS_LABELS[product.status]}</span>
                </div>
                <h2 className="text-xl font-semibold text-slate-950">{product.title}</h2>
                <p className="line-clamp-2 text-sm text-slate-600">{product.description}</p>
                <div className="flex flex-wrap gap-5 pt-1 text-sm text-slate-500">
                  <span>价格：¥{product.price.toString()}</span>
                  <span>浏览：{product.viewCount}</span>
                  <span>收藏：{product.favoriteCount}</span>
                </div>
                <div className="flex flex-wrap gap-3 pt-2">
                  <Link
                    href={`/products/${product.id}`}
                    className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                  >
                    查看详情
                  </Link>
                  <Link
                    href={`/products/${product.id}/edit`}
                    className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                  >
                    编辑
                  </Link>
                  <form action={deleteProduct}>
                    <input type="hidden" name="productId" value={product.id} />
                    <button
                      type="submit"
                      className="rounded-full border border-rose-200 px-4 py-2 text-sm font-medium text-rose-700 transition hover:border-rose-300 hover:text-rose-800"
                    >
                      删除
                    </button>
                  </form>
                </div>
              </div>
              <div className="flex flex-col gap-2 lg:items-end">
                <ProductStatusActions productId={product.id} currentStatus={product.status} />
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
