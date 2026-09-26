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

import {
  isRateLimited,
  resetRateLimit,
  REDIS_FAILURE_COOLDOWN_MS,
  REDIS_READY_BUDGET_MS,
} from "@/lib/rate-limit";

type RateLimitGlobal = typeof globalThis & {
  rateLimitRedis?: unknown;
  rateLimitRedisReady?: Promise<boolean> | undefined;
  rateLimitRedisFailureUntil?: number | undefined;
};

describe("rate limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    // 默认走本地计数路径；需要 Redis 路径的用例单独覆盖环境变量
    vi.stubEnv("REDIS_URL", "");
    (globalThis as RateLimitGlobal).rateLimitRedis = undefined;
    (globalThis as RateLimitGlobal).rateLimitRedisReady = undefined;
    (globalThis as RateLimitGlobal).rateLimitRedisFailureUntil = undefined;
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

  it("enters cooldown after a failed readiness probe and skips the budget within the window", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    mockClient.status = "connecting";

    // 第一次失败 probe：支付一次预算后回退
    const pending = isRateLimited({ key: "cooldown-a", limit: 2, windowMs: 60_000 });
    await vi.advanceTimersByTimeAsync(REDIS_READY_BUDGET_MS + 50);
    const first = await pending;
    expect(first).toEqual({ limited: false, remaining: 1 });
    const g = globalThis as RateLimitGlobal;
    expect(g.rateLimitRedisFailureUntil).toBeGreaterThan(Date.now());

    // 冷却窗口内：立即回退，不再支付预算
    mockClient.status = "connecting";
    const startWithin = Date.now();
    const within = await isRateLimited({ key: "cooldown-a", limit: 2, windowMs: 60_000 });
    expect(within).toEqual({ limited: false, remaining: 0 });
    expect(Date.now() - startWithin).toBeLessThan(50);
  });

  it("recovers immediately once the client is ready, even mid-cooldown", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    mockClient.status = "connecting";

    // 进入冷却
    const pending = isRateLimited({ key: "recover", limit: 2, windowMs: 60_000 });
    await vi.advanceTimersByTimeAsync(REDIS_READY_BUDGET_MS + 50);
    await pending;

    // ioredis 自身重连成功（ready）→ 即使冷却未到期也立即恢复 Redis 路径
    mockClient.status = "ready";
    evalFn.mockResolvedValue(1);
    const result = await isRateLimited({ key: "recover", limit: 2, windowMs: 60_000 });

    expect(result).toEqual({ limited: false, remaining: 1 });
    expect(evalFn).toHaveBeenCalledTimes(1);
    expect((globalThis as RateLimitGlobal).rateLimitRedisFailureUntil).toBeUndefined();
  });

  it("allows a new readiness probe after the cooldown window expires", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    mockClient.status = "connecting";

    // 进入冷却
    const pending = isRateLimited({ key: "expiry-cooldown", limit: 2, windowMs: 60_000 });
    await vi.advanceTimersByTimeAsync(REDIS_READY_BUDGET_MS + 50);
    await pending;

    // 冷却期内：立即回退
    mockClient.status = "connecting";
    await isRateLimited({ key: "expiry-cooldown", limit: 2, windowMs: 60_000 });

    // 冷却到期：允许重新 probe（本次仍失败，但 probe 被重新执行）
    vi.advanceTimersByTime(REDIS_FAILURE_COOLDOWN_MS + 10);
    mockClient.status = "connecting";
    const retry = isRateLimited({ key: "expiry-cooldown", limit: 2, windowMs: 60_000 });
    await vi.advanceTimersByTimeAsync(REDIS_READY_BUDGET_MS + 50);
    await retry;

    // 失败状态被刷新（新一轮冷却）
    expect((globalThis as RateLimitGlobal).rateLimitRedisFailureUntil).toBeGreaterThan(
      Date.now() - REDIS_FAILURE_COOLDOWN_MS,
    );
  });

  it("enters cooldown when a Redis command fails mid-flight and skips the next probes", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    mockClient.status = "ready";
    evalFn.mockRejectedValue(new Error("Connection restored-then-lost"));

    // 命令失败：本地回退 + 进入冷却
    const first = await isRateLimited({ key: "cmd-fail", limit: 2, windowMs: 60_000 });
    expect(first).toEqual({ limited: false, remaining: 1 });
    expect((globalThis as RateLimitGlobal).rateLimitRedisFailureUntil).toBeGreaterThan(
      Date.now(),
    );

    // 冷却窗口内：即使 client 声称非 ready，也不再执行 eval
    mockClient.status = "connecting";
    evalFn.mockClear();
    await isRateLimited({ key: "cmd-fail", limit: 2, windowMs: 60_000 });
    expect(evalFn).not.toHaveBeenCalled();
  });

  it("does not log the rate-limit key in cooldown transition events", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    const loggerModule = await import("@/lib/logger");
    const warnSpy = vi.spyOn(loggerModule.logger, "warn").mockImplementation(() => undefined);
    mockClient.status = "connecting";

    const pending = isRateLimited({ key: "secret-email@campus.local", limit: 2, windowMs: 60_000 });
    await vi.advanceTimersByTimeAsync(REDIS_READY_BUDGET_MS + 50);
    await pending;

    const cooldownEvents = warnSpy.mock.calls.filter((call) =>
      String(call[0]).includes("冷却"),
    );
    expect(cooldownEvents.length).toBeGreaterThan(0);
    for (const call of cooldownEvents) {
      expect(JSON.stringify(call)).not.toContain("secret-email@campus.local");
    }
    warnSpy.mockRestore();
  });
});
