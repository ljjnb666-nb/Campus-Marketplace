type RateLimitBucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, RateLimitBucket>();

export type RateLimitResult = {
  limited: boolean;
  remaining: number;
};

/**
 * 进程内固定窗口限流器（单进程部署足够，无需 Redis）。
 * 每次检查时顺手清理过期桶，避免长驻进程无限积累陈旧 key。
 */
export function isRateLimited(options: {
  key: string;
  limit: number;
  windowMs: number;
}): RateLimitResult {
  const now = Date.now();

  // Lazy pruning: sweeping expired buckets on every call keeps the Map size
  // bounded by the number of keys active within the current window.
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) {
      buckets.delete(key);
    }
  }

  const bucket = buckets.get(options.key);

  if (!bucket || now > bucket.resetAt) {
    buckets.set(options.key, {
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

/** 清除某个 key 的计数（例如登录成功后重置）。 */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}
