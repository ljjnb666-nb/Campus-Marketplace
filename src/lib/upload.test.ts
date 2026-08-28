import { beforeEach, describe, expect, it, vi } from "vitest";

const { uploadImageAsset } = vi.hoisted(() => ({
  uploadImageAsset: vi.fn(),
}));

// upload.ts 从 asset-service 再导出全部服务函数，mock 必须保留真实模块结构，
// 仅替换上传入口，避免"未定义导出"的链接错误。
vi.mock("@/lib/asset-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/asset-service")>();
  return {
    ...actual,
    uploadImageAsset,
  };
});

import {
  isAcceptedImageFile,
  isManageableImageValue,
  isStoredImagePath,
  isUploadCategory,
  saveUploadedImage,
  UPLOAD_LIMITS,
} from "@/lib/upload";

describe("upload helpers", () => {
  beforeEach(() => {
    uploadImageAsset.mockReset();
  });

  it("detects stored upload paths", () => {
    expect(isStoredImagePath("/uploads/products/book.jpg")).toBe(true);
    expect(isStoredImagePath("https://example.com/book.jpg")).toBe(false);
  });

  it("accepts image files with content", () => {
    expect(isAcceptedImageFile(new File(["demo"], "avatar.png", { type: "image/png" }))).toBe(true);
    expect(isAcceptedImageFile(new File([], "empty.png", { type: "image/png" }))).toBe(false);
  });

  it("validates categories against an explicit whitelist", () => {
    expect(isUploadCategory("product")).toBe(true);
    expect(isUploadCategory("verification")).toBe(true);
    // 原型链属性不得命中白名单
    expect(isUploadCategory("constructor")).toBe(false);
    expect(isUploadCategory("__proto__")).toBe(false);
    expect(isUploadCategory("unknown")).toBe(false);
  });

  it("keeps size and count limits for all categories", () => {
    expect(UPLOAD_LIMITS.avatar).toEqual({
      maxSize: 5 * 1024 * 1024,
      maxCount: 1,
      allowedTypes: ["image/jpeg", "image/png", "image/webp"],
    });
    expect(UPLOAD_LIMITS.product.maxCount).toBe(9);
    expect(UPLOAD_LIMITS.rental.maxCount).toBe(9);
    expect(UPLOAD_LIMITS.service.maxCount).toBe(5);
    expect(UPLOAD_LIMITS.verification.maxCount).toBe(2);
    expect(UPLOAD_LIMITS.handover.maxCount).toBe(5);
    expect(UPLOAD_LIMITS.return.maxCount).toBe(5);
    expect(UPLOAD_LIMITS.report.maxCount).toBe(5);
  });

  it("accepts http urls, legacy paths and strictly valid asset references", () => {
    expect(isManageableImageValue("https://example.com/a.jpg")).toBe(true);
    expect(isManageableImageValue("/uploads/products/a.jpg")).toBe(true);
    expect(isManageableImageValue("asset:ckv123abc")).toBe(true);
    expect(isManageableImageValue("javascript:alert(1)")).toBe(false);
    expect(isManageableImageValue("data:text/html,<h1>x</h1>")).toBe(false);
  });

  it("rejects malformed asset: tokens instead of treating them as raw urls", () => {
    // 以 asset: 开头但严格解析失败的值一律拒绝，不得作为普通 token 透传进 DB
    for (const malformed of [
      "asset:***",
      "asset:..",
      "asset:/",
      "asset: ",
      `asset:${"x".repeat(80)}`,
      "asset:%2f..%2fetc",
      "asset:",
    ]) {
      expect(isManageableImageValue(malformed), `value: ${JSON.stringify(malformed)}`).toBe(false);
    }
  });

  it("returns null when no file is provided", async () => {
    await expect(saveUploadedImage(null, "product", "user-1")).resolves.toBeNull();
    await expect(
      saveUploadedImage(new File([], "empty.png", { type: "image/png" }), "product", "user-1"),
    ).resolves.toBeNull();
    expect(uploadImageAsset).not.toHaveBeenCalled();
  });

  it("returns the public url for public categories", async () => {
    uploadImageAsset.mockResolvedValue({
      assetId: "asset-1",
      access: "PUBLIC",
      url: "http://localhost:9100/campus-public/public/products/u1/x.webp",
      mimeType: "image/webp",
      sizeBytes: 1024,
    });

    const result = await saveUploadedImage(
      new File(["demo"], "a.png", { type: "image/png" }),
      "product",
      "user-1",
    );

    expect(result).toBe("http://localhost:9100/campus-public/public/products/u1/x.webp");
    expect(uploadImageAsset).toHaveBeenCalledWith({
      userId: "user-1",
      category: "product",
      file: expect.any(File),
    });
  });

  it("returns an asset reference instead of a url for private categories", async () => {
    uploadImageAsset.mockResolvedValue({
      assetId: "asset-2",
      access: "PRIVATE",
      url: null,
      mimeType: "image/webp",
      sizeBytes: 2048,
    });

    const result = await saveUploadedImage(
      new File(["demo"], "card.png", { type: "image/png" }),
      "verification",
      "user-1",
    );

    // 私有资源禁止返回永久公开 URL，只返回 asset: 引用
    expect(result).toBe("asset:asset-2");
  });

  it("propagates upload errors", async () => {
    uploadImageAsset.mockRejectedValue(new Error("quota exceeded"));

    await expect(
      saveUploadedImage(new File(["demo"], "a.png", { type: "image/png" }), "product", "user-1"),
    ).rejects.toThrow("quota exceeded");
  });
});
