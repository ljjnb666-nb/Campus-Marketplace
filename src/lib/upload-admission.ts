import { AssetServiceError } from "@/lib/asset-errors";
import { isRateLimited } from "@/lib/rate-limit";
import { UPLOAD_CONCURRENCY } from "@/lib/upload-batch";

export const UPLOAD_RATE_LIMIT = 20;
export const UPLOAD_RATE_WINDOW_MS = 60_000;
const MAX_WAITING_UPLOADS = 32;
const MAX_QUEUE_WAIT_MS = 30_000;

type Waiter = { grant: () => void };
declare global {
  var campusUploadSlots: { active: number; waiting: Waiter[] } | undefined;
}

/** One counter increment per file, regardless of API or Server Action entry.
 * Redis supplies the shared multi-instance budget; slots bound each process's
 * decoder/memory demand even when several HTTP requests arrive concurrently. */
export async function admitUpload(userId: string): Promise<void> {
  const { limited } = await isRateLimited({
    key: `upload:${userId}`, limit: UPLOAD_RATE_LIMIT, windowMs: UPLOAD_RATE_WINDOW_MS,
  });
  if (limited) throw new AssetServiceError("UPLOAD_RATE_LIMITED", "上传过于频繁，请稍后再试", 429);
}

export async function withUploadSlot<T>(run: () => Promise<T>): Promise<T> {
  const state = globalThis.campusUploadSlots ??= { active: 0, waiting: [] };
  if (state.active >= UPLOAD_CONCURRENCY) {
    if (state.waiting.length >= MAX_WAITING_UPLOADS) {
      throw new AssetServiceError("UPLOAD_BUSY", "上传服务繁忙，请稍后重试", 429);
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { grant: () => { clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => {
        const index = state.waiting.indexOf(waiter);
        if (index !== -1) state.waiting.splice(index, 1);
        reject(new AssetServiceError("UPLOAD_BUSY", "上传服务繁忙，请稍后重试", 429));
      }, MAX_QUEUE_WAIT_MS);
      state.waiting.push(waiter);
    });
  } else {
    state.active++;
  }
  try { return await run(); }
  finally {
    const next = state.waiting.shift();
    if (next) next.grant(); // Transfer the occupied slot; do not double increment.
    else state.active--;
  }
}
