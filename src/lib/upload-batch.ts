import { AssetServiceError } from "@/lib/asset-errors";
import { isUploadCategory, UPLOAD_LIMITS, type UploadCategory } from "@/lib/upload-limits";

// Matches the production request envelope. This is an additional application
// budget; the proxy still enforces the actual multipart body byte limit.
export const MAX_UPLOAD_BATCH_BYTES = 12_000_000;
export const UPLOAD_CONCURRENCY = 2;

/** Validate every entry before decoding or storing any file. Existing URL/asset
 * tokens count toward the category limit but do not consume upload bytes. */
export function validateUploadBatch(entries: readonly (string | File)[], category: UploadCategory): void {
  if (!isUploadCategory(category)) {
    throw new AssetServiceError("INVALID_CATEGORY", "无效的上传分类");
  }
  const limits = UPLOAD_LIMITS[category];
  if (entries.length > limits.maxCount) {
    throw new AssetServiceError("TOO_MANY_FILES", `最多上传 ${limits.maxCount} 张图片`);
  }
  let totalBytes = 0;
  for (const entry of entries) {
    if (typeof entry === "string") continue;
    if (!(limits.allowedTypes as readonly string[]).includes(entry.type)) {
      throw new AssetServiceError("UNSUPPORTED_MIME", "不支持的图片格式，仅支持JPG、PNG和WebP");
    }
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > limits.maxSize) {
      throw new AssetServiceError("FILE_TOO_LARGE", `图片大小须大于0且不能超过${limits.maxSize / 1024 / 1024}MB`, 413);
    }
    totalBytes += entry.size;
  }
  if (totalBytes > MAX_UPLOAD_BATCH_BYTES) {
    throw new AssetServiceError("UPLOAD_BATCH_TOO_LARGE", "本次上传文件总大小超过12MB，请分次上传", 413);
  }
}

/** Preserve input ordering. On failure stop scheduling new work, then drain
 * already-started uploads before returning the failure to the caller. */
export async function mapUploadsWithConcurrency<T, R>(
  entries: readonly T[], callback: (entry: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(entries.length);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, entries.length) }, async () => {
    while (!failed && cursor < entries.length) {
      const index = cursor++;
      try { results[index] = await callback(entries[index], index); }
      catch (error) { if (!failed) { failure = error; failed = true; } }
    }
  }));
  if (failed) throw failure;
  return results;
}
