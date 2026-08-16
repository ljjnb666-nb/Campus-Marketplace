import { ListingGrid } from "@/components/site/listing-grid";
import { getHomepageProducts } from "@/repositories/home-repository";

// 二手商品三个板块共用一组商品查询,放在同一个 Suspense 边界内一起流入。
export async function HomeProductListings({ campusId }: { campusId?: string }) {
  const { latestProducts, trendingProducts, budgetProducts } = await getHomepageProducts({
    campusId,
  });

  return (
    <>
      <ListingGrid
        title="最新二手商品"
        description="最近发布的校园闲置，适合快速浏览当前上新内容。"
        items={latestProducts}
        moreHref="/products?sort=latest"
      />
      <ListingGrid
        title="热门商品推荐"
        description="综合收藏、浏览和新鲜度排序，更接近同学们真正会点开的内容。"
        items={trendingProducts}
        moreHref="/products?sort=popular"
      />
      <ListingGrid
        title="低价好物"
        description="优先展示价格更友好的在售商品，适合先淘一批高性价比闲置。"
        items={budgetProducts}
        moreHref="/products?sort=price_asc"
      />
    </>
  );
}
