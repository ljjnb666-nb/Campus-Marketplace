import { NextResponse } from "next/server";

import { withHttpMetrics } from "@/lib/http-metrics";
import { runReadinessChecks } from "@/lib/dependency-health";
import { logger } from "@/lib/logger";
import { withApiRequestContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

/**
 * Readiness 探针（TASK 4）：当前实例是否具备处理正常业务流量的必要条件。
 * 语义与 /api/health（liveness，进程存活）严格区分，见 docs/OBSERVABILITY.md。
 *
 * 公开响应只包含高层状态：绝不返回 connection string、异常详情、
 * stack、endpoint 凭据。失败细节只进服务端结构化日志。
 */
export const GET = withHttpMetrics("ready", (request: Request) =>
  withApiRequestContext(request.headers, async () => {
    const report = await runReadinessChecks();
    const httpStatus = report.status === "not_ready" ? 503 : 200;

    if (report.status !== "ready") {
      logger.info("readiness 非 ready", "ready", {
        event: "readiness_reported",
        status: report.status,
        dependencies: report.dependencies,
      });
    }

    return NextResponse.json(
      {
        status: report.status,
        release: process.env.RELEASE_SHA ?? "dev",
        dependencies: report.dependencies,
      },
      {
        status: httpStatus,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }),
);
