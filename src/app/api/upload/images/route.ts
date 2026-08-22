import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { isRateLimited } from "@/lib/rate-limit";
import { saveUploadedImage, UPLOAD_LIMITS, isUploadCategory } from "@/lib/upload";

type AllowedMimeType = "image/jpeg" | "image/png" | "image/webp";

const MAX_REQUESTS_PER_MINUTE = 20;
const RATE_LIMIT_WINDOW_MS = 60000;

export async function POST(request: NextRequest) {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "未登录，请先登录" },
        { status: 401 }
      );
    }

    const { limited } = isRateLimited({
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
    const category = String(formData.get("category") ?? "product");

    if (!file) {
      return NextResponse.json(
        { error: "未选择文件" },
        { status: 400 }
      );
    }

    // 白名单校验，避免原型链属性（如 "constructor"）绕过下标检查
    if (!isUploadCategory(category)) {
      return NextResponse.json(
        { error: "无效的上传分类" },
        { status: 400 }
      );
    }

    const limits = UPLOAD_LIMITS[category];

    if (!limits.allowedTypes.includes(file.type as AllowedMimeType)) {
      return NextResponse.json(
        { error: "不支持的图片格式，仅支持JPG、PNG和WebP" },
        { status: 400 }
      );
    }

    if (file.size > limits.maxSize) {
      const maxSizeMB = Math.floor(limits.maxSize / (1024 * 1024));
      return NextResponse.json(
        { error: `图片大小不能超过${maxSizeMB}MB` },
        { status: 400 }
      );
    }

    const url = await saveUploadedImage(file, category);

    if (!url) {
      return NextResponse.json(
        { error: "图片上传失败" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      url,
      size: file.size,
      mimeType: file.type,
    });
  } catch (error) {
    logger.error("图片上传失败", "POST /api/upload/images", { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "上传失败" },
      { status: 500 }
    );
  }
}
