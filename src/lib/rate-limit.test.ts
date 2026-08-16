import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isRateLimited, resetRateLimit } from "@/lib/rate-limit";

describe("rate limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests under the limit", () => {
    const results = Array.from({ length: 5 }, () =>
      isRateLimited({ key: "under-limit", limit: 10, windowMs: 60000 }),
    );

    expect(results.every((result) => !result.limited)).toBe(true);
    expect(results[0]).toEqual({ limited: false, remaining: 9 });
    expect(results[4]).toEqual({ limited: false, remaining: 5 });
  });

  it("blocks requests once the limit is reached", () => {
    for (let i = 0; i < 3; i += 1) {
      isRateLimited({ key: "over-limit", limit: 3, windowMs: 60000 });
    }

    const blocked = isRateLimited({
      key: "over-limit",
      limit: 3,
      windowMs: 60000,
    });

    expect(blocked).toEqual({ limited: true, remaining: 0 });
  });

  it("tracks keys independently", () => {
    for (let i = 0; i < 3; i += 1) {
      isRateLimited({ key: "user-a", limit: 3, windowMs: 60000 });
    }

    const otherUser = isRateLimited({
      key: "user-b",
      limit: 3,
      windowMs: 60000,
    });

    expect(otherUser).toEqual({ limited: false, remaining: 2 });
  });

  it("allows requests again after the window expires", () => {
    for (let i = 0; i < 3; i += 1) {
      isRateLimited({ key: "expiry", limit: 3, windowMs: 60000 });
    }

    expect(
      isRateLimited({ key: "expiry", limit: 3, windowMs: 60000 }),
    ).toEqual({ limited: true, remaining: 0 });

    vi.advanceTimersByTime(60001);

    expect(
      isRateLimited({ key: "expiry", limit: 3, windowMs: 60000 }),
    ).toEqual({ limited: false, remaining: 2 });
  });

  it("prunes stale keys so the bucket map does not grow forever", () => {
    isRateLimited({ key: "stale", limit: 2, windowMs: 1000 });
    isRateLimited({ key: "fresh", limit: 2, windowMs: 60000 });

    vi.advanceTimersByTime(1001);
    isRateLimited({ key: "another", limit: 2, windowMs: 60000 });

    // "stale" 已过期并被顺带清理，重新计数而不是继续累加
    expect(
      isRateLimited({ key: "stale", limit: 2, windowMs: 60000 }),
    ).toEqual({ limited: false, remaining: 1 });
  });

  it("resets a key explicitly", () => {
    for (let i = 0; i < 3; i += 1) {
      isRateLimited({ key: "reset-me", limit: 3, windowMs: 60000 });
    }

    resetRateLimit("reset-me");

    expect(
      isRateLimited({ key: "reset-me", limit: 3, windowMs: 60000 }),
    ).toEqual({ limited: false, remaining: 2 });
  });
});
