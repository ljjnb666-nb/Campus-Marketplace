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
  UPLOAD_LIMITS: {
    product: {
      maxSize: 10 * 1024 * 1024,
      maxCount: 9,
      allowedTypes: ["image/jpeg", "image/png", "image/webp"],
    },
  },
}));

import { POST } from "@/app/api/upload/images/route";
import type { NextRequest } from "next/server";

function buildUploadRequest() {
  const formData = new FormData();
  formData.set(
    "file",
    new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }),
  );
  formData.set("category", "product");

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
});
