/**
 * FINAL REPAIR B — Part K 轻量延迟回归：healthy Redis 路径的限流调用延迟。
 * 冷却逻辑在 ready 路径上只增加一次同步检查（clearRedisFailureCooldown 判断），
 * 不应产生可观测延迟。运行：npx tsx scripts/resilience/healthy-redis-latency.ts
 */

import "dotenv/config";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

async function main() {
  const { isRateLimited } = await import("@/lib/rate-limit");

  const key = `perf-check:${Date.now()}`;
  const timings: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    const start = Date.now();
    await isRateLimited({ key, limit: 1000, windowMs: 60_000 });
    timings.push(Date.now() - start);
  }
  const total = timings.reduce((a, b) => a + b, 0);
  console.log(
    JSON.stringify({
      healthySerial10: { perCallMs: timings, totalMs: total, avgMs: total / 10 },
    }),
  );
  process.exit(0);
}

main();
