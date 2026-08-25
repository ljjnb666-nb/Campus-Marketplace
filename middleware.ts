import { NextResponse, type NextRequest } from "next/server";

/**
 * 请求计时中间件：
 * - 在请求头注入 x-request-start，供后续日志/响应头计算端到端耗时；
 * - 输出 Server-Timing 头描述 middleware 自身开销，便于浏览器 DevTools 观测。
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

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-start", `${Math.round(start)}`);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  const middlewareDur = Math.round((performance.now() - start) * 100) / 100;
  response.headers.set("Server-Timing", `middleware;dur=${middlewareDur}`);

  return response;
}

export const config = {
  // 跳过静态资源与 Next 内部路径，只计时业务页面与 API
  matcher: ["/((?!_next/static|_next/image|favicon.ico|uploads).*)"],
};
