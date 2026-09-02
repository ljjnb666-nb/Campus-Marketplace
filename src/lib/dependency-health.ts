/**
 * 依赖健康检查（TASK 4/5）：/api/ready 的探针实现。
 *
 * 语义契约（docs/OBSERVABILITY.md）：
 * - database：SELECT 1 轻量查询。失败 → not_ready（503），无 DB 无法服务任何业务。
 * - redis：PING。失败 → degraded（仍 200），见 REDIS_READINESS_POLICY：
 *   业务对 Redis 的唯一消费方是限流计数，故障时已有进程内本地降级
 *   （rate-limit.ts），系统能继续接流量，只削弱跨实例计数精确性。
 * - storage：HeadBucket 无副作用元数据探测（禁止上传测试对象）。
 *   失败 → not_ready（503），上传/私有资产交付是核心能力。
 *
 * 每个依赖独立 timeout + bounded 执行：一个依赖卡死不拖垮整体探测。
 * 失败产生结构化事件 dependency_health_failed（WARN/ERROR，脱敏后输出）；
 * 正常探测不产生 INFO 垃圾日志（避免 readiness polling 刷屏）。
 */
import { logger } from "@/lib/logger";
import { getRequestId } from "@/lib/request-context";
import { METRIC_NAMES, incrementCounter } from "@/lib/metrics";
import { getRedisClient } from "@/lib/rate-limit";
import { pingDatabase } from "@/repositories/health-repository";
import { env } from "@/lib/env";
import { getStorage } from "@/lib/storage";

export type DependencyName = "database" | "redis" | "storage";
export type DependencyStatus = "ok" | "degraded" | "failed";

export interface DependencyCheckResult {
  dependency: DependencyName;
  status: DependencyStatus;
  durationMs: number;
}

export interface ReadinessReport {
  status: "ready" | "degraded" | "not_ready";
  dependencies: Record<DependencyName, DependencyStatus>;
  checks: DependencyCheckResult[];
}

/** 单依赖默认探测预算（毫秒）；四项总预算 <= 5s 量级 */
const DEFAULT_CHECK_TIMEOUT_MS = 2000;

/** Redis 冷启动 ready 等待预算/轮询间隔（与 rate-limit 同语义） */
const REDIS_READY_BUDGET_MS = 1500;
const REDIS_READY_POLL_MS = 25;

export class DependencyTimeoutError extends Error {
  constructor(dependency: string) {
    super(`${dependency} health check timed out`);
    this.name = "DependencyTimeoutError";
  }
}

/** bounded 执行：超时立即放弃（底层操作可能仍在后台，但不拖住 readiness） */
async function withTimeout<T>(dependency: string, timeoutMs: number, op: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DependencyTimeoutError(dependency)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function checkDependency(
  dependency: DependencyName,
  degradedOnFailure: boolean,
  timeoutMs: number,
  probe: () => Promise<void>,
): Promise<DependencyCheckResult> {
  const startedAt = Date.now();
  try {
    await withTimeout(dependency, timeoutMs, probe);
    return { dependency, status: "ok", durationMs: Date.now() - startedAt };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const status: DependencyStatus = degradedOnFailure ? "degraded" : "failed";
    incrementCounter(METRIC_NAMES.dependencyReadinessFailures, { dependency });

    // 失败事件（TASK 5）：WARN/ERROR，经 logger redaction 脱敏；
    // 不输出 connection string / endpoint 凭据（error 序列化只保留必要信息，
    // 消息本身经 redactString 擦除 URL 内嵌密码/凭据形态）。
    const log = degradedOnFailure ? logger.warn : logger.error;
    log("依赖健康检查失败", "readiness", {
      event: "dependency_health_failed",
      dependency,
      status,
      durationMs,
      requestId: getRequestId(),
      errorName: error instanceof Error ? error.name : "unknown",
      error,
    });
    return { dependency, status, durationMs };
  }
}

export async function checkDatabase(
  timeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
): Promise<DependencyCheckResult> {
  return checkDependency("database", false, timeoutMs, () => pingDatabase());
}

export async function checkRedis(
  timeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
): Promise<DependencyCheckResult> {
  return checkDependency("redis", true, timeoutMs, async () => {
    const redis = getRedisClient();
    // 未配置 Redis = 本地限流模式，无依赖可言，不判定失败
    if (!redis) {
      return;
    }
    // 冷启动有界等待：enableOfflineQueue=false 下未 ready 的 client 会被
    // 直接拒绝（与 rate-limit 的 ensureRedisReady 同语义），
    // 避免"Redis 只是还没连上"被误判为故障
    const readyDeadline = Date.now() + REDIS_READY_BUDGET_MS;
    while (redis.status !== "ready") {
      if (redis.status === "end" || redis.status === "close" || Date.now() >= readyDeadline) {
        throw new Error(`redis not ready (status=${redis.status})`);
      }
      await new Promise((resolve) => setTimeout(resolve, REDIS_READY_POLL_MS));
    }
    const pong = await redis.ping();
    if (pong !== "PONG") {
      throw new Error("redis ping returned unexpected reply");
    }
  });
}

export async function checkStorage(
  timeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
): Promise<DependencyCheckResult> {
  return checkDependency("storage", false, timeoutMs, async () => {
    const reachable = await getStorage().headBucket(env.S3_BUCKET_PUBLIC);
    if (!reachable) {
      throw new Error("storage bucket not reachable");
    }
  });
}

/** 汇总 readiness 报告：db/storage 失败 → not_ready；仅 redis 降级 → degraded。 */
export async function runReadinessChecks(
  timeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
): Promise<ReadinessReport> {
  const [database, redis, storage] = await Promise.all([
    checkDatabase(timeoutMs),
    checkRedis(timeoutMs),
    checkStorage(timeoutMs),
  ]);

  const checks = [database, redis, storage];
  const dependencies: Record<DependencyName, DependencyStatus> = {
    database: database.status,
    redis: redis.status,
    storage: storage.status,
  };

  const status: ReadinessReport["status"] =
    database.status === "failed" || storage.status === "failed"
      ? "not_ready"
      : redis.status !== "ok"
        ? "degraded"
        : "ready";

  return { status, dependencies, checks };
}
