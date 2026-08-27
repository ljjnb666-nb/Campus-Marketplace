import { NextResponse, type NextRequest } from "next/server";

/**
 * 每请求随机 nonce，script-src 以 'nonce-xxx' + 'strict-dynamic' 取代
 * 'unsafe-inline'（现代浏览器均支持 strict-dynamic，旧 CSP1 浏览器直接
 * 拒绝执行脚本，属于可接受的 fail-closed）。
 * style-src 保留 'unsafe-inline'：React 行内样式（style 属性）受其约束，
 * 去 inline 会破坏全部内联样式。
 * isDev 显式传参便于单测覆盖两种模式，不依赖模块加载期的环境状态。
 */
export function buildContentSecurityPolicy(nonce: string, isDev: boolean) {
  const scriptSrc = isDev
    ? `'self' 'nonce-${nonce}' 'unsafe-eval'`
    : `'self' 'nonce-${nonce}' 'strict-dynamic'`;

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
}

/**
 * 中间件：
 * - 请求计时：注入 x-request-start，输出 Server-Timing 头；
 * - CSP nonce：每个文档请求生成一次性 nonce 并写入请求/响应头，
 *   Next 会为自身引导脚本自动附加该 nonce；
 * - 对 API 路由收紧 CORS：仅允许同源请求。
 */
export function middleware(request: NextRequest) {
  const start = performance.now();

  // 对 API 路由收紧 CORS：仅允许同源请求
  if (request.nextUrl.pathname.startsWith("/api/")) {
    const origin = request.headers.get("origin");
    const allowedOrigin = process.env.NEXTAUTH_URL || "http://localhost:3000";

    if (origin && origin !== allowedOrigin) {
      return new NextResponse(null, { status: 403 });
    }

    // 处理预检请求
    if (request.method === "OPTIONS") {
      const response = new NextResponse(null, { status: 204 });
      response.headers.set("Access-Control-Allow-Origin", allowedOrigin);
      response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH");
      response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      response.headers.set("Access-Control-Max-Age", "86400");
      return response;
    }
  }

  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const contentSecurityPolicy = buildContentSecurityPolicy(
    nonce,
    process.env.NODE_ENV === "development",
  );

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-start", `${Math.round(start)}`);
  requestHeaders.set("x-nonce", nonce);
  // CSP 同时写入请求头：Next 读取后为自身脚本附加 nonce
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  response.headers.set("Content-Security-Policy", contentSecurityPolicy);

  const middlewareDur = Math.round((performance.now() - start) * 100) / 100;
  response.headers.set("Server-Timing", `middleware;dur=${middlewareDur}`);

  return response;
}

export const config = {
  // 跳过静态资源与 Next 内部路径，只处理业务页面与 API
  matcher: ["/((?!_next/static|_next/image|favicon.ico|uploads).*)"],
};
