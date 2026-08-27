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
 */

const FIXED_WINDOW_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

const REDIS_KEY_PREFIX = "ratelimit:";

const localBuckets = new Map<string, LocalBucket>();

declare global {
  var rateLimitRedis: Redis | undefined;
}

function getRedisClient(): Redis | null {
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
  }

  return global.rateLimitRedis;
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

export async function isRateLimited(options: {
  key: string;
  limit: number;
  windowMs: number;
}): Promise<RateLimitResult> {
  const redis = getRedisClient();

  if (!redis) {
    return isRateLimitedLocally(options);
  }

  const redisKey = `${REDIS_KEY_PREFIX}${options.key}`;

  try {
    const count = (await redis.eval(
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

  const redis = getRedisClient();

  if (!redis) {
    return;
  }

  try {
    await redis.del(`${REDIS_KEY_PREFIX}${key}`);
  } catch (error) {
    logger.warn("Redis 限流重置失败", "rate-limit", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
