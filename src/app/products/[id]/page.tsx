import React from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageContainer } from "@/components/ui/page-container";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { ImageGallery } from "@/components/ui/image-gallery";
import { ProductCard } from "@/components/product/product-card";
import { ProductDetailConsole } from "@/components/product/product-detail-console";
import { WindDownBanner } from "@/components/listing/wind-down-banner";
import { getActiveViewerId } from "@/lib/server-auth";
import { PRODUCT_WIND_DOWN_MESSAGES } from "@/lib/listings/listing-lifecycle";
import {
  isListingTransactionParticipant,
  resolveListingLifecycleAccess,
} from "@/lib/listings/listing-visibility";
import {
  hasActiveModerationForPublicSurface,
  resolvePublicDetailModerationGate,
} from "@/lib/moderation/listing-moderation-query";
import { ModerationHiddenBanner } from "@/components/listing/moderation-state";
import { getProductDetail, incrementProductView } from "@/repositories/product-repository";

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
    // Phase 7C FR-03：metadata 属 PUBLIC surface——active moderation 时
    // 返回 generic fallback（owner exception 不适用于 metadata）。
    if (await hasActiveModerationForPublicSurface("PRODUCT", product.id)) {
      return PRODUCT_DETAIL_FALLBACK_METADATA;
    }
    // Phase 8F（§19）：generateMetadata 是 PUBLIC surface——只有 public
    // exposed（ACTIVE）才允许生成 listing title/description OpenGraph
    // metadata；wind-down listing 返回 generic fallback，且不因 owner
    // 登录改变 crawler metadata。
    if (product.status !== "ACTIVE") {
      return PRODUCT_DETAIL_FALLBACK_METADATA;
    }
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
  // Phase 6C-2 raw-auth hardening：收藏状态/owner 个性化按 ACTIVE 账号解析；
  // SUSPENDED 会话 → null → 匿名语义（收藏态与 isOwner 抑制），公开详情照常
  const viewerId = await getActiveViewerId();
  // Phase 7C FR-03B：浏览计数移到治理门之后——hidden/owner-hidden 请求
  // 零 Product 写入（updatedAt 推进会作废 restore freshness token）。
  const { product, relatedProducts } = await getProductDetail(id, viewerId ?? undefined, {
    countView: false,
  });

  // Phase 8F（§14-§17）Detail Access Policy（lifecycle 维度）：
  //   PUBLIC    匿名 / 无关第三方：仅 ACTIVE 可见，否则 notFound（§15，
  //             不泄漏 title/description/location/seller/status/price）
  //   OWNER     seller 查看自己 wind-down listing（§16）
  //   PARTICIPANT 该商品既有 Order 买卖双方保留履约上下文（§17，
  //             private obligation continuity，非 public exposure）
  const isParticipant = await isListingTransactionParticipant("PRODUCT", product.id, viewerId);
  const lifecycleRole = resolveListingLifecycleAccess({
    status: product.status,
    viewerId,
    ownerId: product.sellerId,
    isParticipant,
  });
  if (lifecycleRole === null) {
    notFound();
  }

  // Phase 7C PUBLIC detail 治理特例：活跃 moderation ∧ 非 owner → notFound()；
  // owner → 渲染 + 安全横幅（OWNER_EDIT_WHILE_HIDDEN = ALLOWED_V1）。
  // Phase 8F 参与方特权不得绕过治理保密——HIDDEN 对 participant 仍 notFound，
  // 既有义务继续走 Order private surfaces（§18）。
  const moderationGate = await resolvePublicDetailModerationGate({
    viewerId,
    ownerId: product.sellerId,
    targetType: "PRODUCT",
    listingId: product.id,
  });
  if (moderationGate === "HIDDEN") {
    notFound();
  }
  // Phase 8F（§20）：viewCount 只计 true PUBLIC exposure——owner 查看
  // wind-down listing / participant 查看历史 listing / metadata 请求 /
  // hidden probe 一律不计数
  if (lifecycleRole === "PUBLIC" && moderationGate === "OPEN") {
    await incrementProductView(product.id);
  }
  const isOwner = viewerId === product.sellerId;
  const isFavorited = Array.isArray(product.favorites) && product.favorites.length > 0;
  const windDownMessage =
    lifecycleRole !== "PUBLIC" ? PRODUCT_WIND_DOWN_MESSAGES[product.status as "ACTIVE" | "RESERVED" | "SOLD" | "OFFLINE"] : "";

  return (
    <PageContainer maxWidth="standard">
      {moderationGate === "OWNER_VIEW" && <ModerationHiddenBanner />}
      {/* Phase 8F（§45）：owner / 参与方查看 wind-down listing 的明确中文状态 */}
      {windDownMessage && <WindDownBanner message={windDownMessage} />}
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
          isLoggedIn={!!viewerId}
        />
      </div>
    </PageContainer>
  );
}
