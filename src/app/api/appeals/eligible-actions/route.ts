import { NextRequest, NextResponse } from "next/server";

import { listEligibleAppealActions } from "@/lib/appeals/appeal-query";
import { isRateLimited } from "@/lib/rate-limit";
import { handleError } from "@/lib/error-handler";
import { withHttpMetrics } from "@/lib/http-metrics";
import {
  APPEAL_ELIGIBLE_SESSION_HTTP_STATUS,
  getAppealEligibleSession,
} from "@/lib/server-auth";
import {
  APPEAL_DEFAULT_PAGE_SIZE,
  appealPageLimitSchema,
  decodeAppealCursor,
  type AppealCursor,
} from "@/validators/appeal";

const LIST_RATE_LIMIT = 30;
const LIST_RATE_LIMIT_WINDOW_MS = 60 * 1000;

function privateCache(): Record<string, string> {
  return { "Cache-Control": "private, no-store" };
}

/**
 * GET /api/appeals/eligible-actions —— appellant 可申诉处罚 discovery
 * （唯一 discovery surface：处罚通知不含 enforcementActionId）。
 *
 * - 资格 = targetId == session user AND type IN {3 punitive}；已有 Appeal
 *   （含 WITHDRAWN/terminal）保持 discoverable；无 stale/reversed 过滤。
 * - bounded keyset 分页：?limit∈[1,50]（缺席 25，非法 400）；
 *   ?cursor=base64url(JSON)——malformed → 400；结构合法的自构造 cursor 只是
 *   UNTRUSTED 分页位置，永远改变不了 targetId = session user 的 ownership
 *   过滤（不是签名 token，也不需要是）。
 * - 所有分页请求计入同一 appeal:list:${userId} 限流桶（换 cursor 不可绕过）。
 */
async function getHandler(request: NextRequest) {
  try {
    const verified = await getAppealEligibleSession();

    if (!verified.ok) {
      return NextResponse.json(
        { error: "未登录或账号不可用", code: verified.reason },
        { status: APPEAL_ELIGIBLE_SESSION_HTTP_STATUS[verified.reason], headers: privateCache() },
      );
    }

    const userId = verified.user.id;

    const { limited } = await isRateLimited({
      key: `appeal:list:${userId}`,
      limit: LIST_RATE_LIMIT,
      windowMs: LIST_RATE_LIMIT_WINDOW_MS,
    });

    if (limited) {
      return NextResponse.json(
        { error: "操作过于频繁，请稍后再试" },
        { status: 429, headers: privateCache() },
      );
    }

    const url = new URL(request.url);

    const limitParam = url.searchParams.get("limit");
    let limit = APPEAL_DEFAULT_PAGE_SIZE;
    if (limitParam !== null) {
      const parsedLimit = appealPageLimitSchema.safeParse(limitParam);
      if (!parsedLimit.success) {
        return NextResponse.json(
          { error: parsedLimit.error.issues[0]?.message ?? "limit 无效" },
          { status: 400, headers: privateCache() },
        );
      }
      limit = parsedLimit.data;
    }

    const cursorParam = url.searchParams.get("cursor");
    let cursor: AppealCursor | undefined;
    if (cursorParam) {
      const decoded = decodeAppealCursor(cursorParam);
      if (!decoded) {
        return NextResponse.json(
          { error: "cursor 无效" },
          { status: 400, headers: privateCache() },
        );
      }
      cursor = decoded;
    }

    const page = await listEligibleAppealActions({
      targetUserId: userId,
      cursor,
      limit,
    });

    return NextResponse.json(
      { items: page.items, nextCursor: page.nextCursor },
      { headers: privateCache() },
    );
  } catch (error) {
    const handled = handleError(error, "GET /api/appeals/eligible-actions");
    return NextResponse.json(
      { error: handled.message },
      { status: handled.statusCode, headers: privateCache() },
    );
  }
}

export const GET = withHttpMetrics("appeals/eligible-actions", getHandler);
