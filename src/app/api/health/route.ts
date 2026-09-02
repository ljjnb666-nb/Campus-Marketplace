import { NextResponse } from "next/server";
import { withHttpMetrics } from "@/lib/http-metrics";
import { withApiRequestContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

/**
 * Liveness 探针（BLOCKER 2 修正后的真语义）：应用进程是否活着。
 *
 * - 不访问 PostgreSQL / Redis / S3，无副作用，快速返回；
 *   app handler 能执行即 200——依赖故障由 /api/ready 负责（DB/Storage
 *   故障 → 503 not_ready），DB outage 不再导致 app 容器被误判 unhealthy；
 * - 保留 release identity（deploy.sh、Dockerfile HEALTHCHECK、Playwright
 *   依赖本响应契约，形状不得变更）；
 * - 不泄漏 secrets / 内部细节。
 */
export const GET = withHttpMetrics("health", (request: Request) =>
  withApiRequestContext(request.headers, async () => {
    // Release identity：部署报告须能回答"当前运行的是哪一个 SHA"。
    // 由生产镜像以 ENV RELEASE_SHA 注入（见 Dockerfile 的 build arg GIT_SHA）
    return NextResponse.json({
      status: "ok",
      release: process.env.RELEASE_SHA ?? "dev",
      timestamp: new Date().toISOString(),
    });
  }),
);
