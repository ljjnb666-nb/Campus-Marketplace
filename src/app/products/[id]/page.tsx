import React from "react";
import type { Metadata } from "next";
import { PageContainer } from "@/components/ui/page-container";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { ImageGallery } from "@/components/ui/image-gallery";
import { ProductCard } from "@/components/product/product-card";
import { ProductDetailConsole } from "@/components/product/product-detail-console";
import { auth } from "@/lib/auth";
import { getProductDetail } from "@/repositories/product-repository";

export const dynamic = "force-dynamic";

const PRODUCT_DETAIL_FALLBACK_METADATA: Metadata = {
  title: "商品详情 - 校园集市",
  description: "查看校园集市同校在售二手闲置商品详情。",
};

function truncateForMetadata(text: string, maxLength = 80) {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;

  try {
    const { product } = await getProductDetail(id, undefined, { countView: false });
    const title = `${product.title} - 校园集市`;
    const description = truncateForMetadata(
      product.description || `查看校园集市在售二手闲置「${product.title}」的价格、成色与卖家信息。`,
    );

    return { title, description, openGraph: { title, description } };
  } catch (error) {
    // notFound()/redirect() 等 Next.js 控制流错误必须原样抛出，
    // 否则 404 语义被兜底 metadata 吞掉，缺失商品会返回 200
    if (
      error !== null &&
      typeof error === "object" &&
      "digest" in error &&
      typeof error.digest === "string" &&
      error.digest.startsWith("NEXT_")
    ) {
      throw error;
    }
    return PRODUCT_DETAIL_FALLBACK_METADATA;
  }
}

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
