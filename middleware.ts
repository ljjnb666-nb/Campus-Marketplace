import { NextResponse, type NextRequest } from "next/server";

/**
 * 请求计时中间件：
 * - 在请求头注入 x-request-start，供后续日志/响应头计算端到端耗时；
 * - 输出 Server-Timing 头描述 middleware 自身开销，便于浏览器 DevTools 观测。
 */
export function middleware(request: NextRequest) {
  const start = performance.now();

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
