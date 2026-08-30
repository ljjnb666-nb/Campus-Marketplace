import { Redis } from "ioredis";

/**
 * 测试内清理限流计数（GF1 注册用）：注册限流 5 次/小时/IP，
 * 连续多轮跑套件时 setup 只在开头清一次，后续轮次会撞限流。
 * 只删 ratelimit:* 前缀键，不动其它数据。
 */
export async function flushRateLimits(): Promise<void> {
  const redisUrl = process.env.E2E_REDIS_URL ?? "redis://localhost:6379";
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    lazyConnect: true,
  });

  try {
    await redis.connect();
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "ratelimit:*", "COUNT", 100);
      cursor = next;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
  } catch {
    // Redis 不可用时静默跳过（应用会回退进程内限流，首轮仍可注册）
  } finally {
    redis.disconnect();
  }
}
