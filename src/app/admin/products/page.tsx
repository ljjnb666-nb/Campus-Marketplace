 
import Link from "next/link";
import { moderateListing } from "@/actions/admin";
import { PRODUCT_STATUS_LABELS } from "@/constants/product";
import { requireAdmin } from "@/lib/server-auth";
import { getAdminProductList } from "@/repositories/admin-repository";

export const dynamic = "force-dynamic";

export default async function AdminProductsPage() {
  await requireAdmin();
  const products = await getAdminProductList();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-slate-950">商品管理</h1>
        <p className="mt-2 text-sm text-slate-600">集中处理商品内容、发布状态和下架操作。</p>
      </div>

      <div className="grid gap-4">
        {products.length === 0 ? (
          <div className="rounded-[28px] border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
            暂无待管理商品。
          </div>
        ) : (
          products.map((product) => (
            <article key={product.id} className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <div className="grid gap-6 lg:grid-cols-[140px_1fr_auto]">
                <img
                  src={product.images[0]?.url ?? "/uploads/placeholders/product-cover.svg"}
                  alt={product.title}
                  className="h-28 w-full rounded-2xl object-cover"
                />
                <div className="space-y-3 text-sm text-slate-600">
                  <div>
                    <h2 className="text-xl font-semibold text-slate-950">{product.title}</h2>
                    <p className="mt-1 line-clamp-2">{product.description}</p>
                  </div>
                  <div className="flex flex-wrap gap-4 text-xs text-slate-500">
                    <span>分类：{product.category.name}</span>
                    <span>卖家：{product.seller.name}</span>
                    <span>状态：{PRODUCT_STATUS_LABELS[product.status]}</span>
                    <span>价格：￥{product.price.toString()}</span>
                  </div>
                  <Link href={`/products/${product.id}`} className="inline-block text-sm text-slate-700 underline">
                    查看详情
                  </Link>
                </div>
                <form
                  action={async (formData) => {
                    "use server";
                    await moderateListing(formData);
                  }}
                  className="flex items-center"
                >
                  <input type="hidden" name="targetType" value="PRODUCT" />
                  <input type="hidden" name="targetId" value={product.id} />
                  <button
                    type="submit"
                    className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                  >
                    强制下架
                  </button>
                </form>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
