import { Suspense } from "react";
import { HomeErrandListings } from "@/app/home-sections/errand-listings";
import { HomeHeroSummary } from "@/app/home-sections/hero-summary";
import { HomeProductListings } from "@/app/home-sections/product-listings";
import { HomeServiceListings } from "@/app/home-sections/service-listings";
import { SafetySection } from "@/components/site/safety-section";
import { CardGridSkeleton, Skeleton } from "@/components/ui/loading-skeleton";

export const dynamic = "force-dynamic";

// hero 摘要区占位:复用现有 Skeleton 原语,高度与 hero 量级对齐,不引入新的视觉语言。
function HeroSummarySkeleton() {
  return (
    <section className="py-12 md:py-16 lg:py-20">
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
        <Skeleton className="h-[480px] w-full rounded-3xl" />
      </div>
    </section>
  );
}

// 首页流式渲染:页面外壳与静态内容立即输出,各数据区块挂在自己的 Suspense 边界后,
// 按各自查询完成的时间逐段流入,首个可见内容不再等待全部 12 个查询。
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ campus?: string }>;
}) {
  const params = await searchParams;
  const campusId = params.campus;

  return (
    <>
      <Suspense fallback={<HeroSummarySkeleton />}>
        <HomeHeroSummary campusId={campusId} />
      </Suspense>
      <Suspense fallback={<CardGridSkeleton count={6} />}>
        <HomeProductListings campusId={campusId} />
      </Suspense>
      <Suspense fallback={<CardGridSkeleton count={6} />}>
        <HomeErrandListings campusId={campusId} />
      </Suspense>
      <Suspense fallback={<CardGridSkeleton count={6} />}>
        <HomeServiceListings campusId={campusId} />
      </Suspense>
      <SafetySection />
    </>
  );
}
