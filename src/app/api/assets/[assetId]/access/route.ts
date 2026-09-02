import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  resolvePrivateAssetAccess,
  resolvePublicAssetUrl,
} from "@/lib/asset-service";
import { withHttpMetrics } from "@/lib/http-metrics";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * 资源访问入口：
 * - PRIVATE 资源：鉴权后返回同源代理 URL（/api/assets/<id>/content）。
 *   每次对该 URL 的访问都会在 content 端点重新执行服务端鉴权；
 *   绝不返回对象存储端点的签名 URL（self-hosted 部署下浏览器无法解析
 *   内部 endpoint，且该 URL 会泄露内部基础设施信息）。
 * - PUBLIC 资源：直接返回公开 URL（无需签名）
 *
 * 状态码约定：401 未登录 / 403 无权 / 404 不存在（含已删除）/ 410 已过保留期
 */
async function getHandler(
  _request: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const startedAt = Date.now();
  const { assetId } = await params;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ message: "未登录，请先登录" }, { status: 401 });
  }
  const userId = session.user.id;
  const role = session.user.role ?? "STUDENT";

  try {
    const result = await resolvePrivateAssetAccess(assetId, { id: userId, role });

    if (!result.ok) {
      if (result.reason === "not_private") {
        const url = await resolvePublicAssetUrl(assetId);
        if (!url) {
          return NextResponse.json({ message: "资源不存在" }, { status: 404 });
        }
        return NextResponse.json({ url, access: "PUBLIC" });
      }

      logger.warn("私有资源访问被拒绝", "GET /api/assets/[assetId]/access", {
        operation: "asset-access",
        assetId,
        userId,
        reason: result.reason,
        durationMs: Date.now() - startedAt,
      });

      if (result.reason === "expired") {
        return NextResponse.json(
          { message: "资源已过保留期，无法访问" },
          { status: 410 },
        );
      }
      if (result.reason === "forbidden") {
        return NextResponse.json({ message: "无权访问该资源" }, { status: 403 });
      }
      return NextResponse.json({ message: "资源不存在" }, { status: 404 });
    }

    logger.info("私有资源同源访问许可签发", "GET /api/assets/[assetId]/access", {
      operation: "asset-access",
      assetId,
      userId,
      category: result.asset.category,
      durationMs: Date.now() - startedAt,
    });

    // 同源代理 URL：每次访问都会在 content 端点重新鉴权（会话级授权语义），
    // 不伪造"5 分钟过期"——返回体中不再包含 presigned expiresIn。
    // 只回传相对路径，不泄露 objectKey/bucket/对象存储端点。
    return NextResponse.json({
      url: `/api/assets/${encodeURIComponent(assetId)}/content`,
      access: "PRIVATE",
    });
  } catch (error) {
    logger.error("资源访问接口失败", "GET /api/assets/[assetId]/access", {
      operation: "asset-access",
      assetId,
      userId,
      error,
    });
    return NextResponse.json({ message: "资源访问失败，请稍后重试" }, { status: 500 });
  }
}

export const GET = withHttpMetrics("assets/:id/access", getHandler);
