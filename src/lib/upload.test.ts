import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    UPLOAD_DIR: "./.tmp-test-uploads",
  },
}));

import { isAcceptedImageFile, isStoredImagePath, saveUploadedImage } from "@/lib/upload";

describe("upload helpers", () => {
  beforeEach(async () => {
    await rm(path.resolve(process.cwd(), "./.tmp-test-uploads"), { recursive: true, force: true });
  });

  it("detects stored upload paths", () => {
    expect(isStoredImagePath("/uploads/products/book.jpg")).toBe(true);
    expect(isStoredImagePath("https://example.com/book.jpg")).toBe(false);
  });

  it("accepts image files with content", () => {
    expect(isAcceptedImageFile(new File(["demo"], "avatar.png", { type: "image/png" }))).toBe(true);
    expect(isAcceptedImageFile(new File([], "empty.png", { type: "image/png" }))).toBe(false);
  });

  it("writes uploaded files into the configured upload directory", async () => {
    // JPEG 文件头: FF D8 FF E0 + 最小 JFIF 段
    const jpegHeader = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
      0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    ]);
    const file = {
      name: "avatar.jpg",
      size: jpegHeader.length,
      type: "image/jpeg",
      arrayBuffer: vi.fn().mockResolvedValue(jpegHeader.buffer),
    } as unknown as File;

    const result = await saveUploadedImage(file, "avatar");

    expect(result).toMatch(/^\/uploads\/avatar\/.+\.jpg$/);
    expect(result).not.toBeNull();

    // 文件名由服务端生成，先断言只含安全字符再用固定目录拼接，防路径拼接误用
    const fileName = result!.split("/").pop()!;
    expect(fileName).toMatch(/^[0-9a-f-]+\.jpg$/);
    const writtenPath = path.join(
      path.resolve(process.cwd(), "./.tmp-test-uploads"),
      "avatars",
      fileName,
    );

    await expect(access(writtenPath)).resolves.toBeUndefined();
    await expect(readFile(writtenPath)).resolves.toEqual(Buffer.from(jpegHeader));
  });
});
