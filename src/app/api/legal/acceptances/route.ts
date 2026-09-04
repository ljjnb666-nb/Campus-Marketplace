import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withHttpMetrics } from "@/lib/http-metrics";
import {
  VERIFIED_SESSION_HTTP_STATUS,
  getVerifiedSession,
} from "@/lib/server-auth";
import { isGovernanceError } from "@/lib/governance/domain-errors";
import {
  getUserAcceptanceStatus,
  listUserAcceptances,
  recordAcceptances,
} from "@/lib/legal/policy-service";
import { isRateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const acceptSchema = z.object({
  documentIds: z.array(z.string().min(1)).min(1).max(16),
});

function privateCache(): Record<string, string> {
  return { "Cache-Control": "private, no-store" };
}

/** GET /api/legal/acceptances —— 本人同意历史。 */
async function listHandler() {
  const verified = await getVerifiedSession({ requireConsent: false });

  if (!verified.ok) {
    return NextResponse.json(
      { error: "未登录或账号不可用", code: verified.reason },
      { status: VERIFIED_SESSION_HTTP_STATUS[verified.reason], headers: privateCache() },
    );
  }

  const status = await getUserAcceptanceStatus(verified.user.id);
  const acceptances = await listUserAcceptances(verified.user.id);

  return NextResponse.json(
    {
      compliant: status.compliant,
      required: status.required.map((document) => ({
        id: document.id,
        type: document.type,
        version: document.version,
        title: document.title,
        contentHash: document.contentHash,
      })),
      pending: status.pending.map((document) => ({
        id: document.id,
        type: document.type,
        version: document.version,
        state: document.state,
      })),
      acceptances: acceptances.map((acceptance) => ({
        documentType: acceptance.documentType,
        documentVersion: acceptance.documentVersion,
        documentHash: acceptance.documentHash,
        source: acceptance.source,
        acceptedAt: acceptance.acceptedAt.toISOString(),
      })),
    },
    { headers: privateCache() },
  );
}

/**
 * POST /api/legal/acceptances —— 接受当前 required 政策集合。
 *
 * fail-closed：提交集合必须与服务器解析的当前 required 集合完全一致；
 * 版本变化一律拒绝（LEGAL_DOCUMENT_VERSION_CHANGED）。
 * consent gate 自身入口不要求已同意（否则无法解除）。
 */
async function postHandler(request: NextRequest) {
  const verified = await getVerifiedSession({ requireConsent: false });

  if (!verified.ok) {
    return NextResponse.json(
      { error: "未登录或账号不可用", code: verified.reason },
      { status: VERIFIED_SESSION_HTTP_STATUS[verified.reason], headers: privateCache() },
    );
  }

  const { limited } = await isRateLimited({
    key: `legal-accept:${verified.user.id}`,
    limit: 10,
    windowMs: 10 * 60 * 1000,
  });

  if (limited) {
    return NextResponse.json(
      { error: "操作过于频繁，请稍后再试", code: "RATE_LIMITED" },
      { status: 429, headers: privateCache() },
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

  const parsed = acceptSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数无效", code: "VALIDATION" },
      { status: 400, headers: privateCache() },
    );
  }

  try {
    const result = await recordAcceptances({
      userId: verified.user.id,
      documentIds: parsed.data.documentIds,
      source: "RECONSENT",
    });

    const status = await getUserAcceptanceStatus(verified.user.id);

    return NextResponse.json(
      { created: result.created, skipped: result.skipped, compliant: status.compliant },
      { headers: privateCache() },
    );
  } catch (error) {
    if (isGovernanceError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: privateCache() },
      );
    }

    return NextResponse.json(
      { error: "提交失败，请稍后重试", code: "INTERNAL" },
      { status: 500, headers: privateCache() },
    );
  }
}

export const GET = withHttpMetrics("legal/acceptances", listHandler);
export const POST = withHttpMetrics("legal/acceptances", postHandler);
