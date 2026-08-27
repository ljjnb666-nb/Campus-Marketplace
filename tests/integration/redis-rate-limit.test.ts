import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * 真实 Redis 集成测试：验证 Lua 固定窗口脚本在真实 Redis 上的计数与重置行为
 * （单元测试以 mock 覆盖降级路径，本测试覆盖真实 EVAL 语义）。
 *
 * 仅当环境变量 INTEGRATION_REDIS_URL 指向真实 Redis（本地容器或 CI 服务容器）
 * 时执行，否则整个 describe 被跳过。
 */
const integrationRedisUrl = process.env.INTEGRATION_REDIS_URL;

describe.skipIf(!integrationRedisUrl)("Redis 限流集成测试", () => {
  type RedisLike = { disconnect: () => Promise<void> };
  type RateLimitGlobal = typeof globalThis & { rateLimitRedis?: RedisLike };

  afterAll(async () => {
    await (globalThis as RateLimitGlobal).rateLimitRedis?.disconnect();
    (globalThis as RateLimitGlobal).rateLimitRedis = undefined;
  });

  it("真实 Redis 上的固定窗口计数与显式重置", async () => {
    process.env.REDIS_URL = integrationRedisUrl;
    vi.resetModules();
    (globalThis as RateLimitGlobal).rateLimitRedis = undefined;

    const { isRateLimited, resetRateLimit } = await import("@/lib/rate-limit");

    // 每次运行使用独立 key，避免残留计数干扰
    const key = `it-redis:${Math.random().toString(36).slice(2)}`;
    const options = { key, limit: 2, windowMs: 60_000 };

    expect(await isRateLimited(options)).toEqual({ limited: false, remaining: 1 });
    expect(await isRateLimited(options)).toEqual({ limited: false, remaining: 0 });
    expect(await isRateLimited(options)).toEqual({ limited: true, remaining: 0 });

    await resetRateLimit(key);

    expect(await isRateLimited(options)).toEqual({ limited: false, remaining: 1 });
  });
});
