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
 *
 * 失败冷却（LR-070）：readiness probe 或命令失败后进入一段有界冷却窗口
 * （REDIS_FAILURE_COOLDOWN_MS），窗口内的请求不再重复支付 readiness
 * 预算，立即走本地计数——持续故障下不会每个请求都等 ~1.8s。
 * 恢复语义：client 一旦真正 ready（ioredis 自身重连成功），下一个请求
 * 立即恢复 Redis 路径并清除冷却状态——恢复不等冷却到期。
 * 冷却只在"健康→失败"跳变时记录一次结构化事件（不逐请求 WARN，
 * 不输出 rate-limit key：key 可能含 email 等用户派生标识）。
 * /api/ready 的 Redis 健康探测独立于本冷却状态（dependency-health.ts
 * 直接 PING），业务降级不会让 readiness 误报 Redis 健康。
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
export const REDIS_READY_BUDGET_MS = 1800;
const REDIS_READY_POLL_MS = 25;

/**
 * 失败冷却窗口（毫秒）：probe/命令失败后的短期抑制窗口。
 * 固定值（非无限 backoff）：到期后允许下一次 readiness probe 重试，
 * 故障恢复最坏延迟 = 冷却窗口；真实恢复（client ready）不受窗口限制。
 */
export const REDIS_FAILURE_COOLDOWN_MS = 30_000;

const localBuckets = new Map<string, LocalBucket>();

declare global {
  var rateLimitRedis: Redis | undefined;
  // 单飞：并发请求共享同一次 readiness 等待，不各自重复等待
  var rateLimitRedisReady: Promise<boolean> | undefined;
  // 失败冷却：0 = 无冷却；否则为冷却到期时间戳（Date.now() 基准）
  var rateLimitRedisFailureUntil: number | undefined;
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
    global.rateLimitRedisFailureUntil = undefined;
  }

  return global.rateLimitRedis;
}

/**
 * 进入失败冷却（只在健康→失败跳变时记一次结构化事件）。
 * 日志不含 rate-limit key（key 可能是 email 等用户派生标识）。
 */
function enterRedisFailureCooldown(reason: string, detail: string): void {
  const now = Date.now();
  const failureUntil = now + activeCooldownMs();
  if (global.rateLimitRedisFailureUntil && global.rateLimitRedisFailureUntil > now) {
    // 已在冷却窗口内：不重复记事件、不刷新窗口（固定有界）
    return;
  }
  global.rateLimitRedisFailureUntil = failureUntil;
  logger.warn("Redis 限流进入短期降级冷却", "rate-limit", {
    event: "redis_rate_limit_degraded",
    reason,
    detail,
    cooldownMs: activeCooldownMs(),
  });
}

/** 冷却结束或 client 恢复 ready 时清除冷却状态（恢复只记一次事件）。 */
function clearRedisFailureCooldown(): void {
  if (global.rateLimitRedisFailureUntil) {
    global.rateLimitRedisFailureUntil = undefined;
    logger.info("Redis 限流恢复 Redis 路径", "rate-limit", {
      event: "redis_rate_limit_recovered",
    });
  }
}

/** 是否处于失败冷却窗口内（窗口到期自动视为不在冷却）。 */
function isRedisFailureCooldownActive(): boolean {
  const failureUntil = global.rateLimitRedisFailureUntil;
  return failureUntil !== undefined && failureUntil > Date.now();
}

/**
 * 测试专用：缩短冷却窗口（真实 Redis 故障注入集成测试需要在秒级验证
 * "冷却到期后允许重新 probe"）。生产代码不得调用。
 */
export function setRedisFailureCooldownForTests(ms: number | undefined): void {
  cooldownOverrideMs = ms;
}

let cooldownOverrideMs: number | undefined;

function activeCooldownMs(): number {
  return cooldownOverrideMs ?? REDIS_FAILURE_COOLDOWN_MS;
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
 *
 * 冷却语义（LR-070）：
 * - client 已 ready：立即使用（并顺带清除冷却状态）——真实恢复不被
 *   冷却窗口阻塞；
 * - 冷却窗口内且未 ready：立即本地回退，不再支付 readiness 预算；
 * - 冷却窗口外且未 ready：单飞执行一次 readiness probe；失败则进入
 *   冷却（只记一次事件），成功则正常使用。
 */
async function acquireReadyRedis<T>(
  fallback: () => T,
): Promise<RedisAcquire<T>> {
  const redis = getRedisClient();

  if (!redis) {
    return { ok: false, result: fallback() };
  }

  if (redis.status === "ready") {
    clearRedisFailureCooldown();
    return { ok: true, redis };
  }

  if (isRedisFailureCooldownActive()) {
    // 冷却窗口内：立即本地回退（不等待、不重复记日志）
    return { ok: false, result: fallback() };
  }

  const ready = await ensureRedisReady(redis);
  if (!ready) {
    enterRedisFailureCooldown(
      "readiness_probe_failed",
      `status=${redis.status}`,
    );
    return { ok: false, result: fallback() };
  }

  return { ok: true, redis };
}

export async function isRateLimited(options: {
  key: string;
  limit: number;
  windowMs: number;
}): Promise<RateLimitResult> {
  const acquired = await acquireReadyRedis(() => isRateLimitedLocally(options));

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
    // Redis 故障降级为本地计数：可用性优先于跨实例精确性。
    // 命令级连接故障同样进入短期冷却（B4）：否则持续故障下每个请求都会
    // 重新打一次已知故障的 Redis。tradeoff：无法可靠区分连接故障与
    // 编程错误（invalid Lua 等）——后者也会被短期降级，但冷却固定有界、
    // 到期自动重试，最坏影响是 30s 内本地计数，不会静默永久降级。
    enterRedisFailureCooldown(
      "command_failed",
      error instanceof Error ? error.name : "unknown",
    );
    return isRateLimitedLocally(options);
  }
}

/** 清除某个 key 的计数（例如登录成功后重置）。 */
export async function resetRateLimit(key: string): Promise<void> {
  localBuckets.delete(key);

  const acquired = await acquireReadyRedis(() => undefined);

  if (!acquired.ok) {
    return;
  }

  try {
    await acquired.redis.del(`${REDIS_KEY_PREFIX}${key}`);
  } catch (error) {
    enterRedisFailureCooldown(
      "command_failed",
      error instanceof Error ? error.name : "unknown",
    );
  }
}
