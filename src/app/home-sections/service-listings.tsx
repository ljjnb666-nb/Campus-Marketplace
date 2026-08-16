import { ListingGrid } from "@/components/site/listing-grid";
import { getHomepageServices } from "@/repositories/home-repository";

// 技能服务两个板块共用一组服务查询,放在同一个 Suspense 边界内一起流入。
export async function HomeServiceListings({ campusId }: { campusId?: string }) {
  const { verifiedServices, topServices } = await getHomepageServices({
    campusId,
  });

  return (
    <>
      <ListingGrid
        title="认证服务精选"
        description="优先展示已认证服务者和已有成交记录的服务。"
        items={verifiedServices}
        moreHref="/services?verifiedOnly=true&sort=orders_desc"
      />
      <ListingGrid
        title="高完成度服务"
        description="按已完成订单数排序，适合优先寻找更成熟、履约更稳定的服务。"
        items={topServices}
        moreHref="/services?sort=orders_desc"
      />
    </>
  );
}
