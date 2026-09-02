import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withApiRequestContext } from "@/lib/request-context";
import { pingDatabase } from "@/repositories/health-repository";

export const dynamic = "force-dynamic";

/**
 * Liveness 探针（TASK 4）：应用进程是否活着。
 * 必须快、无副作用：仅一次轻量 SELECT 1（部署验证依赖其反映 DB 可达，
 * 该查询不涉及业务表/复杂 join），保留 release identity（deploy.sh、
 * Dockerfile HEALTHCHECK、Playwright 均依赖本响应契约，不得变更形状）。
 * 深度依赖探测（Redis/Storage）在 /api/ready。
 */
export async function GET(request: Request) {
  return withApiRequestContext(request.headers, async () => {
    try {
      await pingDatabase();
      // Release identity：部署报告须能回答"当前运行的是哪一个 SHA"。
      // 由生产镜像以 ENV RELEASE_SHA 注入（见 Dockerfile 的 build arg GIT_SHA）
      return NextResponse.json({
        status: "ok",
        release: process.env.RELEASE_SHA ?? "dev",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("健康检查：数据库不可达", "health", { error });
      return NextResponse.json(
        { status: "error", message: "database unreachable" },
        { status: 503 },
      );
    }
  });
}
