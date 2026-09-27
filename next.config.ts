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
  // LR-001：proxy（src/proxy.ts，matcher 覆盖全部路由）会缓冲请求 body，
  // 默认 10MB —— 超过即静默截断流，业务 10MiB 上传在 request.formData()
  // 阶段必然解析失败（曾被映射为 500）。设为 13MB（bytes 语义 = 13 ×
  // 1024²）以覆盖生产 Caddy request_body max_size 12MB 的请求信封 + 余量；
  // 公网流量的字节级上限仍由 Caddy 执行（deploy/Caddyfile），业务类目
  // 上限（5MiB / 10MiB）不变，见 upload route 的两层 limit contract。
  experimental: {
    proxyClientMaxBodySize: "13mb",
  },
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
