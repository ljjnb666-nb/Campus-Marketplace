import React from "react";
import { PageContainer } from "@/components/ui/page-container";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { ImageGallery } from "@/components/ui/image-gallery";
import { ProductCard } from "@/components/product/product-card";
import { ProductDetailConsole } from "@/components/product/product-detail-console";
import { auth } from "@/lib/auth";
import { getProductDetail } from "@/repositories/product-repository";

export const dynamic = "force-dynamic";

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  const { product, relatedProducts } = await getProductDetail(id, session?.user?.id);
  const isOwner = session?.user?.id === product.sellerId;
  const isFavorited = Array.isArray(product.favorites) && product.favorites.length > 0;

  return (
    <PageContainer maxWidth="standard">
      {/* 1. 面包屑导航 */}
      <Breadcrumbs
        items={[
          { label: "二手集市", href: "/products" },
          { label: product.category.name, href: `/products?categoryId=${product.categoryId}` },
          { label: product.title },
        ]}
      />

      {/* 2. 主从双栏：55% 画廊/描述 + 45% Sticky 控制台 */}
      <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
        {/* 左侧：画廊 + 物品描述 + 推荐网格 */}
        <div className="space-y-8">
          {/* 电商级媒体画廊 */}
          <ImageGallery images={product.images} title={product.title} />

          {/* 详细描述 */}
          <section className="space-y-4 rounded-3xl border border-slate-200/80 bg-white p-6 sm:p-8 shadow-xs dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2 border-b border-slate-100 pb-3 dark:border-slate-800">
              <span className="inline-block size-2 rounded-full bg-indigo-600" />
              物品详细描述
            </h2>
            <div className="prose prose-slate max-w-none text-sm leading-relaxed whitespace-pre-wrap text-slate-700 dark:text-slate-300">
              {product.description || "卖家暂未补充更多描述说明。建议私聊沟通确认详情。"}
            </div>
          </section>

          {/* 为你推荐 (紧跟在左侧介绍下方，不受右侧影响) */}
          {relatedProducts.length > 0 && (
            <section className="space-y-4 pt-4">
              <div className="flex items-end justify-between border-b border-slate-100 pb-3 dark:border-slate-800">
                <div>
                  <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-slate-100">
                    为你推荐同校好物
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    优先展示同校区、同分类的热门在售二手商品
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {relatedProducts.map((item) => (
                  <ProductCard
                    key={item.id}
                    id={item.id}
                    title={item.title}
                    description={item.description}
                    price={`¥${item.price.toString()}`}
                    status={item.status}
                    category={item.category.name}
                    seller={item.seller.name}
                    imageUrl={item.images[0]?.url}
                    favoriteCount={item.favoriteCount}
                    reason={item.reason}
                  />
                ))}
              </div>
            </section>
          )}
        </div>

        {/* 右侧：Sticky 交易控制台面板 */}
        <ProductDetailConsole
          product={{
            ...product,
            price: product.price.toString(),
            originalPrice: product.originalPrice ? product.originalPrice.toString() : null,
          }}
          isSeller={isOwner}
          isFavorited={isFavorited}
          isLoggedIn={!!session?.user}
        />
      </div>
    </PageContainer>
  );
}
