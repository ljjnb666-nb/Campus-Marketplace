/**
 * 服务端 request 上下文（TASK 1）：以 AsyncLocalStorage 承载 requestId，
 * 让同一请求链路内的所有结构化日志自动携带同一个 requestId，
 * 调用方无需手工透传。
 *
 * Node runtime 专用（route handler / server action / script）；
 * Edge middleware 请使用纯函数模块 request-id.ts。
 *
 * 覆盖策略：observability 路由（/api/health、/api/ready、metrics）已接入；
 * 其余路由可渐进采用 withApiRequestContext 包裹（docs/OBSERVABILITY.md）。
 * HTTP 层的 X-Request-ID 响应头由 middleware 全量覆盖，与日志侧不冲突。
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { resolveRequestId } from "@/lib/request-id";

const requestStorage = new AsyncLocalStorage<{ requestId: string }>();

/**
 * 在固定 requestId 的上下文中执行回调。
 * headers 传入当前请求头（middleware 已校验/回填 x-request-id），
 * 缺失时按同一规则兜底生成。
 */
export function withApiRequestContext<T>(headers: Headers, fn: () => Promise<T>): Promise<T> {
  const requestId = resolveRequestId(headers.get("x-request-id"));
  return requestStorage.run({ requestId }, fn);
}

/** 仅用于脚本/测试等无 HTTP 头场景。 */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestStorage.run({ requestId }, fn);
}

/** 当前请求的 requestId；不在任何请求上下文中时返回 undefined。 */
export function getRequestId(): string | undefined {
  return requestStorage.getStore()?.requestId;
}
