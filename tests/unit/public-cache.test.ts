import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cachedPublicRead,
  clearPublicReadCacheForTest,
  PUBLIC_LISTING_TTL_MS,
} from "@/lib/public-cache";

afterEach(() => {
  clearPublicReadCacheForTest();
  vi.useRealTimers();
});

describe("cachedPublicRead（FINAL REPAIR A LR-011 公开读 TTL 缓存）", () => {
  it("TTL 内命中缓存：同 key 多次调用只回源一次", async () => {
    const load = vi.fn(async () => ({ value: 42 }));
    const first = await cachedPublicRead("k1", PUBLIC_LISTING_TTL_MS, load);
    const second = await cachedPublicRead("k1", PUBLIC_LISTING_TTL_MS, load);
    expect(first).toEqual({ value: 42 });
    expect(second).toEqual({ value: 42 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("key 不同不共享缓存（campusId 维度隔离）", async () => {
    const load = vi.fn(async (tag: string) => ({ tag }));
    await cachedPublicRead("k:a", PUBLIC_LISTING_TTL_MS, () => load("a"));
    await cachedPublicRead("k:b", PUBLIC_LISTING_TTL_MS, () => load("b"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("TTL 过期后重新回源", async () => {
    const load = vi.fn(async () => ({ n: Math.random() }));
    await cachedPublicRead("k2", 10, load);
    await new Promise((r) => setTimeout(r, 15));
    await cachedPublicRead("k2", 10, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("并发未命中合并为一次回源（in-flight 去重）", async () => {
    let resolveLoad!: (v: { n: number }) => void;
    const load = vi.fn(
      () => new Promise<{ n: number }>((resolve) => (resolveLoad = resolve)),
    );
    const p1 = cachedPublicRead("k3", PUBLIC_LISTING_TTL_MS, load);
    const p2 = cachedPublicRead("k3", PUBLIC_LISTING_TTL_MS, load);
    resolveLoad({ n: 1 });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ n: 1 });
    expect(r2).toEqual({ n: 1 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("load 失败不缓存：后续调用重新回源", async () => {
    let attempt = 0;
    const load = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("db down");
      return { ok: true };
    });
    await expect(cachedPublicRead("k4", PUBLIC_LISTING_TTL_MS, load)).rejects.toThrow("db down");
    await expect(cachedPublicRead("k4", PUBLIC_LISTING_TTL_MS, load)).resolves.toEqual({ ok: true });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
