import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { pingDatabase } from "@/repositories/health-repository";

export const dynamic = "force-dynamic";

export async function GET() {
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
}
