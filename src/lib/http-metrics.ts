/**
 * HTTP 指标采集 wrapper（BLOCKER 3B）：把 http_requests_total /
 * http_errors_total / http_request_duration_ms 真正接入 Node runtime 的
 * API route handlers。
 *
 * 架构决定（runtime isolation）：Next 16 的 src/proxy.ts 运行在独立沙箱
 * 模块图，无法与 Node route registry 共享进程内 registry——因此计数点放在
 * Node 侧（route handler wrapper），与 /api/internal/metrics 读取端同进程，
 * 生产 standalone runtime 中真实可见（黑盒 Playwright 测试是最终事实来源）。
 *
 * 契约：
 * - routeFamily 由调用方显式提供稳定枚举值（如 "health"、"assets/:id/content"），
 *   经 metrics label 白名单校验；禁止携带具体业务 ID / query / 用户数据；
 * - duration 优先用 proxy 注入的 x-request-start（进程内 performance 时钟），
 *   时钟原点异常（<0 或 >10min）时回退本 handler 计时；
 * - status_class ∈ 2xx/3xx/4xx/5xx；status >= 400 计入 http_errors_total；
 * - handler 抛出异常按 5xx 记录后原样 rethrow（不吞错）。
 */
import { METRIC_NAMES, incrementCounter, observeHistogram } from "@/lib/metrics";

function statusClass(status: number): string {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

function labels(routeFamily: string, method: string, status_class: string) {
  return { route: routeFamily, method, status_class };
}

// 两个重载：单参 handler（Next 16 允许静态路由只声明 request）与
// 双参 handler（动态路由要求第二参数与 RouteContext 精确匹配、必传）。
// Next16 ParamCheck 不接受可选 context（`| undefined` 不满足约束），
// 因此不能用单一可选参数签名。单参重载在前：无参/单参 handler 优先走它。
export function withHttpMetrics<R extends Request>(
  routeFamily: string,
  handler: (request: R) => Promise<Response>,
): (request: R) => Promise<Response>;
export function withHttpMetrics<R extends Request, P>(
  routeFamily: string,
  handler: (request: R, context: P) => Promise<Response>,
): (request: R, context: P) => Promise<Response>;
export function withHttpMetrics(
  routeFamily: string,
  handler: (request: Request, context?: unknown) => Promise<Response>,
): (request: Request, context?: unknown) => Promise<Response> {
  return async (request, context): Promise<Response> => {
    const startedAt = performance.now();
    // proxy 注入的 x-request-start（ms）；时钟不可信或请求对象非标准
    // （测试桩）时回退本地计时
    const headerValue =
      typeof request.headers?.get === "function"
        ? request.headers.get("x-request-start")
        : null;
    const startHeader = Number(headerValue ?? "");
    const durationMs = (): number => {
      if (Number.isFinite(startHeader) && startHeader > 0) {
        const delta = startedAt - startHeader;
        if (delta >= 0 && delta < 600_000) {
          return Math.round(delta * 100) / 100;
        }
      }
      return Math.round((performance.now() - startedAt) * 100) / 100;
    };

    try {
      const response = await handler(request, context);
      const status = response.status;
      incrementCounter(METRIC_NAMES.httpRequests, labels(routeFamily, request.method, statusClass(status)));
      if (status >= 400) {
        incrementCounter(METRIC_NAMES.httpErrors, labels(routeFamily, request.method, statusClass(status)));
      }
      observeHistogram(METRIC_NAMES.httpRequestDuration, { route: routeFamily }, durationMs());
      return response;
    } catch (error) {
      incrementCounter(METRIC_NAMES.httpRequests, labels(routeFamily, request.method, "5xx"));
      incrementCounter(METRIC_NAMES.httpErrors, labels(routeFamily, request.method, "5xx"));
      observeHistogram(METRIC_NAMES.httpRequestDuration, { route: routeFamily }, durationMs());
      throw error;
    }
  };
}
