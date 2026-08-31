import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { readPrivateAssetObject } from "@/lib/asset-service";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * 私有资产内容同源代理端点：
 *
 *   浏览器 → /api/assets/<assetId>/content（会话鉴权）
 *          → 本端点重新执行服务端授权（owner / ADMIN / 订单参与者）
 *          → server 经内部 S3_ENDPOINT 读取对象并转发
 *
 * - 浏览器永远不需要解析对象存储内部端点（self-hosted 下 http://minio:9000
 *   不可达且不得泄露）；对象由 server 使用内部凭据读取。
 * - 每次请求独立鉴权，不依赖 access API 是否曾授权过。
 * - 错误响应不泄露 bucket/objectKey/端点/签名 URL。
 *
 * 状态码约定与 access API 一致：401 / 403 / 404（含已删除与 PUBLIC 误入）/ 410
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
    const result = await readPrivateAssetObject(assetId, { id: userId, role });

    if (!result.ok) {
      logger.warn("私有资产内容读取被拒绝", "GET /api/assets/[assetId]/content", {
        operation: "asset-content",
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

    logger.info("私有资产内容同源转发", "GET /api/assets/[assetId]/content", {
      operation: "asset-content",
      assetId,
      userId,
      sizeBytes: result.sizeBytes,
      durationMs: Date.now() - startedAt,
    });

    // Content-Type 来自上传时服务端写入的可信对象 metadata（上传层有 MIME 白名单），
    // 缺失时退回通用二进制类型并由 nosniff 阻止嗅探。
    return new NextResponse(new Uint8Array(result.body), {
      status: 200,
      headers: {
        "Content-Type": result.contentType ?? "application/octet-stream",
        "Content-Length": String(result.sizeBytes),
        // 私有资产禁止任何缓存：会话授权语义 + 过保留期即失效
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
      },
    });
  } catch (error) {
    logger.error("私有资产内容转发失败", "GET /api/assets/[assetId]/content", {
      operation: "asset-content",
      assetId,
      userId,
      error,
    });
    return NextResponse.json({ message: "资源访问失败，请稍后重试" }, { status: 500 });
  }
}
