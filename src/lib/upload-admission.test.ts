import { beforeEach, describe, expect, it, vi } from "vitest";
const { isRateLimited } = vi.hoisted(() => ({ isRateLimited: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited }));
import { admitUpload, withUploadSlot } from "./upload-admission";

describe("shared upload admission", () => {
  beforeEach(() => { isRateLimited.mockReset().mockResolvedValue({ limited: false }); globalThis.campusUploadSlots = undefined; });
  it("counts each file once in the same category-independent user bucket", async () => {
    await admitUpload("user-1");
    expect(isRateLimited).toHaveBeenCalledExactlyOnceWith({ key: "upload:user-1", limit: 20, windowMs: 60_000 });
    isRateLimited.mockResolvedValue({ limited: true });
    await expect(admitUpload("user-1")).rejects.toMatchObject({ code: "UPLOAD_RATE_LIMITED", status: 429 });
  });
  it("bounds independently arriving requests and frees slots after errors", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = withUploadSlot(async () => { await held; throw new Error("decode failed"); }).catch(() => undefined);
    const second = withUploadSlot(() => held);
    const queued = vi.fn(async () => "done");
    const third = withUploadSlot(queued);
    await Promise.resolve();
    expect(queued).not.toHaveBeenCalled();
    expect(globalThis.campusUploadSlots?.active).toBe(2);
    release();
    await Promise.all([first, second, third]);
    expect(queued).toHaveBeenCalledTimes(1);
    expect(globalThis.campusUploadSlots).toEqual({ active: 0, waiting: [] });
  });
  it("rejects excess queued work instead of growing an unbounded queue", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const requests = Array.from({ length: 34 }, () => withUploadSlot(() => held));
    await expect(withUploadSlot(async () => undefined)).rejects.toMatchObject({ code: "UPLOAD_BUSY" });
    release();
    await Promise.all(requests);
  });
});
