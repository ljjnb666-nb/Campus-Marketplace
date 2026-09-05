import type { MetadataRoute } from "next";
import { getSitemapListings } from "@/repositories/sitemap-repository";

// 详情页数据来自数据库,放到请求期执行,避免构建期依赖数据库连接。
export const dynamic = "force-dynamic";

function getBaseUrl() {
  // NEXTAUTH_URL 与站点对外地址一致;缺省时退回本地开发地址。
  return (process.env.NEXTAUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = getBaseUrl();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${baseUrl}/`, changeFrequency: "daily", priority: 1 },
    { url: `${baseUrl}/products`, changeFrequency: "daily", priority: 0.8 },
    { url: `${baseUrl}/errands`, changeFrequency: "daily", priority: 0.8 },
    { url: `${baseUrl}/services`, changeFrequency: "daily", priority: 0.8 },
    { url: `${baseUrl}/rentals`, changeFrequency: "daily", priority: 0.8 },
    { url: `${baseUrl}/search`, changeFrequency: "weekly", priority: 0.5 },
    { url: `${baseUrl}/login`, changeFrequency: "monthly", priority: 0.3 },
    { url: `${baseUrl}/register`, changeFrequency: "monthly", priority: 0.3 },
    { url: `${baseUrl}/legal/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${baseUrl}/legal/rules`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${baseUrl}/legal/terms`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${baseUrl}/legal/prohibited`, changeFrequency: "yearly", priority: 0.3 },
  ];

  const { products, errands, services, rentals } = await getSitemapListings();

  const detailRoutes: MetadataRoute.Sitemap = [
    ...products.map((item) => ({
      url: `${baseUrl}/products/${item.id}`,
      lastModified: item.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
    ...errands.map((item) => ({
      url: `${baseUrl}/errands/${item.id}`,
      lastModified: item.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
    ...services.map((item) => ({
      url: `${baseUrl}/services/${item.id}`,
      lastModified: item.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
    ...rentals.map((item) => ({
      url: `${baseUrl}/rentals/${item.id}`,
      lastModified: item.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
  ];

  return [...staticRoutes, ...detailRoutes];
}
