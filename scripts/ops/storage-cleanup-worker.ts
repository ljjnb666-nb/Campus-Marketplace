/**
 * 生产存储清理 worker（FINAL REPAIR B 审计修复：LR-071 OPS recovery）。
 *
 * 生产拓扑（compose.production.yml `storage-cleanup` 服务，单实例、仅
 * backend 网络、无端口发布）周期执行既有 `runStorageCleanup`：
 *
 *   run cleanup → record result → sleep bounded interval → repeat
 *
 * 设计约束：
 * - 不引入任何队列/调度框架：单机 compose MVP 的最小方案；
 * - 单周期失败：记日志、等待下个周期重试（cleanup 幂等），不 tight-loop；
 * - 配置级 fatal（interval 非法 / env 校验失败）：exit non-zero，交给
 *   container restart policy（compose `restart: unless-stopped`）；
 * - 观测：仅在产生实际工作（删除/标记/失败 > 0）时输出 summary，
 *   空转周期不刷 INFO；
 * - 与 /api/ready 完全解耦：cleanup backlog 是后台恢复，不是接流量的
 *   依赖（readiness 仍只看 DB/Redis/Storage）。
 *
 * 手动运维（escape hatch，生产 topology 下通过 ops 镜像执行，无需宿主机
 * 完整 node_modules）：
 *   docker compose --env-file .env.production -f compose.production.yml \
 *     run --rm storage-cleanup --run-once            # 立即执行一轮后退出
 *   docker compose --env-file .env.production -f compose.production.yml \
 *     run --rm storage-cleanup --run-once --dry-run  # 只打印计划不执行
 *
 * 周期（秒）：ASSET_CLEANUP_INTERVAL_SECONDS（默认 1800；production 下
 * 下限 60，防止误配成 1s 形成 DB/S3 风暴；非生产放宽到 >=1 供验证）。
 */

import "dotenv/config";

import { logger } from "@/lib/logger";

const DEFAULT_INTERVAL_SECONDS = 1800;
const MIN_PRODUCTION_INTERVAL_SECONDS = 60;

interface CycleSummary {
  dryRun: boolean;
  orphansMarked: number;
  retentionExpiredMarked: number;
  retentionHoldBlocked: number;
  objectsDeleted: number;
  quotaReleasedBytes: number;
  purgeHoldBlocked: number;
  failures: number;
  // Phase 9C-03：导出 artifact 清理观测（到期/stale 标记 + 物理删除）
  dataExportArtifactsMarked: number;
  dataExportObjectsDeleted: number;
  dataExportFailures: number;
}

/** 解析并校验周期配置；非法配置属进程级 fatal（exit non-zero）。 */
function resolveIntervalSeconds(): number {
  const raw = process.env.ASSET_CLEANUP_INTERVAL_SECONDS;
  if (raw === undefined || raw === "") {
    return DEFAULT_INTERVAL_SECONDS;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `ASSET_CLEANUP_INTERVAL_SECONDS 必须是正整数，当前值：${raw}`,
    );
  }
  if (
    process.env.NODE_ENV === "production" &&
    value < MIN_PRODUCTION_INTERVAL_SECONDS
  ) {
    throw new Error(
      `ASSET_CLEANUP_INTERVAL_SECONDS 生产环境下限为 ${MIN_PRODUCTION_INTERVAL_SECONDS}s（当前值：${value}），防止配置过小形成 DB/S3 风暴`,
    );
  }
  return value;
}

async function runCycle(dryRun: boolean): Promise<CycleSummary> {
  const { runStorageCleanup } = await import("@/lib/asset-cleanup");
  return runStorageCleanup({ dryRun });
}

/** 仅在产生实际工作时输出 summary（空转周期不刷日志）。
 * hold 阻塞属于受控 business/governance block（INV-11）：计入 summary 观测，
 * 既不是失败也不触发非零退出/紧重试。 */
function logSummaryIfWorked(summary: CycleSummary): void {
  const didWork =
    summary.objectsDeleted > 0 ||
    summary.orphansMarked > 0 ||
    summary.dataExportArtifactsMarked > 0 ||
    summary.dataExportObjectsDeleted > 0 ||
    summary.dataExportFailures > 0 ||
    summary.retentionExpiredMarked > 0 ||
    summary.retentionHoldBlocked > 0 ||
    summary.purgeHoldBlocked > 0 ||
    summary.failures > 0;
  if (!didWork) {
    return;
  }
  logger.info("存储清理周期完成", "storage-cleanup-worker", {
    event: "storage_cleanup_cycle_completed",
    ...summary,
  });
}

async function main() {
  const runOnce = process.argv.includes("--run-once");
  const dryRun = process.argv.includes("--dry-run");
  const intervalSeconds = resolveIntervalSeconds();

  logger.info("存储清理 worker 启动", "storage-cleanup-worker", {
    event: "storage_cleanup_worker_started",
    mode: runOnce ? "run-once" : "loop",
    dryRun,
    intervalSeconds,
  });

  do {
    let summary: CycleSummary;
    try {
      summary = await runCycle(dryRun);
    } catch (error) {
      // 单周期失败：记录后等待下个周期重试（cleanup 幂等，不 tight-loop）
      logger.error("存储清理周期执行失败，等待下个周期重试", "storage-cleanup-worker", {
        event: "storage_cleanup_cycle_failed",
        intervalSeconds,
        errorName: error instanceof Error ? error.name : "unknown",
      });
      if (runOnce) {
        process.exit(1);
      }
      await sleep(intervalSeconds * 1000);
      continue;
    }

    logSummaryIfWorked(summary);

    if (runOnce) {
      return;
    }
    await sleep(intervalSeconds * 1000);
  } while (true);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  // 进程级 fatal（配置/env 校验失败等）：exit non-zero，
  // 由 container restart policy 接管（compose restart: unless-stopped）
  console.error("[storage-cleanup-worker] fatal:", error);
  process.exit(1);
});
