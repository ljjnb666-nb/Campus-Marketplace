import { NextResponse } from "next/server";
import { withHttpMetrics } from "@/lib/http-metrics";
import {
  VERIFIED_SESSION_HTTP_STATUS,
  getVerifiedSession,
} from "@/lib/server-auth";
import { isGovernanceError } from "@/lib/governance/domain-errors";
import { executeSynchronousDataExport } from "@/lib/privacy/data-export";
import { actionErrorMessage } from "@/lib/error-handler";
import { logger } from "@/lib/logger";
import { isRateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const EXPORT_RATE_LIMIT = 3;
const EXPORT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * GET /api/privacy/export —— 本人数据导出（同步 JSON，唯一执行入口）。
 *
 * 安全与生命周期契约：
 * - authenticated + same-user only（不接受任何 userId 参数）
 * - 隐私自助操作：不做 consent gate（退出权优先），但账号 active 校验永远执行
 * - 一次导出 = 恰好一条 PrivacyRequest（REQUESTED→IN_PROGRESS→COMPLETED，
 *   失败则 REJECTED+reasonCode），由 executeSynchronousDataExport 保证
 * - Cache-Control: private, no-store + nosniff（绝不进入共享缓存）
 * - 载荷经显式 DTO 构建 + 禁止字段扫描 + 体积上限保护
 */
async function getHandler() {
  const verified = await getVerifiedSession({ requireConsent: false });

  if (!verified.ok) {
    return NextResponse.json(
      { error: "未登录或账号不可用", code: verified.reason },
      {
        status: VERIFIED_SESSION_HTTP_STATUS[verified.reason],
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }

  const { limited } = await isRateLimited({
    key: `privacy-export-api:${verified.user.id}`,
    limit: EXPORT_RATE_LIMIT,
    windowMs: EXPORT_RATE_LIMIT_WINDOW_MS,
  });

  if (limited) {
    return NextResponse.json(
      { error: "导出过于频繁，请稍后再试", code: "RATE_LIMITED" },
      { status: 429, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  try {
    const { payload, request } = await executeSynchronousDataExport(verified.user.id);

    return new NextResponse(JSON.stringify({ ...payload, request }, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="my-data-export-${Date.now()}.json"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (isGovernanceError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: { "Cache-Control": "private, no-store" } },
      );
    }

    logger.error("数据导出失败", "GET /api/privacy/export", { error });
    return NextResponse.json(
      { error: actionErrorMessage(error, "GET /api/privacy/export") },
      { status: 500, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}

export const GET = withHttpMetrics("privacy/export", getHandler);
