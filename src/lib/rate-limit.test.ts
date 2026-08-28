import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { evalFn, delFn, mockClient } = vi.hoisted(() => ({
  evalFn: vi.fn(),
  delFn: vi.fn(),
  // 模拟连接状态机：ready/connecting/end 可按用例切换
  mockClient: {
    status: "ready" as string,
    eval: vi.fn(),
    del: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(() => mockClient),
}));

import { isRateLimited, resetRateLimit } from "@/lib/rate-limit";

type RateLimitGlobal = typeof globalThis & {
  rateLimitRedis?: unknown;
  rateLimitRedisReady?: Promise<boolean> | undefined;
};

describe("rate limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    // 默认走本地计数路径；需要 Redis 路径的用例单独覆盖环境变量
    vi.stubEnv("REDIS_URL", "");
    (globalThis as RateLimitGlobal).rateLimitRedis = undefined;
    (globalThis as RateLimitGlobal).rateLimitRedisReady = undefined;
    mockClient.status = "ready";
    mockClient.eval = evalFn;
    mockClient.del = delFn;
    evalFn.mockReset();
    delFn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("counts locally when REDIS_URL is not configured", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        isRateLimited({ key: "under-limit", limit: 10, windowMs: 60000 }),
      ),
    );

    expect(results.every((result) => !result.limited)).toBe(true);
    expect(results[0]).toEqual({ limited: false, remaining: 9 });
    expect(results[4]).toEqual({ limited: false, remaining: 5 });
    expect(evalFn).not.toHaveBeenCalled();
  });

  it("blocks locally once the limit is reached", async () => {
    for (let i = 0; i < 3; i += 1) {
      await isRateLimited({ key: "over-limit", limit: 3, windowMs: 60000 });
    }

    expect(
      await isRateLimited({ key: "over-limit", limit: 3, windowMs: 60000 }),
    ).toEqual({ limited: true, remaining: 0 });
  });

  it("tracks keys independently", async () => {
    for (let i = 0; i < 3; i += 1) {
      await isRateLimited({ key: "user-a", limit: 3, windowMs: 60000 });
    }

    expect(
      await isRateLimited({ key: "user-b", limit: 3, windowMs: 60000 }),
    ).toEqual({ limited: false, remaining: 2 });
  });

  it("allows requests again after the window expires", async () => {
    for (let i = 0; i < 3; i += 1) {
      await isRateLimited({ key: "expiry", limit: 3, windowMs: 60000 });
    }

    expect(
      await isRateLimited({ key: "expiry", limit: 3, windowMs: 60000 }),
    ).toEqual({ limited: true, remaining: 0 });

    vi.advanceTimersByTime(60001);

    expect(
      await isRateLimited({ key: "expiry", limit: 3, windowMs: 60000 }),
    ).toEqual({ limited: false, remaining: 2 });
  });

  it("prunes stale keys so the bucket map does not grow forever", async () => {
    await isRateLimited({ key: "stale", limit: 2, windowMs: 1000 });
    await isRateLimited({ key: "fresh", limit: 2, windowMs: 60000 });

    vi.advanceTimersByTime(1001);
    await isRateLimited({ key: "another", limit: 2, windowMs: 60000 });

    // "stale" 已过期并被顺带清理，重新计数而不是继续累加
    expect(
      await isRateLimited({ key: "stale", limit: 2, windowMs: 60000 }),
    ).toEqual({ limited: false, remaining: 1 });
  });

  it("resets a local key explicitly", async () => {
    for (let i = 0; i < 3; i += 1) {
      await isRateLimited({ key: "reset-me", limit: 3, windowMs: 60000 });
    }

    await resetRateLimit("reset-me");

    expect(
      await isRateLimited({ key: "reset-me", limit: 3, windowMs: 60000 }),
    ).toEqual({ limited: false, remaining: 2 });
  });

  it("counts against Redis when REDIS_URL is configured", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    evalFn.mockResolvedValue(1);

    const result = await isRateLimited({
      key: "login:a@campus.local",
      limit: 10,
      windowMs: 900000,
    });

    expect(result).toEqual({ limited: false, remaining: 9 });
    expect(evalFn).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "ratelimit:login:a@campus.local",
      900000,
    );
  });

  it("marks limited once the Redis counter exceeds the limit", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    evalFn.mockResolvedValue(11);

    expect(
      await isRateLimited({ key: "login:b@campus.local", limit: 10, windowMs: 900000 }),
    ).toEqual({ limited: true, remaining: 0 });
  });

  it("never reports remaining below zero from Redis counting", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    evalFn.mockResolvedValue(999);

    const result = await isRateLimited({ key: "flood", limit: 10, windowMs: 60000 });

    expect(result.remaining).toBe(0);
  });

  it("falls back to the local counter when Redis errors", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    evalFn.mockRejectedValue(new Error("Connection refused"));

    expect(await isRateLimited({ key: "fallback", limit: 2, windowMs: 60000 })).toEqual({
      limited: false,
      remaining: 1,
    });
    expect(await isRateLimited({ key: "fallback", limit: 2, windowMs: 60000 })).toEqual({
      limited: false,
      remaining: 0,
    });
    expect(await isRateLimited({ key: "fallback", limit: 2, windowMs: 60000 })).toEqual({
      limited: true,
      remaining: 0,
    });
  });

  it("waits for a connecting client to become ready instead of mis-falling-back", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    mockClient.status = "connecting";
    evalFn.mockResolvedValue(1);

    // 50ms 后连接建立
    setTimeout(() => {
      mockClient.status = "ready";
    }, 50);

    const pending = isRateLimited({ key: "cold-start", limit: 2, windowMs: 60000 });
    // 推进 fake timers：readiness 轮询跨越 50ms 后 client ready
    await vi.advanceTimersByTimeAsync(75);
    const result = await pending;

    expect(result).toEqual({ limited: false, remaining: 1 });
    expect(evalFn).toHaveBeenCalledTimes(1);
  });

  it("falls back immediately without eval when the client is dead (end)", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    mockClient.status = "end";

    expect(await isRateLimited({ key: "dead", limit: 2, windowMs: 60000 })).toEqual({
      limited: false,
      remaining: 1,
    });
    expect(evalFn).not.toHaveBeenCalled();
  });

  it("resets the Redis counter on explicit reset", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    delFn.mockResolvedValue(1);

    await resetRateLimit("reset-me-redis");

    expect(delFn).toHaveBeenCalledWith("ratelimit:reset-me-redis");
  });
});
