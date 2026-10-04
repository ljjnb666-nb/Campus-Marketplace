import { NextResponse } from "next/server";
import { withHttpMetrics } from "@/lib/http-metrics";
import {
  VERIFIED_SESSION_HTTP_STATUS,
  getVerifiedSession,
} from "@/lib/server-auth";
import { isRbacError } from "@/lib/rbac/errors";
import { isGovernanceError } from "@/lib/governance/domain-errors";
import { createAsyncDataExportRequest } from "@/lib/privacy/data-export-async";
import { actionErrorMessage } from "@/lib/error-handler";
import { logger } from "@/lib/logger";
import { isRateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const EXPORT_RATE_LIMIT = 3;
const EXPORT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

function privateCache(headers: Record<string, string> = {}): Record<string, string> {
  return { "Cache-Control": "private, no-store", ...headers };
}

/**
 * GET /api/privacy/export —— 已随 Phase 9C-03 异步化退役（§36）。
 *
 * 旧同步实现直接在 HTTP 请求内执行整个 export 并返回大 JSON attachment
 * （Phase 5 同步响应保护上限 8 MiB）。异步化后 HTTP 请求绝不承担数据构建
 * 与大 JSON delivery（INV-9C03-02）；GET 也绝不产生 mutation（不创建
 * AsyncJob / PrivacyRequest）。创建走 POST（202 + 后台生成），读取状态走
 * GET /api/privacy/requests，下载走
 * GET /api/privacy/export/<requestId>/download（同源代理）。
 *
 * 405 是方法级拒绝（任何认证态同形，无信息泄漏面）。
 */
async function getHandler() {
  return NextResponse.json(
    {
      error: "数据导出已改为异步生成：请使用 POST /api/privacy/export 发起申请",
      code: "USE_ASYNC_EXPORT_ENDPOINT",
    },
    { status: 405, headers: { ...privateCache(), Allow: "POST" } },
  );
}

/**
 * POST /api/privacy/export —— 发起异步数据导出（§35）。
 *
 * 安全与生命周期契约：
 * - authenticated + same-user only（不接受任何 userId 参数）
 * - 隐私自助操作：不做 consent gate（退出权优先），但账号 active 校验永远执行
 * - 成功：HTTP 202 Accepted——一次调用 = 恰好一条 PrivacyRequest（REQUESTED）
 *   + 恰好一条 durable DATA_EXPORT_GENERATE job（同事务原子落盘，§6）
 * - 并发重复（双击/多 tab/retry）由 DB partial unique index 收敛为
 *   409 DATA_EXPORT_ALREADY_ACTIVE（§7；rate limit 不是并发锁，§40）
 * - 快速返回：HTTP 请求不执行数据构建（INV-9C03-02），生成由 production
 *   async worker 完成；完成后经 /api/privacy/requests 状态面 +
 *   /api/privacy/export/<requestId>/download 本人授权下载
 */
async function postHandler() {
  const verified = await getVerifiedSession({ requireConsent: false });

  if (!verified.ok) {
    return NextResponse.json(
      { error: "未登录或账号不可用", code: verified.reason },
      {
        status: VERIFIED_SESSION_HTTP_STATUS[verified.reason],
        headers: privateCache(),
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
      { status: 429, headers: privateCache() },
    );
  }

  try {
    const { request } = await createAsyncDataExportRequest(verified.user.id);

    return NextResponse.json(
      {
        request: {
          id: request.id,
          type: request.type,
          status: request.status,
          requestedAt: request.requestedAt,
        },
      },
      { status: 202, headers: privateCache() },
    );
  } catch (error) {
    // RB-03 race-loss：entry ACTIVE 但 USER 锁内 fresh 复核前 erase/suspend
    // 先提交 → 与 entry 失效完全同形（401 ACCOUNT_INACTIVE）
    if (isRbacError(error) && error.code === "AUTH_ACCOUNT_INACTIVE") {
      return NextResponse.json(
        { error: "未登录或账号不可用", code: "ACCOUNT_INACTIVE" },
        {
          status: VERIFIED_SESSION_HTTP_STATUS.ACCOUNT_INACTIVE,
          headers: privateCache(),
        },
      );
    }

    if (isGovernanceError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: privateCache() },
      );
    }

    logger.error("异步数据导出申请失败", "POST /api/privacy/export", { error });
    return NextResponse.json(
      { error: actionErrorMessage(error, "POST /api/privacy/export") },
      { status: 500, headers: privateCache() },
    );
  }
}

export const GET = withHttpMetrics("privacy/export", getHandler);
export const POST = withHttpMetrics("privacy/export", postHandler);
