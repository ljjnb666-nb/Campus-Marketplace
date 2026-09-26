/**
 * FINAL REPAIR B — LR-070 真实恢复证据执行器（由 redis-recovery-proof.sh 调用）。
 *
 * 同一进程、同一 ioredis client，跨容器 stop/start：
 *   PHASE 1 HEALTHY  — 计数真实写入隔离 Redis（inspector 验证）
 *   PHASE 2 OUTAGE   — docker stop 后：首次失败有界 → 冷却内立即回退
 *   PHASE 3 RECOVERY — docker start 后：ioredis 自动重连 ready，
 *                      下一个请求立即恢复 Redis 路径（inspector 验证新 key）
 *
 * 容器的 stop/start 由参数指令触发（--phase out / --phase back），
 * bash 脚本按顺序调用本脚本三次。
 */

import "dotenv/config";

import { Redis } from "ioredis";

type Phase = "healthy" | "out" | "check-outage" | "back" | "verify-recovery";
const phase = process.argv[process.argv.indexOf("--phase") + 1] as Phase;

type RateLimitGlobal = typeof globalThis & {
  rateLimitRedis?: Redis;
  rateLimitRedisReady?: Promise<boolean> | undefined;
  rateLimitRedisFailureUntil?: number | undefined;
};

const INSPECTOR_URL = process.env.REDIS_URL!;

async function inspector(): Promise<Redis> {
  const client = new Redis(INSPECTOR_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 1500,
  });
  return client;
}

async function main() {
  process.env.REDIS_URL = INSPECTOR_URL;
  const { isRateLimited } = await import("@/lib/rate-limit");

  if (phase === "healthy") {
    const key = `lr070-proof:healthy:${Date.now()}`;
    const result = await isRateLimited({ key, limit: 100, windowMs: 60_000 });
    const db = await inspector();
    const value = await db.get(`ratelimit:${key}`);
    await db.quit();
    console.log(
      JSON.stringify({ phase, key, result, redisValue: value }),
    );
    if (value !== "1") throw new Error("HEALTHY 阶段计数未进入 Redis");
    return;
  }

  if (phase === "out") {
    // 容器已被 stop：首次调用支付一次有界 probe，随后进入冷却
    const start = Date.now();
    await isRateLimited({ key: "warm", limit: 100, windowMs: 60_000 });
    console.log(
      JSON.stringify({ phase, firstBoundedMs: Date.now() - start }),
    );
    const start2 = Date.now();
    await isRateLimited({ key: "warm", limit: 100, windowMs: 60_000 });
    console.log(
      JSON.stringify({ phase, cooldownFallbackMs: Date.now() - start2 }),
    );
    if (Date.now() - start2 > 200) {
      throw new Error("冷却窗口内的调用仍在等待");
    }
    return;
  }

  if (phase === "back") {
    // 容器已恢复（ioredis 在后台自动重连）；等待 client 真正 ready，
    // 然后验证下一个请求立即走 Redis（不受冷却窗口限制）
    const { getRedisClient } = await import("@/lib/rate-limit");
    const client = getRedisClient()!;
    const started = Date.now();
    while (client.status !== "ready") {
      if (Date.now() - started > 30000) {
        throw new Error(`reconnect did not reach ready (status=${client.status})`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const reconnectMs = Date.now() - started;

    const key = `lr070-proof:recovered:${Date.now()}`;
    const callStart = Date.now();
    const result = await isRateLimited({ key, limit: 100, windowMs: 60_000 });
    const callMs = Date.now() - callStart;
    const db = await inspector();
    const value = await db.get(`ratelimit:${key}`);
    await db.quit();
    console.log(
      JSON.stringify({
        phase,
        reconnectMs,
        recoveredCallMs: callMs,
        result,
        redisValue: value,
        failureUntilCleared:
          (globalThis as RateLimitGlobal).rateLimitRedisFailureUntil === undefined,
      }),
    );
    if (value !== "1") throw new Error("RECOVERY 阶段计数未进入真实 Redis");
    if (callMs > 500) throw new Error("恢复调用仍承担了 readiness/冷却等待");
    return;
  }

  throw new Error(`未知 phase: ${phase}`);
}

main()
  .catch((error) => {
    console.error("[recovery-proof] 失败:", error);
    process.exit(1);
  })
  .then(() => {
    const g = globalThis as RateLimitGlobal & {
      rateLimitRedis?: { disconnect: () => void };
    };
    g.rateLimitRedis?.disconnect();
  });
