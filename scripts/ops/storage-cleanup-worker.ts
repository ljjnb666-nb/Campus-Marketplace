/**
 * 生产存储清理 + Phase 9 retention worker（FINAL REPAIR B 审计修复：
 * LR-071 OPS recovery；Phase 9C-04 §26 升级为 periodic cleanup / retention
 * cadence owner——不重命名生产服务，避免 topology drift）。
 *
 * 生产拓扑（compose.production.yml `storage-cleanup` 服务，单实例、仅
 * backend 网络、无端口发布）周期执行：
 *
 *   runStorageCleanup()                 → S3 对象 / 上传资源 / 导出 artifact 清理
 *   runPhase9RetentionMaintenance()     → Phase 9 retention / reconcile（9C-04）
 *
 * 设计约束：
 * - 不引入任何队列/调度框架：单机 compose MVP 的最小方案；
 * - 单周期失败：记日志、等待下个周期重试（cleanup/retention 全部幂等），
 *   不 tight-loop；
 * - Phase 9 retention 子任务失败（phase9Failures > 0）= 整周期 FAIL
 *  （§29）：记 errorName-only 失败日志、不打印成功 summary、run-once
 *   exit non-zero；各 transition 幂等，部分成功下轮继续安全；
 * - 配置级 fatal（interval 非法 / env 校验失败）：exit non-zero，交给
 *   container restart policy（compose `restart: unless-stopped`）；
 * - 观测：仅在产生实际工作（删除/标记/tombstone/redact/reconcile/失败 > 0）
 *   时输出 summary，空转周期不刷 INFO；summary 只含 counts（§28），绝不
 *   携带任何投递目的地/载荷/存储定位符/provider 原始响应/原始错误文案；
 * - 与 /api/ready 完全解耦：cleanup/retention backlog 是后台恢复，不是接
 *   流量的依赖（readiness 仍只看 DB/Redis/Storage；dead letter 不翻转
 *   readiness，§35）。
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
  // Phase 9C-04：Phase 9 retention/reconcile 观测（§28，counts only）
  asyncJobsTombstoned: number;
  outboxEventsTombstoned: number;
  notificationDeadLettersReconciled: number;
  notificationDestinationsRedacted: number;
  /** retention 子任务失败数（> 0 = 整周期 FAIL，§29） */
  phase9Failures: number;
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
  const storage = await runStorageCleanup({ dryRun });

  // Phase 9C-04（§26/§61）：同一 cadence owner 顺序执行 Phase 9
  // retention/reconcile。子任务级失败不抛出（部分成功幂等安全），以
  // phase9Failures 计数上交——调用方据其判定整周期 FAIL。
  const { runPhase9RetentionMaintenance } = await import("@/lib/async/retention");
  const phase9 = await runPhase9RetentionMaintenance({ dryRun });

  return {
    dryRun: storage.dryRun,
    orphansMarked: storage.orphansMarked,
    retentionExpiredMarked: storage.retentionExpiredMarked,
    retentionHoldBlocked: storage.retentionHoldBlocked,
    objectsDeleted: storage.objectsDeleted,
    quotaReleasedBytes: storage.quotaReleasedBytes,
    purgeHoldBlocked: storage.purgeHoldBlocked,
    failures: storage.failures,
    dataExportArtifactsMarked: storage.dataExportArtifactsMarked,
    dataExportObjectsDeleted: storage.dataExportObjectsDeleted,
    dataExportFailures: storage.dataExportFailures,
    asyncJobsTombstoned: phase9.asyncJobsTombstoned,
    outboxEventsTombstoned: phase9.outboxEventsTombstoned,
    notificationDeadLettersReconciled: phase9.notificationDeadLettersReconciled,
    notificationDestinationsRedacted: phase9.notificationDestinationsRedacted,
    phase9Failures: phase9.phase9Failures,
  };
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
    summary.failures > 0 ||
    summary.asyncJobsTombstoned > 0 ||
    summary.outboxEventsTombstoned > 0 ||
    summary.notificationDeadLettersReconciled > 0 ||
    summary.notificationDestinationsRedacted > 0 ||
    summary.phase9Failures > 0;
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

    // Phase 9C-04（§29）：retention 子任务失败 = 整周期 FAIL——绝不打印
    // 成功 summary；全部 transition 幂等，部分成功下轮继续安全。
    if (summary.phase9Failures > 0) {
      logger.error("Phase 9 retention 子任务失败，本周期按失败处理，等待下轮重试", "storage-cleanup-worker", {
        event: "phase9_retention_cycle_failed",
        intervalSeconds,
        errorName: "Phase9RetentionSubtaskFailure",
        phase9Failures: summary.phase9Failures,
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
