import path from "node:path";
import type { NextConfig } from "next";

// CSP 由 middleware 按请求生成（含一次性 nonce），不再走静态头；
// 其余安全头不依赖请求上下文，保留静态配置。
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(__dirname),
  // 生产容器化部署：build 产出自包含 .next/standalone（含精简 node_modules），
  // Dockerfile 最终阶段仅复制 standalone + static。
  // 仅在容器构建时启用（Dockerfile 设 NEXT_OUTPUT_STANDALONE=1）：
  // Next 16 下 standalone 产出与 `next start` 不兼容，而本地/CI 的
  // Playwright Release Gate 依赖 `next start`，不能无条件开启。
  output: process.env.NEXT_OUTPUT_STANDALONE === "1" ? "standalone" : undefined,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
