import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { saveUploadedImage, UPLOAD_LIMITS, type UploadCategory } from "@/lib/upload";

type AllowedMimeType = "image/jpeg" | "image/png" | "image/webp";

const RATE_LIMIT_MAP = new Map<string, { count: number; resetAt: number }>();
const MAX_REQUESTS_PER_MINUTE = 20;

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const userLimit = RATE_LIMIT_MAP.get(userId);

  if (!userLimit || now > userLimit.resetAt) {
    RATE_LIMIT_MAP.set(userId, {
      count: 1,
      resetAt: now + 60000,
    });
    return true;
  }

  if (userLimit.count >= MAX_REQUESTS_PER_MINUTE) {
    return false;
  }

  userLimit.count++;
  return true;
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "未登录，请先登录" },
        { status: 401 }
      );
    }

    if (!checkRateLimit(session.user.id)) {
      return NextResponse.json(
        { error: "上传过于频繁，请稍后再试" },
        { status: 429 }
      );
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const category = (formData.get("category") as UploadCategory) || "product";

    if (!file) {
      return NextResponse.json(
        { error: "未选择文件" },
        { status: 400 }
      );
    }

    const limits = UPLOAD_LIMITS[category];
    if (!limits) {
      return NextResponse.json(
        { error: "无效的上传分类" },
        { status: 400 }
      );
    }

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
    console.error("Upload error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "上传失败" },
      { status: 500 }
    );
  }
}
