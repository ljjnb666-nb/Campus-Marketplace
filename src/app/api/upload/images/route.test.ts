import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getVerifiedSession,
  uploadImageAsset,
  isRateLimited,
  AssetServiceError,
  isImageValidationError,
} = vi.hoisted(() => {
  class AssetServiceError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status = 400) {
      super(message);
      this.name = "AssetServiceError";
      this.code = code;
      this.status = status;
    }
  }
  return {
    getVerifiedSession: vi.fn(),
    uploadImageAsset: vi.fn(),
    isRateLimited: vi.fn(),
    AssetServiceError,
    isImageValidationError: vi.fn(() => false),
  };
});

vi.mock("@/lib/server-auth", () => ({
  getVerifiedSession,
  VERIFIED_SESSION_HTTP_STATUS: {
    UNAUTHENTICATED: 401,
    ACCOUNT_INACTIVE: 401,
    LEGAL_ACCEPTANCE_REQUIRED: 403,
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  isRateLimited,
}));

vi.mock("@/lib/asset-service", () => ({
  uploadImageAsset,
  AssetServiceError,
  isImageValidationError,
}));

vi.mock("@/lib/upload", () => ({
  isUploadCategory: (cat: string) => ["avatar", "product", "verification"].includes(cat),
  UPLOAD_LIMITS: {
    avatar: {
      maxSize: 5 * 1024 * 1024,
      maxCount: 1,
      allowedTypes: ["image/jpeg", "image/png", "image/webp"],
    },
    product: {
      maxSize: 10 * 1024 * 1024,
      maxCount: 9,
      allowedTypes: ["image/jpeg", "image/png", "image/webp"],
    },
    verification: {
      maxSize: 5 * 1024 * 1024,
      maxCount: 2,
      allowedTypes: ["image/jpeg", "image/png", "image/webp"],
    },
  },
}));

import { POST } from "@/app/api/upload/images/route";
import type { NextRequest } from "next/server";

function buildUploadRequest(
  file: File | null = new File([new Uint8Array([1, 2, 3])], "photo.jpg", {
    type: "image/jpeg",
  }),
  category = "product",
) {
  const formData = new FormData();
  if (file) {
    formData.set("file", file);
  }
  formData.set("category", category);

  // 路由只依赖 request.formData()，直接提供桩对象避免跨环境 multipart 序列化
  return { formData: async () => formData } as unknown as NextRequest;
}

describe("POST /api/upload/images", () => {
  beforeEach(() => {
    getVerifiedSession
      .mockReset()
      .mockResolvedValue({ ok: true, user: { id: "user-1", role: "STUDENT" } });
    uploadImageAsset.mockReset().mockResolvedValue({
      assetId: "asset-1",
      access: "PUBLIC",
      url: "http://localhost:9100/campus-public/public/products/u1/x.webp",
      mimeType: "image/webp",
      sizeBytes: 1024,
    });
    isRateLimited.mockReset().mockReturnValue({ limited: false, remaining: 19 });
    isImageValidationError.mockReset().mockReturnValue(false);
  });

  it("returns 401 when there is no session", async () => {
    getVerifiedSession.mockResolvedValue({ ok: false, reason: "UNAUTHENTICATED" });

    const response = await POST(buildUploadRequest());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "未登录，请先登录",
      code: "UNAUTHENTICATED",
    });
    expect(isRateLimited).not.toHaveBeenCalled();
    expect(uploadImageAsset).not.toHaveBeenCalled();
  });

  it("blocks uploads for users with pending required policies (consent gate)", async () => {
    getVerifiedSession.mockResolvedValue({ ok: false, reason: "LEGAL_ACCEPTANCE_REQUIRED" });

    const response = await POST(buildUploadRequest());

    expect(response.status).toBe(403);
    const body = await response.json();

    expect(body.code).toBe("LEGAL_ACCEPTANCE_REQUIRED");
    expect(uploadImageAsset).not.toHaveBeenCalled();
  });

  it("rate limits each uploading user to 20 requests per minute", async () => {
    isRateLimited.mockReturnValue({ limited: true, remaining: 0 });

    const response = await POST(buildUploadRequest());

    expect(isRateLimited).toHaveBeenCalledWith({
      key: "user-1",
      limit: 20,
      windowMs: 60000,
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "上传过于频繁，请稍后再试" });
    expect(uploadImageAsset).not.toHaveBeenCalled();
  });

  it("uploads a public image and returns asset metadata without legacy url-only shape", async () => {
    const response = await POST(buildUploadRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      assetId: "asset-1",
      access: "PUBLIC",
      url: "http://localhost:9100/campus-public/public/products/u1/x.webp",
      mimeType: "image/webp",
      sizeBytes: 1024,
    });
    expect(uploadImageAsset).toHaveBeenCalledWith({
      userId: "user-1",
      category: "product",
      file: expect.any(File),
    });
  });

  it("never returns a permanent url for private categories", async () => {
    uploadImageAsset.mockResolvedValue({
      assetId: "asset-2",
      access: "PRIVATE",
      url: null,
      mimeType: "image/webp",
      sizeBytes: 512,
    });

    const response = await POST(buildUploadRequest(undefined, "verification"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.access).toBe("PRIVATE");
    expect(body.assetId).toBe("asset-2");
    expect(body.url).toBeNull();
  });

  it("returns 400 when no file is selected", async () => {
    const response = await POST(buildUploadRequest(null));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "未选择文件" });
  });

  it("returns 400 for an upload category outside the whitelist", async () => {
    const response = await POST(buildUploadRequest(undefined, "constructor"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "无效的上传分类" });
    expect(uploadImageAsset).not.toHaveBeenCalled();
  });

  it("returns 400 for unsupported mime types", async () => {
    const gif = new File([new Uint8Array([1])], "photo.gif", { type: "image/gif" });
    const response = await POST(buildUploadRequest(gif));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "不支持的图片格式，仅支持JPG、PNG和WebP",
    });
    expect(uploadImageAsset).not.toHaveBeenCalled();
  });

  it("returns 413 for files beyond the category size limit", async () => {
    const big = new File([new Uint8Array([1])], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(big, "size", { value: 6 * 1024 * 1024 });
    const response = await POST(buildUploadRequest(big, "avatar"));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "图片大小不能超过5MB" });
    expect(uploadImageAsset).not.toHaveBeenCalled();
  });

  it("maps quota exceeded errors to 413 with a friendly message", async () => {
    uploadImageAsset.mockRejectedValue(
      new AssetServiceError("QUOTA_EXCEEDED", "存储空间不足，请删除旧图片后再试", 413),
    );

    const response = await POST(buildUploadRequest());

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "存储空间不足，请删除旧图片后再试" });
  });

  it("maps image validation errors to 400 without leaking internals", async () => {
    uploadImageAsset.mockRejectedValue(new Error("文件内容不是有效的图片"));
    isImageValidationError.mockReturnValue(true);

    const response = await POST(buildUploadRequest());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "文件内容不是有效的图片" });
  });

  it("hides internal error details for unexpected failures", async () => {
    uploadImageAsset.mockRejectedValue(
      new Error("EACCES: permission denied, open '/uploads/products/photo.jpg'"),
    );

    const response = await POST(buildUploadRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "服务器内部错误，请稍后重试" });
  });
});
