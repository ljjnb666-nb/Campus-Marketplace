import { NextResponse } from "next/server";

import { withHttpMetrics } from "@/lib/http-metrics";
import { logger } from "@/lib/logger";
import { decideMetricsToken } from "@/lib/metrics-token";
import { renderPrometheus } from "@/lib/metrics";
import { withApiRequestContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

/**
 * Metrics 端点（TASK 6 + BLOCKER 3）：Prometheus 文本格式。
 *
 * 访问控制（docs/OBSERVABILITY.md 契约，代码强制 fail-closed）：
 * - 未配置 METRICS_BEARER_TOKEN → 404（端点整体关闭，无裸奔默认暴露面）；
 * - 配置但违反安全契约（<24 字符 / 危险默认值 / 复用 NEXTAUTH_SECRET）→
 *   同样 404：端点保持关闭；配置错误记录结构化日志（只记 reason，绝不记录值）；
 * - 契约通过后需 Authorization: Bearer <token>（常数时间比较）；
 * - 生产拓扑下建议仅内网/采集器访问，公网入口不路由该路径。
 * - 输出只含低基数 label（route family/method/状态类），绝无 userId/email/业务 ID。
 */
export const GET = withHttpMetrics("internal/metrics", (request: Request) =>
  withApiRequestContext(request.headers, async () => {
    const decision = decideMetricsToken(
      process.env.METRICS_BEARER_TOKEN,
      process.env.NEXTAUTH_SECRET,
    );

    if (!decision.open) {
      // 安全契约不满足 = 端点不存在（404）。只记录 reason 枚举，不记录值。
      if (decision.reason !== "unset") {
        logger.error("metrics 端点因安全契约不满足保持关闭", "metrics", {
          event: "metrics_token_policy_violation",
          reason: decision.reason,
        });
      }
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const authorization = request.headers.get("authorization") ?? "";
    const presented = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    // 常数时间比较，避免 timing 侧信道逐字节猜测 token
    if (presented.length === 0 || !timingSafeEqual(presented, process.env.METRICS_BEARER_TOKEN!)) {
      logger.warn("metrics 访问被拒绝", "metrics", { event: "metrics_access_denied" });
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    return new NextResponse(renderPrometheus(), {
      status: 200,
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }),
);

function timingSafeEqual(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
