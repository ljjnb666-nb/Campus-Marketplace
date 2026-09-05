import { NextRequest, NextResponse } from "next/server";
import { withHttpMetrics } from "@/lib/http-metrics";
import {
  LEGAL_DOCUMENT_SLUGS,
  getLegalDocumentVersions,
  getLegalDocumentView,
  isLegalDocumentSlug,
} from "@/repositories/legal-repository";

export const dynamic = "force-dynamic";

/**
 * GET /api/legal/documents?type=terms[&version=2]
 *
 * 公开接口（未登录可访问）。返回当前生效版本或指定历史版本。
 * 缓存策略：文档内容一经发布不可变，短窗口共享缓存安全；
 * "当前版本指针"最多滞后 max-age 窗口（新版本发布后 ≤60s 收敛）。
 */
async function getHandler(request: NextRequest) {
  const typeParam = request.nextUrl.searchParams.get("type") ?? "";
  const versionParam = request.nextUrl.searchParams.get("version");

  if (!isLegalDocumentSlug(typeParam)) {
    return NextResponse.json(
      {
        error: `type 必须是：${Object.values(LEGAL_DOCUMENT_SLUGS).join(" / ")}`,
        code: "LEGAL_DOCUMENT_NOT_FOUND",
      },
      { status: 400 },
    );
  }

  let version: number | undefined;

  if (versionParam !== null) {
    version = Number.parseInt(versionParam, 10);

    if (Number.isNaN(version)) {
      return NextResponse.json(
        { error: "version 必须是整数", code: "VALIDATION" },
        { status: 400 },
      );
    }
  }

  const document = await getLegalDocumentView(typeParam, version);

  if (!document) {
    return NextResponse.json(
      { error: "文档不存在或尚未发布", code: "LEGAL_DOCUMENT_NOT_FOUND" },
      { status: 404 },
    );
  }

  const versions = await getLegalDocumentVersions(typeParam);

  return NextResponse.json(
    {
      document: {
        type: document.type,
        version: document.version,
        title: document.title,
        contentHash: document.contentHash,
        effectiveAt: document.effectiveAt.toISOString(),
        status: document.status,
        content: document.content,
      },
      versions: versions.map((entry) => ({
        version: entry.version,
        status: entry.status,
        publishedAt: entry.publishedAt?.toISOString() ?? null,
        effectiveAt: entry.effectiveAt.toISOString(),
      })),
    },
    {
      headers: {
        // 发布不可变 + 短窗口指针收敛；绝无用户数据，可共享缓存
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
      },
    },
  );
}

export const GET = withHttpMetrics("legal/documents", getHandler);
