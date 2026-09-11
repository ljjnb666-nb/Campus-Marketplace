import { NextRequest, NextResponse } from "next/server";

import { isRateLimited } from "@/lib/rate-limit";
import { handleError } from "@/lib/error-handler";
import { withHttpMetrics } from "@/lib/http-metrics";
import { submitAppeal } from "@/lib/appeals/appeal-service";
import { loadAppellantAppealSelfDto } from "@/lib/appeals/appeal-query";
import {
  APPEAL_ELIGIBLE_SESSION_HTTP_STATUS,
  getAppealEligibleSession,
} from "@/lib/server-auth";
import {
  APPEAL_SUBMIT_BODY_MAX_BYTES,
  appealSubmitSchema,
} from "@/validators/appeal";

const SUBMIT_RATE_LIMIT = 5;
const SUBMIT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

function privateCache(): Record<string, string> {
  return { "Cache-Control": "private, no-store" };
}

/**
 * POST /api/appeals —— appellant 提交申诉（Phase 6C-2）。
 *
 * 身份唯一来源 = getAppealEligibleSession()（ACTIVE|SUSPENDED，DB 复查），
 * body 任何身份字段由 .strict() schema 400 拒绝；ownership 在 domain 层以
 * EnforcementAction.targetId 判定（callerUserId 只来自会话）。
 * NOT_FOUND / NOT_OWNED 经 error-handler 输出同一 404 文案（防枚举），
 * 响应体不回显 machine code。
 */
async function postHandler(request: NextRequest) {
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
      key: `appeal:submit:${userId}`,
      limit: SUBMIT_RATE_LIMIT,
      windowMs: SUBMIT_RATE_LIMIT_WINDOW_MS,
    });

    if (limited) {
      return NextResponse.json(
        { error: "操作过于频繁，请稍后再试" },
        { status: 429, headers: privateCache() },
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { error: "请求体必须是合法 JSON" },
        { status: 400, headers: privateCache() },
      );
    }

    const parsed = appealSubmitSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "提交数据无效" },
        { status: 400, headers: privateCache() },
      );
    }

    const { appeal } = await submitAppeal({
      callerUserId: userId,
      enforcementActionId: parsed.data.enforcementActionId,
      statement: parsed.data.statement,
    });

    const selfDto = await loadAppellantAppealSelfDto(appeal.id);

    return NextResponse.json(
      { appeal: selfDto },
      { status: 201, headers: privateCache() },
    );
  } catch (error) {
    const handled = handleError(error, "POST /api/appeals");
    return NextResponse.json(
      { error: handled.message },
      { status: handled.statusCode, headers: privateCache() },
    );
  }
}

export const POST = withHttpMetrics("appeals/submit", postHandler);
