import React from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageContainer } from "@/components/ui/page-container";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { ImageGallery } from "@/components/ui/image-gallery";
import { RentalDetailConsole } from "@/components/rental/rental-detail-console";
import { auth } from "@/lib/auth";
import { getRentalListingDetail } from "@/repositories/rental-listing-repository";
import { FileText, ShieldAlert, Star } from "lucide-react";

export const dynamic = "force-dynamic";

const conditionMapping: Record<string, string> = {
  NEW: "全新",
  LIKE_NEW: "99新",
  LIGHTLY_USED: "95新",
  NORMAL_USED: "9成新",
  HEAVILY_USED: "8成新及以下",
};

const RENTAL_DETAIL_FALLBACK_METADATA: Metadata = {
  title: "租赁物品详情 - 校园集市",
  description: "查看校园集市闲置租赁物品的租金、押金与租借规则。",
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
  const result = await getRentalListingDetail(id, undefined, { countView: false }).catch(() => null);

  if (!result) {
    return RENTAL_DETAIL_FALLBACK_METADATA;
  }

  const { listing } = result;
  const title = `${listing.title} - 校园集市`;
  const description = truncateForMetadata(
    listing.description || `查看校园集市闲置租赁「${listing.title}」的租金、押金与租借规则。`,
  );

  return { title, description, openGraph: { title, description } };
}

export default async function RentalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  const result = await getRentalListingDetail(id, session?.user?.id).catch(() => null);

  if (!result) {
    notFound();
  }

  const { listing, reviews, isFavorited } = result;
  const isOwner = session?.user?.id === listing.ownerId;

  return (
    <PageContainer maxWidth="standard">
      {/* 面包屑 */}
      <Breadcrumbs
        items={[
          { label: "租赁广场", href: "/rentals" },
          { label: listing.category.name, href: `/rentals?categoryId=${listing.categoryId}` },
          { label: listing.title },
        ]}
      />

      {/* 55% : 45% 双栏布局 */}
      <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
        {/* 左侧：画廊 + 详细描述 + 规则政策 + 历史评价 */}
        <div className="space-y-8">
          {/* 电商级媒体画廊 */}
          <ImageGallery images={listing.images} title={listing.title} />

          {/* 物品基本成色与品牌参项 */}
          <div className="flex flex-wrap gap-3 text-xs text-slate-600">
            {listing.condition && (
              <span className="rounded-xl bg-slate-100 px-3 py-1.5 font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                成色：{conditionMapping[listing.condition] ?? listing.condition}
              </span>
            )}
            {listing.brand && (
              <span className="rounded-xl bg-slate-100 px-3 py-1.5 font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                品牌：{listing.brand}
              </span>
            )}
            {listing.model && (
              <span className="rounded-xl bg-slate-100 px-3 py-1.5 font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                型号：{listing.model}
              </span>
            )}
            {listing.referenceValue && (
              <span className="rounded-xl bg-slate-100 px-3 py-1.5 font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                参考原价：¥{Number(listing.referenceValue).toFixed(2)}
              </span>
            )}
          </div>

          {/* 物品详细描述 */}
          <section className="space-y-4 rounded-3xl border border-slate-200/80 bg-white p-6 sm:p-8 shadow-xs dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2 border-b border-slate-100 pb-3 dark:border-slate-800">
              <span className="inline-block size-2 rounded-full bg-indigo-600" />
              物品使用说明与描述
            </h2>
            <div className="prose prose-slate max-w-none text-sm leading-relaxed whitespace-pre-wrap text-slate-700 dark:text-slate-300">
              {listing.description}
            </div>
          </section>

          {/* 租赁交接与赔偿规则 */}
          <section className="space-y-4 rounded-3xl border border-slate-200/80 bg-white p-6 sm:p-8 shadow-xs dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2 border-b border-slate-100 pb-3 dark:border-slate-800">
              <FileText className="size-4 text-indigo-600" />
              租赁使用与赔偿规则
            </h2>

            <div className="grid gap-4 sm:grid-cols-2 text-xs">
              <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4 space-y-2 dark:border-slate-800 dark:bg-slate-950/40">
                <h4 className="font-bold text-slate-900 dark:text-slate-100">取还地点说明</h4>
                <p className="text-slate-600 dark:text-slate-400">取货：{listing.pickupLocation}</p>
                <p className="text-slate-600 dark:text-slate-400">归还：{listing.returnLocation}</p>
              </div>

              <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4 space-y-2 dark:border-slate-800 dark:bg-slate-950/40">
                <h4 className="font-bold text-slate-900 dark:text-slate-100">使用要求与注意事项</h4>
                <p className="text-slate-600 dark:text-slate-400">
                  {listing.usageRules || "请爱惜同校同学物品，按约定用途合规使用。"}
                </p>
              </div>

              {listing.damagePolicy && (
                <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4 space-y-2 dark:border-slate-800 dark:bg-slate-950/40">
                  <h4 className="font-bold text-slate-900 dark:text-slate-100">损坏赔偿政策</h4>
                  <p className="text-slate-600 dark:text-slate-400">{listing.damagePolicy}</p>
                </div>
              )}

              {listing.overduePolicy && (
                <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4 space-y-2 dark:border-slate-800 dark:bg-slate-950/40">
                  <h4 className="font-bold text-slate-900 dark:text-slate-100">逾期处理说明</h4>
                  <p className="text-slate-600 dark:text-slate-400">{listing.overduePolicy}</p>
                </div>
              )}
            </div>
          </section>

          {/* 评价模块 */}
          {reviews && reviews.length > 0 && (
            <section className="space-y-4 rounded-3xl border border-slate-200/80 bg-white p-6 sm:p-8 shadow-xs dark:border-slate-800 dark:bg-slate-900">
              <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2 border-b border-slate-100 pb-3 dark:border-slate-800">
                <Star className="size-4 fill-amber-400 text-amber-400" />
                租客评价 ({reviews.length})
              </h2>

              <div className="space-y-4">
                {reviews.map((rev) => (
                  <div key={rev.id} className="border-b border-slate-100 pb-3 last:border-0 dark:border-slate-800 space-y-1 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-900 dark:text-slate-100">{rev.author.name}</span>
                      <span className="text-amber-500 font-bold">★ {rev.overallRating} 分</span>
                    </div>
                    {rev.content && <p className="text-slate-600 dark:text-slate-400">{rev.content}</p>}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 安全提醒 */}
          <div className="flex items-start gap-3 rounded-3xl border border-amber-200/60 bg-amber-50/50 p-5 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300">
            <ShieldAlert className="size-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-bold">校园安全面交说明</p>
              <p className="text-amber-800/80 dark:text-amber-300/80 leading-relaxed">
                取货交接时请当面查验设备/物品完整性与工作状态。归还时请原样归还。
              </p>
            </div>
          </div>
        </div>

        {/* 右侧：Sticky 控制台 */}
        <RentalDetailConsole
          listing={{
            ...listing,
            price: listing.price.toString(),
            depositAmount: listing.depositAmount.toString(),
            referenceValue: listing.referenceValue ? listing.referenceValue.toString() : null,
            owner: {
              ...listing.owner,
              schoolName: listing.campus.schoolName || "认证校区",
              completedOrdersCount: listing.owner.rentalOwnerCount || 0,
            },
          }}
          isOwner={isOwner}
          isFavorited={isFavorited}
          isLoggedIn={!!session?.user}
        />
      </div>
    </PageContainer>
  );
}
