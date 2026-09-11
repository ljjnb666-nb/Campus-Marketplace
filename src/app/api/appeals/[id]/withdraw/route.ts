import { NextRequest, NextResponse } from "next/server";

import { withdrawAppeal } from "@/lib/appeals/appeal-service";
import { loadAppellantAppealSelfDto } from "@/lib/appeals/appeal-query";
import { isRateLimited } from "@/lib/rate-limit";
import { handleError } from "@/lib/error-handler";
import { withHttpMetrics } from "@/lib/http-metrics";
import {
  APPEAL_ELIGIBLE_SESSION_HTTP_STATUS,
  getAppealEligibleSession,
} from "@/lib/server-auth";
import { APPEAL_SUBMIT_BODY_MAX_BYTES } from "@/validators/appeal";

const WITHDRAW_RATE_LIMIT = 10;
const WITHDRAW_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

function privateCache(): Record<string, string> {
  return { "Cache-Control": "private, no-store" };
}

/**
 * POST /api/appeals/[id]/withdraw —— appellant 撤回自己的 SUBMITTED 申诉。
 *
 * 不需要业务 body；ownership 由 domain 以 EnforcementAction.targetId 判定
 * （callerUserId 只来自会话，路由不接受任何身份字段）。与 submit 同款
 * application/json-only（跨站 form 型内容类型 → 415，CSRF 第三层）。
 * IN_REVIEW / terminal 状态撤回 → 409 APPEAL_INVALID_TRANSITION；
 * 他人 appealId → 与不存在同款 404 文案（防枚举）。
 */
async function postHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const verified = await getAppealEligibleSession();

    if (!verified.ok) {
      return NextResponse.json(
        { error: "未登录或账号不可用", code: verified.reason },
        { status: APPEAL_ELIGIBLE_SESSION_HTTP_STATUS[verified.reason], headers: privateCache() },
      );
    }

    const userId = verified.user.id;

    const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      return NextResponse.json(
        { error: "请求内容类型必须是 application/json" },
        { status: 415, headers: privateCache() },
      );
    }

    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > APPEAL_SUBMIT_BODY_MAX_BYTES) {
      return NextResponse.json(
        { error: "请求体过大" },
        { status: 413, headers: privateCache() },
      );
    }

    const { limited } = await isRateLimited({
      key: `appeal:withdraw:${userId}`,
      limit: WITHDRAW_RATE_LIMIT,
      windowMs: WITHDRAW_RATE_LIMIT_WINDOW_MS,
    });

    if (limited) {
      return NextResponse.json(
        { error: "操作过于频繁，请稍后再试" },
        { status: 429, headers: privateCache() },
      );
    }

    const { id } = await params;

    const { appeal } = await withdrawAppeal({
      callerUserId: userId,
      appealId: id,
    });

    const selfDto = await loadAppellantAppealSelfDto(appeal.id);

    return NextResponse.json({ appeal: selfDto }, { headers: privateCache() });
  } catch (error) {
    const handled = handleError(error, "POST /api/appeals/[id]/withdraw");
    return NextResponse.json(
      { error: handled.message },
      { status: handled.statusCode, headers: privateCache() },
    );
  }
}

export const POST = withHttpMetrics("appeals/withdraw", postHandler);
