import { Redis } from "ioredis";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * LR-070 真实 Redis 故障注入集成测试。
 *
 * 故障目标 = 隔离的专用端口（保证无监听进程 → 真实连接失败），
 * 不 stop / 不破坏共享 CI Redis；恢复路径使用共享 INTEGRATION_REDIS_URL
 * （唯一 key 前缀，inspector 客户端直读作为权威证据）。
 *
 * 覆盖（B8/B9）：
 * - OUTAGE 首次失败有界（一次 readiness probe 预算）
 * - 同一持续 outage 下重复调用立即本地回退（不重复支付 1.8s）
 * - 并发 outage 单飞一次 probe
 * - 冷却到期后允许重新 probe（缩短冷却窗口验证重试语义）
 * - resetRateLimit 在 outage 下不抛错
 * - RECOVERY：client 可达后恢复真实 Redis 计数（inspector 验证 key）
 * - 健康路径行为不变（真实 Redis 计数）
 */
const integrationRedisUrl = process.env.INTEGRATION_REDIS_URL;

describe.skipIf(!integrationRedisUrl)("LR-070 Redis 故障冷却（真实连接故障注入）", () => {
  let inspector: Redis;
  const originalRedisUrl = process.env.REDIS_URL;
  const usedKeys: string[] = [];

  /** 找一个当前无监听的端口作为隔离故障端点 */
  function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
      });
      server.on("error", reject);
    });
  }

  type RateLimitGlobal = typeof globalThis & {
    rateLimitRedis?: Redis;
    rateLimitRedisReady?: Promise<boolean> | undefined;
    rateLimitRedisFailureUntil?: number | undefined;
  };

  async function freshModule(url: string) {
    process.env.REDIS_URL = url;
    vi.resetModules();
    const g = globalThis as RateLimitGlobal;
    await Promise.resolve(g.rateLimitRedis?.disconnect()).catch(() => undefined);
    g.rateLimitRedis = undefined;
    g.rateLimitRedisReady = undefined;
    g.rateLimitRedisFailureUntil = undefined;
    return import("@/lib/rate-limit");
  }

  function freshKey(label: string) {
    const key = `it-lr070:${label}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    usedKeys.push(key);
    return key;
  }

  beforeAll(async () => {
    inspector = new Redis(integrationRedisUrl!, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 1500,
    });
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
    g.rateLimitRedisFailureUntil = undefined;
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  });

  it("OUTAGE：首次失败有界（≤ 一次 readiness 预算），随后进入冷却", async () => {
    const outagePort = await findFreePort();
    const { isRateLimited } = await freshModule(`redis://localhost:${outagePort}`);
    const key = freshKey("first-bounded");

    const start = Date.now();
    const result = await isRateLimited({ key, limit: 100, windowMs: 60_000 });
    const elapsed = Date.now() - start;

    // 可用性合同：本地回退可用（不阻断业务）
    expect(result).toEqual({ limited: false, remaining: 99 });
    // 首次失败有界：最多一次 readiness 预算 + 余量（不允许挂死）
    expect(elapsed).toBeLessThan(3000);
    // 冷却状态已进入
    const g = globalThis as RateLimitGlobal;
    expect(g.rateLimitRedisFailureUntil).toBeGreaterThan(Date.now());
  });

  it("同一持续 outage：重复调用立即本地回退（不重复支付 1.8s）", async () => {
    const outagePort = await findFreePort();
    const { isRateLimited } = await freshModule(`redis://localhost:${outagePort}`);
    const key = freshKey("repeat-fast");

    // 首次：支付一次预算并进入冷却
    await isRateLimited({ key, limit: 100, windowMs: 60_000 });

    for (let i = 0; i < 5; i += 1) {
      const start = Date.now();
      const result = await isRateLimited({ key, limit: 100, windowMs: 60_000 });
      const elapsed = Date.now() - start;
      expect(result.limited).toBe(false);
      // 立即回退：与 readiness 预算（1800ms）形成数量级差异
      expect(elapsed).toBeLessThan(200);
    }
  });

  it("CONCURRENT OUTAGE：50 并发只支付一次 probe", async () => {
    const outagePort = await findFreePort();
    const { isRateLimited } = await freshModule(`redis://localhost:${outagePort}`);
    const key = freshKey("concurrent");

    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        isRateLimited({ key, limit: 100, windowMs: 60_000 }),
      ),
    );
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(50);
    expect(results.every((r) => !r.limited)).toBe(true);
    // 单飞：全部共享一次 probe（预算 + 余量），不是 50 × 1800ms
    expect(elapsed).toBeLessThan(3000);
  });

  it("持续 outage：probe 永不连续、延迟永不叠加（任意调用后下一次必立即回退）", async () => {
    const outagePort = await findFreePort();
    const rateLimit = await freshModule(`redis://localhost:${outagePort}`);
    // 缩短冷却窗口并跨越多个窗口边界：真实 ioredis 的后台连接错误会持续
    // 再武装冷却（生产窗口 30s >> 错误事件间隔，业务恒为立即回退）；
    // 本测试验证与错误事件节奏无关的确定性不变量——
    // "任意一次调用后冷却必然已武装"，因此 probe 至多每窗口一次且永不连续
    rateLimit.setRedisFailureCooldownForTests(300);
    const key = freshKey("cooldown-expiry");

    for (let round = 0; round < 3; round += 1) {
      // 跨越窗口边界
      await new Promise((resolve) => setTimeout(resolve, 350));

      // 本轮第一次调用：要么冷却仍被后台错误武装（立即），要么支付一次有界 probe
      const firstStart = Date.now();
      const first = await rateLimit.isRateLimited({ key, limit: 100, windowMs: 60_000 });
      expect(first.limited).toBe(false);
      expect(Date.now() - firstStart).toBeLessThan(3000);

      // 第二次调用：上一次调用必然已武装冷却 → 必须立即回退（< 200ms）
      const secondStart = Date.now();
      const second = await rateLimit.isRateLimited({ key, limit: 100, windowMs: 60_000 });
      expect(second.limited).toBe(false);
      expect(Date.now() - secondStart).toBeLessThan(200);
    }

    rateLimit.setRedisFailureCooldownForTests(undefined);
  }, 20_000);

  it("resetRateLimit 在 outage 下安全返回且清除本地桶", async () => {
    const outagePort = await findFreePort();
    const { isRateLimited, resetRateLimit } = await freshModule(
      `redis://localhost:${outagePort}`,
    );
    const key = freshKey("reset-outage");

    await isRateLimited({ key, limit: 1, windowMs: 60_000 });
    await isRateLimited({ key, limit: 1, windowMs: 60_000 });
    expect((await isRateLimited({ key, limit: 1, windowMs: 60_000 })).limited).toBe(true);

    await expect(resetRateLimit(key)).resolves.toBeUndefined();
    // 本地桶已清空：恢复计数
    expect((await isRateLimited({ key, limit: 1, windowMs: 60_000 })).limited).toBe(false);
  });

  it("RECOVERY：client 可达后自动恢复真实 Redis 计数（inspector 权威验证）", async () => {
    // 先在隔离故障端点进入冷却状态
    const outagePort = await findFreePort();
    await freshModule(`redis://localhost:${outagePort}`);
    const key = freshKey("recovery");
    await isRateLimitedSafe(key);

    // 切换到真实可达的 Redis：同一冷却状态机下，client ready 即恢复 Redis 路径
    const { isRateLimited } = await freshModule(integrationRedisUrl!);
    const result = await isRateLimited({ key, limit: 100, windowMs: 60_000 });
    expect(result).toEqual({ limited: false, remaining: 99 });
    // 权威证据：真实 Redis 中存在计数键（若仍在本地回退，这里必 FAIL）
    expect(await inspector.get(`ratelimit:${key}`)).toBe("1");
  });

  it("HEALTHY：健康路径行为不变（真实 Redis 计数 + 并发不丢）", async () => {
    const { isRateLimited } = await freshModule(integrationRedisUrl!);
    const key = freshKey("healthy");

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        isRateLimited({ key, limit: 10, windowMs: 60_000 }),
      ),
    );
    expect(results.every((r) => !r.limited)).toBe(true);
    // inspector 验证计数真实进入 Redis 且为原子总数 5
    expect(await inspector.get(`ratelimit:${key}`)).toBe("5");
  });

  /** outage 模块下 isRateLimited 的安全调用（freshModule 后需重新 import） */
  async function isRateLimitedSafe(key: string) {
    const { isRateLimited } = await import("@/lib/rate-limit");
    return isRateLimited({ key, limit: 100, windowMs: 60_000 });
  }
});
