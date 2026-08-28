import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  createPrivateAssetSignedUrl,
  resolvePrivateAssetAccess,
  resolvePublicAssetUrl,
} from "@/lib/asset-service";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * 资源访问入口：
 * - PRIVATE 资源：鉴权后返回短时签名 URL（默认 5 分钟，env 可配）
 * - PUBLIC 资源：直接返回公开 URL（无需签名）
 *
 * 状态码约定：401 未登录 / 403 无权 / 404 不存在（含已删除）/ 410 已过保留期
 */
export async function GET(
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

    const { url, expiresIn } = await createPrivateAssetSignedUrl({
      bucket: result.asset.bucket,
      objectKey: result.asset.objectKey,
    });

    logger.info("私有资源签名访问签发", "GET /api/assets/[assetId]/access", {
      operation: "asset-access",
      assetId,
      userId,
      category: result.asset.category,
      expiresIn,
      durationMs: Date.now() - startedAt,
    });

    // 只回传签名 URL 与有效期，不泄露 objectKey
    return NextResponse.json({ url, expiresIn, access: "PRIVATE" });
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
