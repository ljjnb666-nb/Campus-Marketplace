import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  AssetServiceError,
  isImageValidationError,
  uploadImageAsset,
} from "@/lib/asset-service";
import { actionErrorMessage } from "@/lib/error-handler";
import { logger } from "@/lib/logger";
import { isRateLimited } from "@/lib/rate-limit";
import { isUploadCategory, UPLOAD_LIMITS } from "@/lib/upload";

const MAX_REQUESTS_PER_MINUTE = 20;
const RATE_LIMIT_WINDOW_MS = 60000;

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let userId: string | null = null;
  let category = "unknown";

  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "未登录，请先登录" },
        { status: 401 }
      );
    }
    userId = session.user.id;

    const { limited } = await isRateLimited({
      key: session.user.id,
      limit: MAX_REQUESTS_PER_MINUTE,
      windowMs: RATE_LIMIT_WINDOW_MS,
    });

    if (limited) {
      return NextResponse.json(
        { error: "上传过于频繁，请稍后再试" },
        { status: 429 }
      );
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const rawCategory = String(formData.get("category") ?? "product");
    category = rawCategory;

    if (!file) {
      return NextResponse.json(
        { error: "未选择文件" },
        { status: 400 }
      );
    }

    // 白名单校验，避免原型链属性（如 "constructor"）绕过下标检查
    if (!isUploadCategory(rawCategory)) {
      return NextResponse.json(
        { error: "无效的上传分类" },
        { status: 400 }
      );
    }

    const limits = UPLOAD_LIMITS[rawCategory];

    if (!(limits.allowedTypes as readonly string[]).includes(file.type)) {
      return NextResponse.json(
        { error: "不支持的图片格式，仅支持JPG、PNG和WebP" },
        { status: 400 }
      );
    }

    if (file.size > limits.maxSize) {
      const maxSizeMB = Math.floor(limits.maxSize / (1024 * 1024));
      return NextResponse.json(
        { error: `图片大小不能超过${maxSizeMB}MB` },
        { status: 413 }
      );
    }

    const result = await uploadImageAsset({
      userId: session.user.id,
      category: rawCategory,
      file,
    });

    logger.info("图片上传接口完成", "POST /api/upload/images", {
      operation: "upload",
      assetId: result.assetId,
      userId: session.user.id,
      category,
      sizeBytes: result.sizeBytes,
      durationMs: Date.now() - startedAt,
    });

    // 私有资源不返回 URL：业务侧保存 assetId，访问时经签名接口换取短时 URL
    return NextResponse.json({
      success: true,
      assetId: result.assetId,
      access: result.access,
      url: result.url,
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
    });
  } catch (error) {
    if (error instanceof AssetServiceError) {
      logger.warn("图片上传被拒绝", "POST /api/upload/images", {
        operation: "upload",
        userId,
        category,
        errorCode: error.code,
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    if (isImageValidationError(error)) {
      logger.warn("图片内容校验未通过", "POST /api/upload/images", {
        operation: "upload",
        userId,
        category,
        errorCode: error.code,
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }
    logger.error("图片上传失败", "POST /api/upload/images", {
      operation: "upload",
      userId,
      category,
      durationMs: Date.now() - startedAt,
      error,
    });
    return NextResponse.json(
      { error: actionErrorMessage(error, "POST /api/upload/images") },
      { status: 500 }
    );
  }
}
