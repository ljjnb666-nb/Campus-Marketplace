import { NextResponse } from "next/server";
import { withHttpMetrics } from "@/lib/http-metrics";
import {
  VERIFIED_SESSION_HTTP_STATUS,
  getVerifiedSession,
} from "@/lib/server-auth";
import { readExportArtifactForDownload } from "@/lib/privacy/data-export-download";

export const dynamic = "force-dynamic";

/**
 * GET /api/privacy/export/<requestId>/download —— 本人授权导出下载（§29-§34）。
 *
 * 安全契约：
 * - authenticated + same-user only（request.userId 必须 = 会话用户）
 * - request.status = COMPLETED + artifact READY + expiresAt > now（INV-9C03-08）
 * - anti-oracle（§32）：不存在 / 他人 request → 404 与"不存在"同形
 *   （绝不 403 暴露 request existence）；本人未生成 → 409；本人已过期 → 410
 * - 同源代理（§30）：application server 以服务端凭据读取对象后转发——
 *   浏览器绝不接触 bucket/objectKey/内部端点/presigned URL
 *   （INV-9C03-09）
 * - 响应头（§31）：attachment + nosniff + private, no-store；filename
 *   只含 requestId 机器字符，绝不包含 email/name/studentId
 */
async function getHandler(
  _request: Request,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await params;

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

  const result = await readExportArtifactForDownload(requestId, verified.user.id);

  if (!result.ok) {
    return NextResponse.json(
      { error: result.message, code: result.code },
      { status: result.status, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  return new NextResponse(new Uint8Array(result.body), {
    status: 200,
    headers: {
      "Content-Type": result.contentType,
      "Content-Length": String(result.sizeBytes),
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export const GET = withHttpMetrics("privacy/export/download", getHandler);
