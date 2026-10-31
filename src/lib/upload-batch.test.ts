import { describe, expect, it, vi } from "vitest";
import { mapUploadsWithConcurrency, MAX_UPLOAD_BATCH_BYTES, validateUploadBatch } from "./upload-batch";

function file(size: number, type = "image/png"): File {
  return { size, type } as File;
}

describe("upload batch preflight", () => {
  it("counts tokens and files together before any upload", () => {
    expect(() => validateUploadBatch([...Array(9).fill("asset:existing"), file(1)], "product"))
      .toThrow("最多上传 9 张图片");
    expect(() => validateUploadBatch(["asset:existing", file(1)], "product")).not.toThrow();
  });
  it("checks each file and aggregate bytes even when each file is individually valid", () => {
    expect(() => validateUploadBatch([file(1), file(1, "image/svg+xml")], "product")).toThrow("不支持");
    expect(() => validateUploadBatch([file(11 * 1024 * 1024)], "product")).toThrow("不能超过");
    expect(() => validateUploadBatch([file(MAX_UPLOAD_BATCH_BYTES / 2), file(MAX_UPLOAD_BATCH_BYTES / 2 + 1)], "product"))
      .toThrow("总大小");
  });
  it("bounds concurrency and preserves ordering", async () => {
    let active = 0;
    let peak = 0;
    const result = await mapUploadsWithConcurrency([1, 2, 3, 4, 5], async (n) => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return n * 2;
    });
    expect(peak).toBe(2);
    expect(result).toEqual([2, 4, 6, 8, 10]);
  });
  it("stops new work on failure and drains already-running work", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const work = vi.fn(async (n: number) => { if (n === 1) throw new Error("storage down"); await held; return n; });
    const result = mapUploadsWithConcurrency([1, 2, 3, 4], work);
    const outcome = result.catch((error: unknown) => error);
    await Promise.resolve();
    expect(work).toHaveBeenCalledTimes(2);
    release();
    expect(await outcome).toMatchObject({ message: "storage down" });
    expect(work).toHaveBeenCalledTimes(2);
  });
});
