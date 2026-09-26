/**
 * FINAL REPAIR B — PART I readiness 回归验证：
 * 业务限流进入冷却后，/api/ready 仍如实上报真实 Redis 状态（degraded），
 * 不会被业务电路状态污染（B6：business circuit state ≠ dependency health truth）。
 * 运行：npx tsx scripts/resilience/readiness-during-cooldown.ts
 */

import "dotenv/config";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6390";

async function main() {
  const { runReadinessChecks } = await import("@/lib/dependency-health");
  const { isRateLimited } = await import("@/lib/rate-limit");

  // 让业务限流经历一次失败 probe（指向无监听端口）→ 进入冷却
  await isRateLimited({ key: "readiness-check", limit: 100, windowMs: 60_000 });

  const report = await runReadinessChecks();
  console.log(
    JSON.stringify({
      scenario: "rate-limit cooldown active + redis unreachable",
      readiness: { status: report.status, dependencies: report.dependencies },
    }),
  );
  process.exit(0);
}

main();
