import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * 真实 Redis 集成测试（Release Gate）：必须证明计数真的进入 Redis，
 * 而不是只断言业务返回值——生产实现的本地 fallback 会产生相同返回值，
 * 只看返回值无法区分"用了 Redis"与"静默降级"。
 *
 * 权威证据来自独立的 inspector 客户端直读 Redis：
 * - isRateLimited 后 ratelimit:<key> 依次为 1/2/3，PTTL > 0
 * - resetRateLimit 后 key 不存在
 * - 并发调用不丢计数（Lua 原子性）
 * - Redis 不可用时快速 fallback 本地（真实降级路径）
 *
 * 仅当 INTEGRATION_REDIS_URL 指向真实 Redis 时执行；inspector ping
 * 失败则直接判 FAIL（不允许带病假绿）。
 */
const integrationRedisUrl = process.env.INTEGRATION_REDIS_URL;

describe.skipIf(!integrationRedisUrl)("Redis 限流集成测试（真实 Redis 状态验证）", () => {
  let inspector: Redis;
  const originalRedisUrl = process.env.REDIS_URL;

  type RateLimitGlobal = typeof globalThis & {
    rateLimitRedis?: Redis;
    rateLimitRedisReady?: Promise<boolean> | undefined;
  };

  const usedKeys: string[] = [];

  function freshKey(label: string) {
    const key = `it-redis:${label}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    usedKeys.push(key);
    return key;
  }

  /**
   * 以指定 REDIS_URL 重新加载业务模块并重建 client 单例。
   * REDIS_URL 在测试自持期间保持设定（client 惰性创建，调用时才读取），
   * 原值在 afterAll 统一还原。
   */
  async function freshModule(url: string | undefined) {
    if (url === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = url;
    }
    vi.resetModules();
    const g = globalThis as RateLimitGlobal;
    // ioredis 的 disconnect() 返回 void，包 Promise 后兜底捕获
    await Promise.resolve(g.rateLimitRedis?.disconnect()).catch(() => undefined);
    g.rateLimitRedis = undefined;
    g.rateLimitRedisReady = undefined;
    return import("@/lib/rate-limit");
  }

  beforeAll(async () => {
    inspector = new Redis(integrationRedisUrl!, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 1500,
    });
    // 独立客户端必须真的连上：连不上直接失败，不允许测试带病通过
    const pong = await inspector.ping();
    expect(pong).toBe("PONG");
  });

  afterAll(async () => {
    for (const key of usedKeys) {
      await inspector.del(`ratelimit:${key}`).catch(() => undefined);
    }
    await inspector.quit().catch(() => inspector.disconnect());

    const g = globalThis as RateLimitGlobal;
    await Promise.resolve(g.rateLimitRedis?.disconnect()).catch(() => undefined);
    g.rateLimitRedis = undefined;
    g.rateLimitRedisReady = undefined;

    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  });

  it("冷启动（connecting）不会误降级：首次调用即真实写入 Redis", async () => {
    const { isRateLimited } = await freshModule(integrationRedisUrl);
    const key = freshKey("cold-start");
    const options = { key, limit: 3, windowMs: 60_000 };

    const startedAt = Date.now();
    const first = await isRateLimited(options);
    const elapsedMs = Date.now() - startedAt;

    // 业务返回正确 + 耗时在 readiness 预算内（等待了连接建立而非假成功）
    expect(first).toEqual({ limited: false, remaining: 2 });
    expect(elapsedMs).toBeLessThan(3000);
    // 权威证据：真实 Redis 中存在计数键（若悄悄 fallback，这里必 FAIL）
    expect(await inspector.get(`ratelimit:${key}`)).toBe("1");
  });

  it("固定窗口计数：1 → 2 → 3 依次写入 Redis，第三次限流，PTTL > 0", async () => {
    const { isRateLimited } = await freshModule(integrationRedisUrl);
    const key = freshKey("window");
    const options = { key, limit: 2, windowMs: 60_000 };
    const redisKey = `ratelimit:${key}`;

    expect(await isRateLimited(options)).toEqual({ limited: false, remaining: 1 });
    expect(await inspector.get(redisKey)).toBe("1");

    expect(await isRateLimited(options)).toEqual({ limited: false, remaining: 0 });
    expect(await inspector.get(redisKey)).toBe("2");

    expect(await isRateLimited(options)).toEqual({ limited: true, remaining: 0 });
    expect(await inspector.get(redisKey)).toBe("3");

    // 窗口 TTL 由 Lua 首次 INCR 时原子设置
    expect(await inspector.pttl(redisKey)).toBeGreaterThan(0);
  });

  it("resetRateLimit 真实删除 Redis 键", async () => {
    const { isRateLimited, resetRateLimit } = await freshModule(integrationRedisUrl);
    const key = freshKey("reset");
    const redisKey = `ratelimit:${key}`;

    await isRateLimited({ key, limit: 2, windowMs: 60_000 });
    await isRateLimited({ key, limit: 2, windowMs: 60_000 });
    expect(await inspector.get(redisKey)).toBe("2");

    await resetRateLimit(key);

    expect(await inspector.exists(redisKey)).toBe(0);
    // 重置后重新计数仍走 Redis
    expect(
      await isRateLimited({ key, limit: 2, windowMs: 60_000 }),
    ).toEqual({ limited: false, remaining: 1 });
    expect(await inspector.get(redisKey)).toBe("1");
  });

  it("并发请求：Redis 原子计数不丢失", async () => {
    const { isRateLimited } = await freshModule(integrationRedisUrl);
    const key = freshKey("concurrent");
    const redisKey = `ratelimit:${key}`;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        isRateLimited({ key, limit: 100, windowMs: 60_000 }),
      ),
    );

    // Lua INCR 原子：Redis 中恰好 5，无一丢失
    expect(await inspector.get(redisKey)).toBe("5");
    // 业务侧：5 次均未超限；剩余数恰为 95..99 的一个排列（完成顺序无关）
    expect(results.every((r) => !r.limited)).toBe(true);
    expect(results.map((r) => r.remaining).sort((a, b) => a - b)).toEqual([
      95, 96, 97, 98, 99,
    ]);
  });

  it(
    "Redis 不可用：快速 fallback 本地计数，登录/上传语义不中断",
    { timeout: 30_000 },
    async () => {
      // 指向必然拒绝连接的端口（不存在的服务），验证真实降级路径。
      // 三次串行调用各自消耗一次 readiness 预算（≤1.8s/次），故放宽本用例超时。
      const { isRateLimited } = await freshModule("redis://127.0.0.1:1");
      const key = freshKey("fallback");
      const options = { key, limit: 2, windowMs: 60_000 };

      const startedAt = Date.now();
      expect(await isRateLimited(options)).toEqual({ limited: false, remaining: 1 });
      const firstCallMs = Date.now() - startedAt;

      expect(await isRateLimited(options)).toEqual({ limited: false, remaining: 0 });
      expect(await isRateLimited(options)).toEqual({ limited: true, remaining: 0 });
      const elapsedMs = Date.now() - startedAt;

      // 可用性优先：单次调用不超过 readiness 预算 + 连接超时；整体快速返回
      expect(firstCallMs).toBeLessThan(5000);
      expect(elapsedMs).toBeLessThan(15_000);
      // fallback 路径没有触碰真实 Redis
      expect(await inspector.exists(`ratelimit:${key}`)).toBe(0);
    },
  );
});
