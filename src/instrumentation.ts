/**
 * Next.js instrumentation（Phase 4）：server 启动期一次性初始化。
 *
 * 只做启动标识日志（service/environment/release），不引入 OpenTelemetry
 * 等重依赖——可观测性契约见 docs/OBSERVABILITY.md。服务端请求级的
 * request ID 关联由 middleware + request-context 承担。
 */
export function register() {
  // logger 输出标准字段（service/environment/release），此处 message 只需
  // 说明启动事实；避免在冷启动路径做任何可失败的操作。
  import("@/lib/logger").then(({ logger }) => {
    logger.info("server 启动", "instrumentation", {
      event: "server_start",
      runtime: typeof process !== "undefined" ? process.env.NEXT_RUNTIME ?? "node" : "unknown",
    });
  });
}
