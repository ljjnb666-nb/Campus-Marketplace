import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, saveUploadedImage, isRateLimited } = vi.hoisted(() => ({
  auth: vi.fn(),
  saveUploadedImage: vi.fn(),
  isRateLimited: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth,
}));

vi.mock("@/lib/rate-limit", () => ({
  isRateLimited,
}));

vi.mock("@/lib/upload", () => ({
  saveUploadedImage,
  isUploadCategory: (cat: string) =>
    ["avatar", "product"].includes(cat),
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
    auth.mockReset().mockResolvedValue({ user: { id: "user-1" } });
    saveUploadedImage.mockReset().mockResolvedValue("/uploads/products/photo.jpg");
    isRateLimited.mockReset().mockReturnValue({ limited: false, remaining: 19 });
  });

  it("returns 401 when there is no session", async () => {
    auth.mockResolvedValue(null);

    const response = await POST(buildUploadRequest());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "未登录，请先登录" });
    expect(isRateLimited).not.toHaveBeenCalled();
    expect(saveUploadedImage).not.toHaveBeenCalled();
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
    expect(saveUploadedImage).not.toHaveBeenCalled();
  });

  it("uploads the image when the user is within the limit", async () => {
    const response = await POST(buildUploadRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      url: "/uploads/products/photo.jpg",
      size: 3,
      mimeType: "image/jpeg",
    });
    expect(saveUploadedImage).toHaveBeenCalledWith(
      expect.any(File),
      "product",
    );
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
  });

  it("returns 400 for unsupported mime types", async () => {
    const gif = new File([new Uint8Array([1])], "photo.gif", { type: "image/gif" });
    const response = await POST(buildUploadRequest(gif));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "不支持的图片格式，仅支持JPG、PNG和WebP",
    });
  });

  it("returns 400 for files beyond the category size limit", async () => {
    const big = new File([new Uint8Array([1])], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(big, "size", { value: 6 * 1024 * 1024 });
    const response = await POST(buildUploadRequest(big, "avatar"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "图片大小不能超过5MB" });
  });

  it("returns 500 when saving the file fails", async () => {
    saveUploadedImage.mockResolvedValue(null);

    const response = await POST(buildUploadRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "图片上传失败" });
  });

  it("hides internal error details when saving throws", async () => {
    saveUploadedImage.mockRejectedValue(
      new Error("EACCES: permission denied, open '/uploads/products/photo.jpg'"),
    );

    const response = await POST(buildUploadRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "服务器内部错误，请稍后重试" });
  });
});
