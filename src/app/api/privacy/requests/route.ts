import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withHttpMetrics } from "@/lib/http-metrics";
import {
  VERIFIED_SESSION_HTTP_STATUS,
  getVerifiedSession,
} from "@/lib/server-auth";
import { isGovernanceError } from "@/lib/governance/domain-errors";
import {
  createAccountDeletionRequest,
  createDataExportRequest,
  listUserPrivacyRequests,
} from "@/lib/privacy/privacy-request-service";
import { actionErrorMessage } from "@/lib/error-handler";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  type: z.enum(["DATA_EXPORT", "ACCOUNT_DELETION"]),
  // 注销必须携带显式确认短语；导出不需要
  confirmation: z.string().optional(),
});

const DELETION_CONFIRMATION_PHRASE = "注销账号";

function privateCache(headers: Record<string, string> = {}): Record<string, string> {
  return { "Cache-Control": "private, no-store", ...headers };
}

/** GET /api/privacy/requests —— 本人请求历史（仅本人，服务端解析身份）。 */
async function listHandler() {
  const verified = await getVerifiedSession({ requireConsent: false });

  if (!verified.ok) {
    return NextResponse.json(
      { error: "未登录或账号不可用", code: verified.reason },
      { status: VERIFIED_SESSION_HTTP_STATUS[verified.reason], headers: privateCache() },
    );
  }

  const requests = await listUserPrivacyRequests(verified.user.id);

  return NextResponse.json(
    {
      requests: requests.map((request) => ({
        id: request.id,
        type: request.type,
        status: request.status,
        reasonCode: request.reasonCode,
        requestedAt: request.requestedAt.toISOString(),
        completedAt: request.completedAt?.toISOString() ?? null,
      })),
    },
    { headers: privateCache() },
  );
}

/**
 * POST /api/privacy/requests —— 创建隐私请求。
 *
 * userId 一律来自认证会话，不接受请求体传入（防代他人提交）。
 * 隐私自助操作不受 consent gate 限制（退出权优先）。
 */
async function postHandler(request: NextRequest) {
  const verified = await getVerifiedSession({ requireConsent: false });

  if (!verified.ok) {
    return NextResponse.json(
      { error: "未登录或账号不可用", code: verified.reason },
      { status: VERIFIED_SESSION_HTTP_STATUS[verified.reason], headers: privateCache() },
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "请求体必须是 JSON", code: "VALIDATION" },
      { status: 400, headers: privateCache() },
    );
  }

  const parsed = createSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数无效", code: "VALIDATION" },
      { status: 400, headers: privateCache() },
    );
  }

  try {
    if (parsed.data.type === "DATA_EXPORT") {
      const created = await createDataExportRequest(verified.user.id);

      return NextResponse.json(
        {
          request: {
            id: created.id,
            type: created.type,
            status: created.status,
            requestedAt: created.requestedAt.toISOString(),
          },
        },
        { status: 201, headers: privateCache() },
      );
    }

    if (parsed.data.confirmation !== DELETION_CONFIRMATION_PHRASE) {
      return NextResponse.json(
        {
          error: `请提供确认短语“${DELETION_CONFIRMATION_PHRASE}”`,
          code: "CONFIRMATION_REQUIRED",
        },
        { status: 400, headers: privateCache() },
      );
    }

    const outcome = await createAccountDeletionRequest(verified.user.id);

    return NextResponse.json(
      {
        request: {
          id: outcome.request.id,
          type: outcome.request.type,
          status: outcome.request.status,
          reasonCode: outcome.request.reasonCode,
          requestedAt: outcome.request.requestedAt.toISOString(),
          completedAt: outcome.request.completedAt?.toISOString() ?? null,
        },
      },
      { status: outcome.status === "COMPLETED" ? 201 : 409, headers: privateCache() },
    );
  } catch (error) {
    if (isGovernanceError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: privateCache() },
      );
    }

    return NextResponse.json(
      { error: actionErrorMessage(error, "POST /api/privacy/requests") },
      { status: 500, headers: privateCache() },
    );
  }
}

export const GET = withHttpMetrics("privacy/requests", listHandler);
export const POST = withHttpMetrics("privacy/requests", postHandler);
