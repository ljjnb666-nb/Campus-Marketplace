import React from "react";
import { PageContainer } from "@/components/ui/page-container";
import { StatusBadge } from "@/components/ui/status-badge";
import { ProductCard } from "@/components/product/product-card";
import { ErrandCard } from "@/components/errand/errand-card";
import { ServiceCard } from "@/components/service/service-card";
import { VERIFICATION_STATUS_LABELS } from "@/constants/user";
import { getPublicUserProfile } from "@/repositories/user-repository";
import { ShieldCheck, Calendar, Award, Package, HeartHandshake, CheckCircle2 } from "lucide-react";

export const dynamic = "force-dynamic";

function formatDate(value: Date | string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(new Date(value));
}

export default async function PublicUserPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getPublicUserProfile(id);
  const isVerified = user.verificationStatus === "VERIFIED";

  // 好评率防误导处理
  const hasReviewData = user.completedOrdersCount > 0 && typeof user.positiveReviewRate === "number";
  const reviewText = hasReviewData
    ? `${Math.round((user.positiveReviewRate ?? 1) * 100)}%`
    : "暂无评价";

  return (
    <PageContainer maxWidth="standard">
      {/* 个人主页顶部 Hero 展台 */}
      <div className="relative overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        {/* 背景 Banner */}
        <div className="h-32 w-full bg-gradient-to-r from-indigo-500 via-sky-500 to-indigo-600 sm:h-40" />

        <div className="relative px-6 pb-6 pt-0 sm:px-8">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 -mt-12 sm:-mt-14 mb-6">
            <div className="flex items-end gap-4">
              {/* 大头像 */}
              <div className="relative size-24 shrink-0 overflow-hidden rounded-3xl border-4 border-white bg-slate-100 shadow-md dark:border-slate-900 dark:bg-slate-800">
                {user.avatarUrl ? (
                   
                  <img src={user.avatarUrl} alt={user.name} className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-indigo-600 to-indigo-700 font-bold text-white text-3xl">
                    {user.name.slice(0, 1).toUpperCase()}
                  </div>
                )}
                {isVerified && (
                  <div className="absolute bottom-1 right-1 rounded-full bg-white p-1 shadow-xs dark:bg-slate-900">
                    <ShieldCheck className="size-4 text-emerald-500 fill-emerald-100" />
                  </div>
                )}
              </div>

              <div className="pt-2 sm:pt-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-slate-100">
                    {user.name}
                  </h1>
                  <StatusBadge
                    label={VERIFICATION_STATUS_LABELS[user.verificationStatus] || "已验证"}
                    variant={isVerified ? "success" : "neutral"}
                    size="sm"
                  />
                </div>
                <p className="text-xs text-slate-500">
                  {user.schoolName} · {user.campus.name}
                  {user.college ? ` · ${user.college}` : ""}
                  {user.grade ? ` · ${user.grade}` : ""}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-400 flex items-center gap-1">
                <Calendar className="size-3.5" />
                注册时间：{formatDate(user.createdAt)}
              </span>
            </div>
          </div>

          <p className="text-xs sm:text-sm text-slate-600 leading-relaxed dark:text-slate-400 max-w-3xl">
            {user.bio || "这个同学很神秘，还没有填写个人简介。"}
          </p>

          {/* 关键交易统计数据指标栏 */}
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 border-t border-slate-100 pt-6 dark:border-slate-800">
            <div className="rounded-2xl bg-slate-50/80 p-3.5 text-center dark:bg-slate-950/40">
              <div className="flex items-center justify-center gap-1 text-xs text-slate-500">
                <CheckCircle2 className="size-3.5 text-emerald-500" />
                <span>完成订单</span>
              </div>
              <p className="mt-1 text-xl sm:text-2xl font-black text-slate-900 dark:text-slate-100">
                {user.completedOrdersCount}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50/80 p-3.5 text-center dark:bg-slate-950/40">
              <div className="flex items-center justify-center gap-1 text-xs text-slate-500">
                <Award className="size-3.5 text-indigo-500" />
                <span>好评率</span>
              </div>
              <p className="mt-1 text-xl sm:text-2xl font-black text-slate-900 dark:text-slate-100">
                {reviewText}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50/80 p-3.5 text-center dark:bg-slate-950/40">
              <div className="flex items-center justify-center gap-1 text-xs text-slate-500">
                <Package className="size-3.5 text-sky-500" />
                <span>在售闲置</span>
              </div>
              <p className="mt-1 text-xl sm:text-2xl font-black text-slate-900 dark:text-slate-100">
                {user.visibleCounts.products}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50/80 p-3.5 text-center dark:bg-slate-950/40">
              <div className="flex items-center justify-center gap-1 text-xs text-slate-500">
                <HeartHandshake className="size-3.5 text-amber-500" />
                <span>服务与任务</span>
              </div>
              <p className="mt-1 text-xl sm:text-2xl font-black text-slate-900 dark:text-slate-100">
                {user.visibleCounts.serviceListings + user.visibleCounts.createdErrandTasks}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* 发布的内容卡片 */}
      <div className="mt-10 space-y-10">
        {/* Ta 发布的商品 */}
        <section className="space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3 dark:border-slate-800">
            <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-slate-100">
              Ta 发布的闲置商品 ({user.products.length})
            </h2>
          </div>
          {user.products.length === 0 ? (
            <p className="text-xs text-slate-400 py-4">该用户暂未发布二手闲置商品。</p>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {user.products.map((product) => (
                <ProductCard
                  key={product.id}
                  id={product.id}
                  title={product.title}
                  description={product.description}
                  price={product.price.toString()}
                  status={product.status}
                  category={product.category.name}
                  seller={user.name}
                  imageUrl={product.images[0]?.url}
                  favoriteCount={product.favoriteCount}
                />
              ))}
            </div>
          )}
        </section>

        {/* Ta 发布的任务 */}
        <section className="space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3 dark:border-slate-800">
            <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-slate-100">
              Ta 发布的跑腿求助 ({user.createdErrandTasks.length})
            </h2>
          </div>
          {user.createdErrandTasks.length === 0 ? (
            <p className="text-xs text-slate-400 py-4">该用户暂未发布跑腿任务。</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {user.createdErrandTasks.map((errand) => (
                <ErrandCard
                  key={errand.id}
                  id={errand.id}
                  title={errand.title}
                  reward={errand.reward.toString()}
                  pickupLocation={errand.pickupLocation}
                  deliveryLocation={errand.deliveryLocation}
                  publisher={user.name}
                  status={errand.status}
                />
              ))}
            </div>
          )}
        </section>

        {/* Ta 提供的服务 */}
        <section className="space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3 dark:border-slate-800">
            <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-slate-100">
              Ta 上架的技能服务 ({user.serviceListings.length})
            </h2>
          </div>
          {user.serviceListings.length === 0 ? (
            <p className="text-xs text-slate-400 py-4">该用户暂未上架技能服务。</p>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {user.serviceListings.map((service) => (
                <ServiceCard
                  key={service.id}
                  id={service.id}
                  title={service.title}
                  description={service.description}
                  price={service.price.toString()}
                  pricingUnit={service.pricingUnit}
                  status={service.status as "ACTIVE" | "PAUSED" | "OFFLINE"}
                  provider={user.name}
                  locationText={service.locationText}
                  categoryName={service.category.name}
                  coverImageUrl={service.coverImageUrl}
                  completedOrderCount={service.completedOrderCount}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </PageContainer>
  );
}
