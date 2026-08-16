import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  // NEXTAUTH_URL 与站点对外地址一致;缺省时退回本地开发地址。
  const baseUrl = (process.env.NEXTAUTH_URL ?? "http://localhost:3000").replace(
    /\/$/,
    "",
  );

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // 管理后台、个人中心、私信、通知与 API 不应进入搜索引擎索引。
        disallow: ["/admin", "/my", "/messages", "/api", "/notifications"],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
