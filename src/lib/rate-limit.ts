import { Redis } from "ioredis";
import { logger } from "@/lib/logger";

export type RateLimitResult = {
  limited: boolean;
  remaining: number;
};

type LocalBucket = {
  count: number;
  resetAt: number;
};

/**
 * 限流计数器存储：
 * - 配置 REDIS_URL 时使用 Redis（多实例部署共享计数），原子 Lua 脚本
 *   保证 INCR 与首次设置过期窗口的原子性；
 * - 未配置或 Redis 不可用时回退进程内 Map（单实例语义），Redis 故障
 *   降级只削弱跨实例计数，不会阻断登录/上传主流程。
 *
 * 冷启动语义：新 client 尚未 ready（connecting/wait）时命令会被
 * enableOfflineQueue=false 直接拒绝。为避免"Redis 只是还没连上"被误判为
 * 故障，首次使用前做一次有界 readiness 等待（ensureRedisReady）：
 * 超过预算仍未 ready 才回退本地计数——正常环境冷启动只多等一次连接
 * 建立的时间，Redis 真故障时最多等待该预算后快速降级。
 */

const FIXED_WINDOW_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

const REDIS_KEY_PREFIX = "ratelimit:";

/** 冷启动 readiness 等待预算（毫秒）：覆盖正常连接建立，不放大故障等待 */
const REDIS_READY_BUDGET_MS = 1800;
const REDIS_READY_POLL_MS = 25;

const localBuckets = new Map<string, LocalBucket>();

declare global {
  var rateLimitRedis: Redis | undefined;
  // 单飞：并发请求共享同一次 readiness 等待，不各自重复等待
  var rateLimitRedisReady: Promise<boolean> | undefined;
}

/**
 * 获取进程内共享的 Redis 客户端（未配置 REDIS_URL 时为 null）。
 * Phase 4 起同时作为 readiness 探针（/api/ready）的连接来源，
 * 避免为探活再造第二套客户端/连接池。
 */
export function getRedisClient(): Redis | null {
  const url = process.env.REDIS_URL;

  if (!url) {
    return null;
  }

  if (!global.rateLimitRedis) {
    const client = new Redis(url, {
      // 故障时快速失败而不是排队挂起，保证限流检查不拖慢登录路径
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
      commandTimeout: 1500,
    });
    // 显式消费连接错误事件，避免 ioredis 未处理 error 事件的噪音
    client.on("error", (error) => {
      logger.warn("Redis 连接异常，限流回退本地计数", "rate-limit", {
        error: error.message,
      });
    });
    global.rateLimitRedis = client;
    global.rateLimitRedisReady = undefined;
  }

  return global.rateLimitRedis;
}

/**
 * 有界等待 client 进入 ready。
 * - 已 ready：立即返回 true；
 * - connecting/wait/reconnecting：轮询直至 ready 或预算耗尽；
 * - end/close（client 已死）：立即返回 false。
 * 等待单飞：并发请求共享同一 Promise；结束后清理句柄——ready 走快速
 * 路径，未 ready 允许下一轮请求重试（重连成功自动恢复 Redis 路径）。
 */
function ensureRedisReady(client: Redis): Promise<boolean> {
  if (client.status === "ready") {
    return Promise.resolve(true);
  }
  if (client.status === "end" || client.status === "close") {
    return Promise.resolve(false);
  }

  if (!global.rateLimitRedisReady) {
    global.rateLimitRedisReady = (async () => {
      const deadline = Date.now() + REDIS_READY_BUDGET_MS;
      while (Date.now() < deadline) {
        const status = client.status;
        if (status === "ready") {
          return true;
        }
        if (status === "end" || status === "close") {
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, REDIS_READY_POLL_MS));
      }
      return client.status === "ready";
    })().finally(() => {
      global.rateLimitRedisReady = undefined;
    });
  }

  return global.rateLimitRedisReady;
}

/** 进程内固定窗口（单实例回退实现）。每次检查时顺手清理过期桶。 */
function isRateLimitedLocally(options: {
  key: string;
  limit: number;
  windowMs: number;
}): RateLimitResult {
  const now = Date.now();

  for (const [key, bucket] of localBuckets) {
    if (now > bucket.resetAt) {
      localBuckets.delete(key);
    }
  }

  const bucket = localBuckets.get(options.key);

  if (!bucket || now > bucket.resetAt) {
    localBuckets.set(options.key, {
      count: 1,
      resetAt: now + options.windowMs,
    });
    return { limited: false, remaining: options.limit - 1 };
  }

  if (bucket.count >= options.limit) {
    return { limited: true, remaining: 0 };
  }

  bucket.count += 1;
  return { limited: false, remaining: options.limit - bucket.count };
}

type RedisAcquire<T> =
  | { ok: true; redis: Redis }
  | { ok: false; result: T };

/**
 * 取得已 ready 的 Redis；不可用时执行 fallback 并返回其结果。
 * 可用性优先：ready 等待有预算上限，绝不因 Redis 故障挂起登录/上传。
 */
async function acquireReadyRedis<T>(
  key: string,
  fallback: () => T,
): Promise<RedisAcquire<T>> {
  const redis = getRedisClient();

  if (!redis) {
    return { ok: false, result: fallback() };
  }

  const ready = await ensureRedisReady(redis);
  if (!ready) {
    logger.warn("Redis 未就绪，限流回退本地计数", "rate-limit", {
      key,
      status: redis.status,
    });
    return { ok: false, result: fallback() };
  }

  return { ok: true, redis };
}

export async function isRateLimited(options: {
  key: string;
  limit: number;
  windowMs: number;
}): Promise<RateLimitResult> {
  const acquired = await acquireReadyRedis(options.key, () =>
    isRateLimitedLocally(options),
  );

  if (!acquired.ok) {
    return acquired.result;
  }

  const redisKey = `${REDIS_KEY_PREFIX}${options.key}`;

  try {
    const count = (await acquired.redis.eval(
      FIXED_WINDOW_LUA,
      1,
      redisKey,
      options.windowMs,
    )) as number;

    return {
      limited: count > options.limit,
      remaining: Math.max(0, options.limit - count),
    };
  } catch (error) {
    // Redis 故障降级为本地计数：可用性优先于跨实例精确性
    logger.warn("Redis 限流查询失败，回退本地计数", "rate-limit", {
      key: options.key,
      error: error instanceof Error ? error.message : String(error),
    });
    return isRateLimitedLocally(options);
  }
}

/** 清除某个 key 的计数（例如登录成功后重置）。 */
export async function resetRateLimit(key: string): Promise<void> {
  localBuckets.delete(key);

  const acquired = await acquireReadyRedis(key, () => undefined);

  if (!acquired.ok) {
    return;
  }

  try {
    await acquired.redis.del(`${REDIS_KEY_PREFIX}${key}`);
  } catch (error) {
    logger.warn("Redis 限流重置失败", "rate-limit", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
