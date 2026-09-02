import { NextResponse } from "next/server";

import { logger } from "@/lib/logger";
import { renderPrometheus } from "@/lib/metrics";
import { withApiRequestContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

/**
 * Metrics 端点（TASK 6）：Prometheus 文本格式。
 *
 * 访问控制（docs/OBSERVABILITY.md 契约）：
 * - 仅当配置 METRICS_BEARER_TOKEN 时开放；未配置 → 404（端点整体关闭，
 *   不存在"裸奔"默认暴露面）；
 * - 独立专用 token，禁止复用 NEXTAUTH_SECRET；
 * - 生产拓扑下建议仅内网/采集器访问，公网入口不路由该路径。
 * - 输出只含低基数 label（route family/method/状态类/依赖名/错误类别），
 *   绝无 userId/email/业务 ID。
 */
export async function GET(request: Request) {
  return withApiRequestContext(request.headers, async () => {
    const token = process.env.METRICS_BEARER_TOKEN;

    if (!token) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const authorization = request.headers.get("authorization") ?? "";
    const presented = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    // 常数时间比较，避免 timing 侧信道逐字节猜测 token
    if (presented.length === 0 || !timingSafeEqual(presented, token)) {
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
  });
}

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
