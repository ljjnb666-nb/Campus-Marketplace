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
    const file = {
      name: "avatar.png",
      size: 6,
      type: "image/png",
      arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
    } as unknown as File;

    const result = await saveUploadedImage(file, "avatar");

    expect(result).toMatch(/^\/uploads\/avatar\/.+\.png$/);
    expect(result).not.toBeNull();

    const fileName = result!.split("/").pop();
    const writtenPath = path.resolve(process.cwd(), "./.tmp-test-uploads/avatars", fileName!);

    await expect(access(writtenPath)).resolves.toBeUndefined();
    await expect(readFile(writtenPath)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });
});
