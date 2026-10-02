import { describe, expect, it } from "vitest";

import { BASE_BACKOFF_MS, computeBackoffDelayMs, MAX_BACKOFF_MS } from "./backoff";

describe("Phase 9A 统一 backoff helper（§15 冻结公式）", () => {
  it("attempt 1 → 5s；attempt 2 → 10s（指数翻倍）", () => {
    expect(BASE_BACKOFF_MS).toBe(5_000);
    expect(computeBackoffDelayMs(1)).toBe(5_000);
    expect(computeBackoffDelayMs(2)).toBe(10_000);
  });

  it("attempt 3 → 20s；未封顶前严格 2^(attempts-1)", () => {
    expect(computeBackoffDelayMs(3)).toBe(20_000);
    expect(computeBackoffDelayMs(4)).toBe(40_000);
  });

  it("封顶 MAX_BACKOFF = 15 分钟（不无限指数膨胀）", () => {
    expect(MAX_BACKOFF_MS).toBe(15 * 60 * 1000);
    expect(computeBackoffDelayMs(10)).toBe(MAX_BACKOFF_MS);
    expect(computeBackoffDelayMs(100)).toBe(MAX_BACKOFF_MS);
  });

  it("非法输入 fail-safe（0/负数/小数按 1 次消耗处理）", () => {
    expect(computeBackoffDelayMs(0)).toBe(BASE_BACKOFF_MS);
    expect(computeBackoffDelayMs(-3)).toBe(BASE_BACKOFF_MS);
    expect(computeBackoffDelayMs(1.5)).toBe(BASE_BACKOFF_MS);
  });
});
