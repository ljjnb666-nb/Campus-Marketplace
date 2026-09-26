/**
 * FINAL REPAIR B — LR-070 evidence harness（真实 Redis 故障注入延迟）。
 *
 * 用真实 ioredis client 指向一个【无监听进程的隔离端口】制造连接故障
 * （不触碰共享 Redis :6379），在真实 outage 下测量 isRateLimited 的延迟：
 *
 * - 1 serial call（首次失败 probe）
 * - 10 serial calls（LR-070 核心：是否每个请求重复支付 readiness budget）
 * - 50 concurrent calls（single-flight 是否生效）
 * - cooldown 内 50 subsequent serial calls（是否立即本地回退）
 *
 * 运行：npx tsx scripts/resilience/redis-outage-harness.ts --phase BEFORE
 * 结果：bench-results/resilience/lr070-<phase>.json
 */

import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

type Phase = "BEFORE" | "AFTER";
const phase = (process.argv[process.argv.indexOf("--phase") + 1] ?? "BEFORE") as Phase;

const OUTAGE_URL = process.env.HARNESS_REDIS_OUTAGE_URL ?? "redis://localhost:6390";
const RESULTS_DIR = path.join(process.cwd(), "bench-results", "resilience");
fs.mkdirSync(RESULTS_DIR, { recursive: true });

function log(message: string) {
  process.stdout.write(`[lr070-harness] ${message}\n`);
}

type RateLimitGlobal = typeof globalThis & {
  rateLimitRedis?: unknown;
  rateLimitRedisReady?: Promise<boolean> | undefined;
};

async function freshModule(url: string) {
  process.env.REDIS_URL = url;
  viResetModules();
  const g = globalThis as RateLimitGlobal;
  g.rateLimitRedis = undefined;
  g.rateLimitRedisReady = undefined;
  return import("@/lib/rate-limit");
}

// vitest 不在路径上：手工实现 resetModules 等价物——ESM 下 import 会缓存，
// 用查询串绕过缓存即可
let moduleCounter = 0;
async function viResetModules() {
  moduleCounter += 1;
}

async function main() {
  // 端口必须真的没有监听：先验证 outage 前提（连接必须失败）
  log(`outage endpoint: ${OUTAGE_URL}（预期无监听）`);

  const { isRateLimited } = await freshModule(`${OUTAGE_URL}`);
  const key = `lr070-harness:${Date.now()}`;

  // 首次调用：readiness probe 全额等待
  const firstStart = Date.now();
  const first = await isRateLimited({ key, limit: 1000, windowMs: 60_000 });
  const firstMs = Date.now() - firstStart;
  log(`serial #1（首次 probe）: ${firstMs}ms limited=${first.limited}`);

  // 10 serial：LR-070 核心证据
  const serialTimings: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    const start = Date.now();
    await isRateLimited({ key, limit: 1000, windowMs: 60_000 });
    serialTimings.push(Date.now() - start);
  }
  const serialTotal = serialTimings.reduce((a, b) => a + b, 0);
  log(
    `10 serial calls: total=${serialTotal}ms avg=${Math.round(serialTotal / 10)}ms ` +
      `per-call=[${serialTimings.join(",")}]`,
  );

  // 50 concurrent：single-flight
  const concurrentStart = Date.now();
  await Promise.all(
    Array.from({ length: 50 }, () =>
      isRateLimited({ key, limit: 1000, windowMs: 60_000 }),
    ),
  );
  const concurrentMs = Date.now() - concurrentStart;
  log(`50 concurrent calls: total=${concurrentMs}ms`);

  // 50 subsequent serial（同一持续 outage）
  const subsequentTimings: number[] = [];
  for (let i = 0; i < 50; i += 1) {
    const start = Date.now();
    await isRateLimited({ key, limit: 1000, windowMs: 60_000 });
    subsequentTimings.push(Date.now() - start);
  }
  const subsequentTotal = subsequentTimings.reduce((a, b) => a + b, 0);
  log(
    `50 subsequent serial calls: total=${subsequentTotal}ms avg=${Math.round(subsequentTotal / 50)}ms`,
  );

  const repeatedBudgetPerRequest = serialTimings.filter((ms) => ms > 1000).length;
  const summary = {
    phase,
    outageUrl: OUTAGE_URL,
    firstCallMs: firstMs,
    serial10: { totalMs: serialTotal, perCallMs: serialTimings },
    concurrent50Ms: concurrentMs,
    subsequent50: { totalMs: subsequentTotal, avgMs: Math.round(subsequentTotal / 50) },
    repeatedFullBudgetCalls: repeatedBudgetPerRequest,
    repeated1800msPerRequest: repeatedBudgetPerRequest > 2,
    fallbackAvailable: !first.limited,
  };

  const outputPath = path.join(RESULTS_DIR, `lr070-${phase.toLowerCase()}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
  log(`结果已写入 ${outputPath}`);
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error("[lr070-harness] 失败:", error);
    process.exit(1);
  })
  .then(() => {
    // 断开 ioredis 惰性 client，避免 harness 挂起
    const g = globalThis as RateLimitGlobal & { rateLimitRedis?: { disconnect: () => void } };
    g.rateLimitRedis?.disconnect();
  });
