import { listingModerationPublicFilter } from "@/lib/moderation/listing-moderation-query";
import { prisma } from "@/lib/prisma";

// 每类详情页最多收录 500 条:站点地图单文件体积有限,列表按 updatedAt 倒序
// 只保留最新、最可能被搜索引擎收录的页面,同时避免全表扫描拖垮数据库。
const SITEMAP_TAKE = 500;

export type SitemapListingEntry = {
  id: string;
  updatedAt: Date;
};

// 供站点地图使用的极简查询:只取 id + updatedAt,只收录未删除且对外可见的条目。
// Phase 7C：PUBLIC 面——活跃治理 moderation 的条目不收录。
export async function getSitemapListings() {
  const [products, errands, services, rentals] = await Promise.all([
    prisma.product.findMany({
      where: { deletedAt: null, status: "ACTIVE", ...listingModerationPublicFilter() },
      orderBy: { updatedAt: "desc" },
      select: { id: true, updatedAt: true },
      take: SITEMAP_TAKE,
    }),
    prisma.errandTask.findMany({
      where: { deletedAt: null, status: "OPEN", ...listingModerationPublicFilter() },
      orderBy: { updatedAt: "desc" },
      select: { id: true, updatedAt: true },
      take: SITEMAP_TAKE,
    }),
    prisma.serviceListing.findMany({
      where: { deletedAt: null, status: "ACTIVE", ...listingModerationPublicFilter() },
      orderBy: { updatedAt: "desc" },
      select: { id: true, updatedAt: true },
      take: SITEMAP_TAKE,
    }),
    prisma.rentalListing.findMany({
      where: { deletedAt: null, status: "AVAILABLE", ...listingModerationPublicFilter() },
      orderBy: { updatedAt: "desc" },
      select: { id: true, updatedAt: true },
      take: SITEMAP_TAKE,
    }),
  ]);

  return { products, errands, services, rentals };
}
