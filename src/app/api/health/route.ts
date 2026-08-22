import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { pingDatabase } from "@/repositories/health-repository";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await pingDatabase();
    return NextResponse.json({ status: "ok", timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error("健康检查：数据库不可达", "health", { error });
    return NextResponse.json(
      { status: "error", message: "database unreachable" },
      { status: 503 },
    );
  }
}
