import { HeroSection } from "@/components/site/hero";
import { ListingGrid } from "@/components/site/listing-grid";
import { SafetySection } from "@/components/site/safety-section";
import { auth } from "@/lib/auth";
import { getHomepageData } from "@/repositories/home-repository";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ campus?: string }>;
}) {
  const params = await searchParams;
  const session = await auth();
  const homepageData = await getHomepageData({
    userId: session?.user?.id,
    campusId: params.campus,
  });

  return (
    <>
      <HeroSection summary={homepageData.summary} />
      <ListingGrid
        title="最新二手商品"
        description="最近发布的校园闲置，适合快速浏览当前上新内容。"
        items={homepageData.latestProducts}
        moreHref="/products?sort=latest"
      />
      <ListingGrid
        title="热门商品推荐"
        description="综合收藏、浏览和新鲜度排序，更接近同学们真正会点开的内容。"
        items={homepageData.trendingProducts}
        moreHref="/products?sort=popular"
      />
      <ListingGrid
        title="低价好物"
        description="优先展示价格更友好的在售商品，适合先淘一批高性价比闲置。"
        items={homepageData.budgetProducts}
        moreHref="/products?sort=price_asc"
      />
      <ListingGrid
        title="紧急跑腿任务"
        description="优先展示截止更近、需要尽快处理的即时需求。"
        items={homepageData.urgentErrands}
        moreHref="/errands?deadline=today&sort=deadline_asc"
      />
      <ListingGrid
        title="高赏金任务"
        description="按赏金优先排序，适合有时间时快速挑选更高回报的跑腿单。"
        items={homepageData.highRewardErrands}
        moreHref="/errands?sort=reward_desc"
      />
      <ListingGrid
        title="认证服务精选"
        description="优先展示已认证服务者和已有成交记录的服务。"
        items={homepageData.verifiedServices}
        moreHref="/services?verifiedOnly=true&sort=orders_desc"
      />
      <ListingGrid
        title="高完成度服务"
        description="按已完成订单数排序，适合优先寻找更成熟、履约更稳定的服务。"
        items={homepageData.topServices}
        moreHref="/services?sort=orders_desc"
      />
      <SafetySection />
    </>
  );
}
