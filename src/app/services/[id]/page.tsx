import React from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageContainer } from "@/components/ui/page-container";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { ImageGallery } from "@/components/ui/image-gallery";
import { ServiceCard } from "@/components/service/service-card";
import { ServiceDetailConsole } from "@/components/service/service-detail-console";
import { getActiveViewerId } from "@/lib/server-auth";
import { SERVICE_WIND_DOWN_MESSAGES } from "@/lib/listings/listing-lifecycle";
import {
  isListingTransactionParticipant,
  resolveListingLifecycleAccess,
} from "@/lib/listings/listing-visibility";
import { resolvePublicDetailModerationGate } from "@/lib/moderation/listing-moderation-query";
import { ModerationHiddenBanner } from "@/components/listing/moderation-state";
import { WindDownBanner } from "@/components/listing/wind-down-banner";
import { hasActiveModerationForPublicSurface } from "@/lib/moderation/listing-moderation-query";
import { getServiceDetail } from "@/repositories/service-repository";
import { CheckCircle2 } from "lucide-react";

export const dynamic = "force-dynamic";

const SERVICE_DETAIL_FALLBACK_METADATA: Metadata = {
  title: "技能服务详情 - 校园集市",
  description: "查看校园集市同校技能服务的内容、价格与预约方式。",
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
    const { service } = await getServiceDetail(id);
    // Phase 7C FR-03：metadata 属 PUBLIC surface（owner exception 不适用）
    if (await hasActiveModerationForPublicSurface("SERVICE", service.id)) {
      return SERVICE_DETAIL_FALLBACK_METADATA;
    }
    // Phase 8F（§19）：metadata 是 PUBLIC surface——只有 public exposed
    // （ACTIVE）才生成 listing title/description；wind-down 返回 generic fallback
    if (service.status !== "ACTIVE") {
      return SERVICE_DETAIL_FALLBACK_METADATA;
    }
    const title = `${service.title} - 校园集市`;
    const description = truncateForMetadata(
      service.description || `查看校园集市技能服务「${service.title}」的服务内容与价格。`,
    );

    return { title, description, openGraph: { title, description } };
  } catch (error) {
    // notFound() 等 Next.js 控制流错误必须原样抛出（此前裸 catch 会把
    // 缺失 listing 的 metadata 吞成 200 语义兜底）
    if (
      error !== null &&
      typeof error === "object" &&
      "digest" in error &&
      typeof error.digest === "string" &&
      error.digest.startsWith("NEXT_")
    ) {
      throw error;
    }
    return SERVICE_DETAIL_FALLBACK_METADATA;
  }
}

export default async function ServiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Phase 6C-2 raw-auth hardening：owner 个性化按 ACTIVE 账号解析；
  // SUSPENDED 会话 → null → 匿名语义（isOwner 抑制），公开详情照常
  const viewerId = await getActiveViewerId();
  const { service, relatedServices } = await getServiceDetail(id);
  // Phase 8F（§14-§17）Detail Access Policy：PUBLIC 仅 ACTIVE；provider 查看自己
  // wind-down listing；既有 SERVICE Order 买卖双方保留履约上下文
  const isParticipant = await isListingTransactionParticipant("SERVICE", service.id, viewerId);
  const lifecycleRole = resolveListingLifecycleAccess({
    status: service.status,
    viewerId,
    ownerId: service.providerId,
    isParticipant,
  });
  if (lifecycleRole === null) {
    notFound();
  }
  // Phase 7C PUBLIC detail 治理特例（同 product 页）；参与方特权不绕过治理保密
  const moderationGate = await resolvePublicDetailModerationGate({
    viewerId,
    ownerId: service.providerId,
    targetType: "SERVICE",
    listingId: service.id,
  });
  if (moderationGate === "HIDDEN") {
    notFound();
  }
  const isOwner = viewerId === service.providerId;
  const windDownMessage =
    lifecycleRole !== "PUBLIC"
      ? SERVICE_WIND_DOWN_MESSAGES[service.status as "ACTIVE" | "PAUSED" | "OFFLINE"]
      : "";

  const images = service.coverImageUrl ? [service.coverImageUrl] : [];

  return (
    <PageContainer maxWidth="standard">
      {moderationGate === "OWNER_VIEW" && <ModerationHiddenBanner />}
      {windDownMessage && <WindDownBanner message={windDownMessage} />}
      {/* 1. 面包屑导航 */}
      <Breadcrumbs
        items={[
          { label: "技能服务广场", href: "/services" },
          { label: service.category.name, href: `/services?category=${service.category.slug}` },
          { label: service.title },
        ]}
      />

      {/* 2. 主从双栏：55% 左侧图文描述 + 45% Sticky 右侧控制台 */}
      <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
        {/* 左侧：媒体展示 + 详细说明 + 用户须知 + 为你推荐 */}
        <div className="space-y-8">
          {/* 画廊展示 */}
          <ImageGallery images={images} title={service.title} />

          {/* 详细描述 */}
          <section className="space-y-4 rounded-3xl border border-slate-200/80 bg-white p-6 sm:p-8 shadow-xs dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2 border-b border-slate-100 pb-3 dark:border-slate-800">
              <span className="inline-block size-2 rounded-full bg-indigo-600" />
              服务详细介绍
            </h2>
            <div className="prose prose-slate max-w-none text-sm leading-relaxed whitespace-pre-wrap text-slate-700 dark:text-slate-300">
              {service.description}
            </div>
          </section>

          {/* 服务须知与履约提示 */}
          <div className="rounded-3xl border border-slate-200/80 bg-slate-50/70 p-6 space-y-3 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-400">
            <h3 className="font-bold text-slate-900 flex items-center gap-1.5 dark:text-slate-100 text-sm">
              <CheckCircle2 className="size-4 text-emerald-500" />
              预约与履约须知
            </h3>
            <ul className="space-y-1.5 list-disc pl-4 leading-relaxed">
              <li>提交预约后，请通过站内私信与服务者确认具体履约时间与地点细节。</li>
              <li>服务价格为参考价格，具体复杂需求或追加项目可当面沟通。</li>
              <li>服务完成后请在订单中心点击“确认完成”并给与客观评价。</li>
            </ul>
          </div>

          {/* 相似技能推荐 */}
          {relatedServices.length > 0 && (
            <section className="space-y-4 pt-4">
              <div className="flex items-end justify-between border-b border-slate-100 pb-3 dark:border-slate-800">
                <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-slate-100">
                  为你推荐同校技能服务
                </h2>
              </div>

              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {relatedServices.map((item) => (
                  <ServiceCard
                    key={item.id}
                    id={item.id}
                    title={item.title}
                    description={item.description}
                    price={`¥${item.price.toString()}`}
                    pricingUnit={item.pricingUnit}
                    status={item.status as "ACTIVE" | "PAUSED" | "OFFLINE"}
                    provider={item.provider.name}
                    locationText={item.locationText}
                    categoryName={item.category.name}
                    coverImageUrl={item.coverImageUrl}
                    completedOrderCount={item.completedOrderCount}
                    reason={item.reason}
                  />
                ))}
              </div>
            </section>
          )}
        </div>

        {/* 右侧：Sticky 交互控制台 */}
        <ServiceDetailConsole
          service={{
            ...service,
            price: service.price.toString(),
          }}
          isOwner={isOwner}
          isLoggedIn={!!viewerId}
        />
      </div>
    </PageContainer>
  );
}
