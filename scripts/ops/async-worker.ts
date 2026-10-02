/**
 * Phase 9A：统一生产 async worker（§31/§32/§33/§34/§39/§40）。
 *
 * 生产拓扑（compose.production.yml `async-worker` 服务：单实例、仅 backend
 * 网络、无端口发布、restart unless-stopped、依赖 PostgreSQL healthy）：
 *
 *   claim due jobs → execute（canonical domain lifecycle）
 *   → claim outbox events → dispatch（幂等派生 In-App 通知）
 *   → bounded sleep → repeat
 *
 * 设计约束（与 storage-cleanup worker 同一工程原则）：
 * - durable queue authority = PostgreSQL（SKIP LOCKED + lease token fencing）；
 *   Redis 仅是既有 ephemeral infra，worker 不依赖 Redis 也能正确运行（§35）；
 * - 单 job/event 失败只影响自身（RETRY / DEAD_LETTER），同 batch 后续继续
 *   （crash isolation，§33）；单周期整体失败记日志等下个周期，不 tight-loop；
 * - 配置级 fatal（env 非法）：exit non-zero，交给 container restart policy；
 * - graceful shutdown（§34/RB03，bounded）：第一次 SIGTERM/SIGINT → 停止新
 *   claim + 启动 shutdown deadline（ASYNC_WORKER_SHUTDOWN_GRACE_MS，默认
 *   15s；production 下限 1s / 上限 60s）；deadline 内当前周期完成 → exit 0；
 *   超时 → 记 async_worker_shutdown_timeout 并立即退出（未完成 job 绝不
 *   伪造 COMPLETED marker，其 RUNNING lease 过期后由 recovery 重放——无需
 *   JS 侧取消事务：进程退出 → 连接断开 → DB tx 回滚 → durable recovery）。
 *   第二次信号 → 立即强制退出（同样不伪造任何 marker）；
 * - backlog 可观测（§38/§40）：周期 summary 携带 queue stats（结构化日志），
 *   与 /api/ready 完全解耦——backlog > 0 不影响 web readiness。
 *
 * 手动运维（escape hatch，生产 topology 下经 ops 镜像执行）：
 *   docker compose --env-file .env.production -f compose.production.yml \
 *     run --rm async-worker --run-once
 *
 * 配置（生产下限防误配成 DB 风暴）：
 *   ASYNC_WORKER_POLL_MS              默认 1000（production 下限 250）
 *   ASYNC_WORKER_LEASE_SECONDS        默认 60（production 下限 30）
 *   ASYNC_WORKER_BATCH_SIZE           默认 10（production 上限 100）
 *   ASYNC_WORKER_SHUTDOWN_GRACE_MS    默认 15000（production 1000..60000；
 *                                     compose stop_grace_period: 20s 与之对齐）
 */

import "dotenv/config";

import { logger } from "@/lib/logger";
import { runAsyncJobBatchOnce } from "@/lib/async/job-runner";
import { runOutboxBatchOnce } from "@/lib/async/outbox-dispatcher";
import { getQueueStatsSnapshot } from "@/lib/async/queue-stats";

const DEFAULT_POLL_MS = 1000;
const MIN_PRODUCTION_POLL_MS = 250;
const DEFAULT_LEASE_SECONDS = 60;
const MIN_PRODUCTION_LEASE_SECONDS = 30;
const DEFAULT_BATCH_SIZE = 10;
const MAX_PRODUCTION_BATCH_SIZE = 100;
const DEFAULT_SHUTDOWN_GRACE_MS = 15_000;
const MIN_PRODUCTION_SHUTDOWN_GRACE_MS = 1_000;
const MAX_PRODUCTION_SHUTDOWN_GRACE_MS = 60_000;
/** 空转时每 N 个周期输出一次含 queue stats 的 heartbeat（避免刷屏） */
const HEARTBEAT_LOG_INTERVAL_CYCLES = 60;

interface WorkerConfig {
  pollMs: number;
  leaseSeconds: number;
  batchSize: number;
  shutdownGraceMs: number;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function resolvePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 必须是正整数，当前值：${raw}`);
  }
  return value;
}

/** 解析并校验 worker 配置；非法配置属进程级 fatal（exit non-zero）。 */
function resolveWorkerConfig(): WorkerConfig {
  const pollMs = resolvePositiveInt(
    process.env.ASYNC_WORKER_POLL_MS,
    DEFAULT_POLL_MS,
    "ASYNC_WORKER_POLL_MS",
  );
  const leaseSeconds = resolvePositiveInt(
    process.env.ASYNC_WORKER_LEASE_SECONDS,
    DEFAULT_LEASE_SECONDS,
    "ASYNC_WORKER_LEASE_SECONDS",
  );
  const batchSize = resolvePositiveInt(
    process.env.ASYNC_WORKER_BATCH_SIZE,
    DEFAULT_BATCH_SIZE,
    "ASYNC_WORKER_BATCH_SIZE",
  );
  const shutdownGraceMs = resolvePositiveInt(
    process.env.ASYNC_WORKER_SHUTDOWN_GRACE_MS,
    DEFAULT_SHUTDOWN_GRACE_MS,
    "ASYNC_WORKER_SHUTDOWN_GRACE_MS",
  );

  if (isProduction()) {
    if (pollMs < MIN_PRODUCTION_POLL_MS) {
      throw new Error(
        `ASYNC_WORKER_POLL_MS 生产环境下限为 ${MIN_PRODUCTION_POLL_MS}ms（当前值：${pollMs}），防止配置过小形成 DB 轮询风暴`,
      );
    }
    if (leaseSeconds < MIN_PRODUCTION_LEASE_SECONDS) {
      throw new Error(
        `ASYNC_WORKER_LEASE_SECONDS 生产环境下限为 ${MIN_PRODUCTION_LEASE_SECONDS}s（当前值：${leaseSeconds}）`,
      );
    }
    if (batchSize > MAX_PRODUCTION_BATCH_SIZE) {
      throw new Error(
        `ASYNC_WORKER_BATCH_SIZE 生产环境上限为 ${MAX_PRODUCTION_BATCH_SIZE}（当前值：${batchSize}）`,
      );
    }
    if (
      shutdownGraceMs < MIN_PRODUCTION_SHUTDOWN_GRACE_MS ||
      shutdownGraceMs > MAX_PRODUCTION_SHUTDOWN_GRACE_MS
    ) {
      throw new Error(
        `ASYNC_WORKER_SHUTDOWN_GRACE_MS 生产环境边界为 ${MIN_PRODUCTION_SHUTDOWN_GRACE_MS}..${MAX_PRODUCTION_SHUTDOWN_GRACE_MS}ms（当前值：${shutdownGraceMs}）`,
      );
    }
  }

  return { pollMs, leaseSeconds, batchSize, shutdownGraceMs };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CycleSummary {
  jobsClaimed: number;
  jobsCompleted: number;
  jobsRetried: number;
  jobsDeadLettered: number;
  outboxClaimed: number;
  outboxPublished: number;
  outboxRetried: number;
  outboxDeadLettered: number;
}

function summarize(
  jobSummary: Awaited<ReturnType<typeof runAsyncJobBatchOnce>>,
  outboxSummary: Awaited<ReturnType<typeof runOutboxBatchOnce>>,
): CycleSummary {
  return {
    jobsClaimed: jobSummary.claimed,
    jobsCompleted: jobSummary.completed + jobSummary.idempotentNoOp,
    jobsRetried: jobSummary.retried,
    jobsDeadLettered: jobSummary.deadLettered,
    outboxClaimed: outboxSummary.claimed,
    outboxPublished: outboxSummary.published,
    outboxRetried: outboxSummary.retried,
    outboxDeadLettered: outboxSummary.deadLettered,
  };
}

function didWork(summary: CycleSummary): boolean {
  return (
    summary.jobsClaimed > 0 ||
    summary.outboxClaimed > 0 ||
    summary.jobsRetried > 0 ||
    summary.outboxRetried > 0
  );
}

async function main() {
  const runOnce = process.argv.includes("--run-once");
  const config = resolveWorkerConfig();
  // RB03 shutdown 状态机：0 = running；1 = draining（deadline 已启动）；
  // 第二次信号 = 立即强制退出（绝不伪造 completion marker）。
  // 显式 number：闭包内赋值不受 TS 字面量收窄影响。
  let shutdownPhase: number = 0;
  let shutdownTimer: NodeJS.Timeout | null = null;

  process.on("SIGTERM", () => onShutdownSignal());
  process.on("SIGINT", () => onShutdownSignal());

  function onShutdownSignal() {
    if (shutdownPhase === 1) {
      // 第二次信号：立即强制退出。当前未完成 job 绝不标记成功——其 RUNNING
      // lease 过期后由 recovery 重放（durable，无需 JS 侧取消事务）
      logger.warn("收到第二次退出信号，立即强制退出", "async-worker", {
        event: "async_worker_shutdown_forced",
      });
      process.exit(1);
    }
    shutdownPhase = 1;
    logger.info("async worker 收到退出信号，停止新 claim，等待当前周期完成", "async-worker", {
      event: "async_worker_shutdown_signal",
      shutdownGraceMs: config.shutdownGraceMs,
    });
    // bounded drain：deadline 到点即退出（进程退出 → 连接断开 → DB tx 回滚
    // → lease 过期 recovery），绝不无限等待当前周期
    shutdownTimer = setTimeout(() => {
      logger.warn("shutdown grace 超时，退出（未完成 job 由 lease recovery 接管）", "async-worker", {
        event: "async_worker_shutdown_timeout",
        shutdownGraceMs: config.shutdownGraceMs,
      });
      process.exit(0);
    }, config.shutdownGraceMs);
    shutdownTimer.unref();
  }

  logger.info("async worker 启动", "async-worker", {
    event: "async_worker_started",
    mode: runOnce ? "run-once" : "loop",
    ...config,
  });

  let idleCycles = 0;

  do {
    let cycle: CycleSummary;
    try {
      // jobs 在前：本轮执行的 domain transition（如 reservation expiry）产生
      // 的 outbox event 在同周期即可被派发（run-once 语义对测试/运维可预期）
      const jobSummary = await runAsyncJobBatchOnce({
        leaseSeconds: config.leaseSeconds,
        batchSize: config.batchSize,
      });
      const outboxSummary = await runOutboxBatchOnce({
        leaseSeconds: config.leaseSeconds,
        batchSize: config.batchSize,
      });
      cycle = summarize(jobSummary, outboxSummary);
    } catch (error) {
      // 单周期失败（如 DB 闪断）：记录后等待下个周期重试（claim 幂等）
      logger.error("async worker 周期执行失败，等待下个周期重试", "async-worker", {
        event: "async_worker_cycle_failed",
        errorName: error instanceof Error ? error.name : "unknown",
      });
      if (runOnce) {
        process.exit(1);
      }
      await sleep(config.pollMs);
      continue;
    }

    if (didWork(cycle)) {
      idleCycles = 0;
      const stats = await getQueueStatsSnapshot().catch(() => null);
      logger.info("async worker 周期完成", "async-worker", {
        event: "async_worker_cycle_completed",
        ...cycle,
        ...(stats ? { queueStats: stats } : {}),
      });
    } else {
      idleCycles += 1;
      if (idleCycles % HEARTBEAT_LOG_INTERVAL_CYCLES === 0) {
        const stats = await getQueueStatsSnapshot().catch(() => null);
        logger.info("async worker heartbeat", "async-worker", {
          event: "async_worker_heartbeat",
          ...cycle,
          ...(stats ? { queueStats: stats } : {}),
        });
      }
    }

    if (runOnce || shutdownPhase === 1) {
      // deadline 内完成：清理 timer 后优雅退出（exit 0）
      if (shutdownTimer) {
        clearTimeout(shutdownTimer);
        shutdownTimer = null;
      }
      return;
    }
    await sleep(config.pollMs);
  } while (shutdownPhase === 0);
}

main()
  .then(() => {
    // graceful 退出路径（run-once 完成 / shutdown 后当前周期完成）
    process.exit(0);
  })
  .catch((error) => {
    // 进程级 fatal（配置/env 校验失败等）：exit non-zero，
    // 由 container restart policy 接管（compose restart: unless-stopped）
    console.error("[async-worker] fatal:", error);
    process.exit(1);
  });
