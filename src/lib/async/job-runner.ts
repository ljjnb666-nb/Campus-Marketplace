import { logger } from "@/lib/logger";
import { prisma, withTransaction, TRANSACTION_TIMEOUT_MS } from "@/lib/prisma";
import { resolveJobHandler, resolveJobExecutionPolicy } from "@/lib/async/job-registry";
import {
  beginAsyncJobExecutionTx,
  claimDueAsyncJobs,
  completeAsyncJob,
  createWorkerId,
  failAsyncJob,
  rescheduleAsyncJob,
} from "@/lib/async/job-repository";
import {
  classifyJobFailure,
  jobErrorCode,
  jobErrorMessage,
  type ClaimedAsyncJob,
} from "@/lib/async/job-types";

/**
 * Phase 9A：AsyncJob runner（§24/§26/§31/§33/§39/§40；RB01 execution fencing）。
 *
 * 职责边界：wake up → execution fencing → invoke canonical domain lifecycle
 * （handler）→ 条件落 completion marker。runner 绝不直接 UPDATE Order/Product。
 *
 * RB01（STALE WORKER MUST NOT ENTER DOMAIN HANDLER SIDE EFFECTS）：
 * execution ownership 复核（beginAsyncJobExecutionTx 条件 UPDATE，命中即刷新
 * lease 并取得行锁）必须与 handler 在【同一个数据库事务】内执行——行锁保持到
 * 该事务 COMMIT，期间其它 worker 的 FOR UPDATE SKIP LOCKED 必须跳过该行。
 * 仅 fence completion（旧合同）不足以阻止 stale worker 进入 domain 副作用。
 * begin 未命中（lease 已被他人回收/覆盖）→ handler 绝不运行，domain side
 * effects = 0。
 *
 * crash isolation（§33）：单个 job 的 handler throw / completion 失败只影响
 * 该 job（RETRY / DEAD_LETTER），同 batch 后续 job 继续执行；仅配置级 fatal
 * （env 非法，worker entrypoint 层）才允许进程退出。
 *
 * crash-replay 安全（§57，合同保持不变）：execution fencing + domain side
 * effects 同事务 COMMIT；COMPLETED marker 仍在 domain commit 之后单独条件写
 * ——worker 在业务提交后、marker 落库前崩溃 → lease 过期回收 → handler 重放
 * NOT_PENDING → COMPLETED_IDEMPOTENT，最终 COMPLETED 且副作用恰好一次。
 *
 * test seams（§70）：仅测试注入（生产不传），用于 claim 后 / 业务事务提交后 /
 * completion 前的受控暂停；禁止以 sleep 作为并发证明。
 */

export type JobRunnerSeams = {
  afterClaim?: (claimed: readonly ClaimedAsyncJob[]) => Promise<void>;
  /** 模拟"业务事务已 COMMIT 但 completion marker 未落库"的 crash 点。 */
  afterJobTxCommit?: (job: ClaimedAsyncJob) => Promise<void>;
  beforeCompletion?: (job: ClaimedAsyncJob) => Promise<void>;
};

export type RunAsyncJobBatchInput = {
  batchSize?: number;
  leaseSeconds?: number;
  workerId?: string;
  seams?: JobRunnerSeams;
  now?: Date;
};

export type JobBatchSummary = {
  claimed: number;
  leaseRecovered: number;
  completed: number;
  idempotentNoOp: number;
  rescheduled: number;
  retried: number;
  deadLettered: number;
  /** completion/reschedule 阶段被 fence（stale completion，旧合同保留）。 */
  fenced: number;
  /** RB01：execution fence 未命中——handler 从未进入（domain side effects = 0）。 */
  fencedBeforeExecution: number;
};

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LEASE_SECONDS = 60;

function logJob(event: string, job: ClaimedAsyncJob, extra: Record<string, unknown>): void {
  logger.info(event, "async-job-runner", {
    event,
    jobId: job.id,
    kind: job.kind,
    schemaVersion: job.schemaVersion,
    attempt: job.attempts,
    ...extra,
  });
}

/** 单个 claimed job 的生产执行结果（batch 汇总与 J-LEASE-03 直调共用合同）。 */
export type ClaimedJobExecutionResult = {
  fencedBeforeExecution: boolean;
  completed: boolean;
  idempotentNoOp: boolean;
  rescheduled: boolean;
  retried: boolean;
  deadLettered: boolean;
  fenced: boolean;
};

const NO_SIDE_EFFECT_RESULT: ClaimedJobExecutionResult = {
  fencedBeforeExecution: false,
  completed: false,
  idempotentNoOp: false,
  rescheduled: false,
  retried: false,
  deadLettered: false,
  fenced: false,
};

/**
 * 生产 execution path（RB01）：fence → handler → completion marker。
 * 供 batch 循环与 RB01 测试直调（同一合同，禁止测试复制实现）。
 */
export async function executeClaimedAsyncJob(
  job: ClaimedAsyncJob,
  options: { leaseSeconds?: number; seams?: JobRunnerSeams } = {},
): Promise<ClaimedJobExecutionResult> {
  try {
    const handler = resolveJobHandler(job.kind, job.schemaVersion);
    if (!handler) {
      // §6 fail closed：未知 kind / schemaVersion → PERMANENT → DEAD_LETTER
      const errorCode = "ASYNC_JOB_KIND_OR_SCHEMA_VERSION_UNKNOWN";
      const outcome = await failAsyncJob(prisma, {
        id: job.id,
        leaseToken: job.leaseToken,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        failureClass: "PERMANENT",
        errorCode,
        errorMessage: `未注册的 job kind/schemaVersion：${job.kind}@${job.schemaVersion}`,
      });
      if (outcome.kind !== "FENCED") {
        logJob("async_job_dead_lettered", job, { errorCode });
      }
      return { ...NO_SIDE_EFFECT_RESULT, deadLettered: outcome.kind !== "FENCED", fenced: outcome.kind === "FENCED" };
    }

    const startedAt = Date.now();
    // RB06（Review Round 2）：per-job execution policy（SSOT = job
    // registry）。EMAIL execution transaction 在 serialization boundary
    // 内含 provider HTTP，必须使用扩展事务预算 + 覆盖它的 execution
    // lease；未注册 policy 的 job（含 9A PRODUCT_RESERVATION_EXPIRE）
    // 解析为 {}，继承既有默认（TRANSACTION_TIMEOUT_MS / lease 覆盖链），
    // 行为零变化。
    const policy = resolveJobExecutionPolicy(job.kind, job.schemaVersion);
    const execution = await withTransaction(async (tx) => {
      // RB01：execution ownership 复核与 handler 同事务——条件 UPDATE 刷新
      // lease 并取行锁，锁保持到本事务 COMMIT（SKIP LOCKED 期间必跳过本行）
      const owned = await beginAsyncJobExecutionTx(tx, {
        id: job.id,
        leaseToken: job.leaseToken,
        leaseSeconds: policy.executionLeaseSeconds ?? options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
      });
      if (!owned) {
        return { fenced: true as const };
      }
      return { fenced: false as const, outcome: await handler(tx, job) };
    }, { timeout: policy.transactionTimeoutMs ?? TRANSACTION_TIMEOUT_MS });

    if (execution.fenced) {
      // stale worker：execution ownership 已丢失，handler 从未进入
      logJob("async_job_execution_fenced", job, {});
      return { ...NO_SIDE_EFFECT_RESULT, fencedBeforeExecution: true };
    }
    const outcome = execution.outcome;

    // §70 crash 模拟点：业务事务已提交、completion marker 未落库
    await options.seams?.afterJobTxCommit?.(job);
    await options.seams?.beforeCompletion?.(job);

    if (outcome.kind === "RESCHEDULE") {
      const reschedule = await rescheduleAsyncJob(prisma, {
        id: job.id,
        leaseToken: job.leaseToken,
        runAt: outcome.runAt,
      });
      if (reschedule.rescheduled) {
        logJob("async_job_rescheduled", job, { runAt: outcome.runAt.toISOString() });
      } else {
        logJob("async_job_completion_fenced", job, {});
      }
      return {
        ...NO_SIDE_EFFECT_RESULT,
        rescheduled: reschedule.rescheduled,
        fenced: !reschedule.rescheduled,
      };
    }

    const completion = await completeAsyncJob(prisma, {
      id: job.id,
      leaseToken: job.leaseToken,
    });
    if (!completion.completed) {
      // stale worker：lease 已被他人回收/覆盖，本 worker 的完成意图被 fence
      logJob("async_job_completion_fenced", job, {});
    } else {
      logJob("async_job_completed", job, {
        outcome: outcome.kind,
        durationMs: Date.now() - startedAt,
      });
    }
    return {
      ...NO_SIDE_EFFECT_RESULT,
      completed: completion.completed,
      idempotentNoOp: completion.completed && outcome.kind === "COMPLETED_IDEMPOTENT",
      fenced: !completion.completed,
    };
  } catch (error) {
    try {
      const outcome = await failAsyncJob(prisma, {
        id: job.id,
        leaseToken: job.leaseToken,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        failureClass: classifyJobFailure(error),
        errorCode: jobErrorCode(error),
        // RB02：raw exception message 默认拒绝落库（见 job-types 合同）
        errorMessage: jobErrorMessage(error),
      });
      if (outcome.kind === "RETRY") {
        logJob("async_job_retry_scheduled", job, {
          errorCode: jobErrorCode(error),
          runAt: outcome.runAt.toISOString(),
        });
        return { ...NO_SIDE_EFFECT_RESULT, retried: true };
      }
      if (outcome.kind === "DEAD_LETTER") {
        logJob("async_job_dead_lettered", job, { errorCode: jobErrorCode(error) });
        return { ...NO_SIDE_EFFECT_RESULT, deadLettered: true };
      }
      logJob("async_job_completion_fenced", job, { errorCode: jobErrorCode(error) });
      return { ...NO_SIDE_EFFECT_RESULT, fenced: true };
    } catch (completionError) {
      // completion 落库本身失败（如 DB 闪断）：只影响该 job，
      // lease 过期回收后由 crash recovery 重放；同 batch 后续 job 继续
      logger.warn("async job 失败处理落库异常，等待 lease recovery", "async-job-runner", {
        event: "async_job_failure_record_failed",
        jobId: job.id,
        kind: job.kind,
        errorName:
          completionError instanceof Error ? completionError.name : "unknown",
      });
      return NO_SIDE_EFFECT_RESULT;
    } finally {
      // 结构化应用日志承载安全上下文（错误名/码），完整 stack / raw message
      // 不入 job DB 行、也不进结构化日志（§10/RB02）
      logger.warn("async job 执行失败", "async-job-runner", {
        event: "async_job_handler_failed",
        jobId: job.id,
        kind: job.kind,
        errorCode: jobErrorCode(error),
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

/**
 * claim + 执行一个 batch（run-once / 常驻循环共用的最小单元）。
 */
export async function runAsyncJobBatchOnce(
  input: RunAsyncJobBatchInput = {},
): Promise<JobBatchSummary> {
  const summary: JobBatchSummary = {
    claimed: 0,
    leaseRecovered: 0,
    completed: 0,
    idempotentNoOp: 0,
    rescheduled: 0,
    retried: 0,
    deadLettered: 0,
    fenced: 0,
    fencedBeforeExecution: 0,
  };

  const claimed = await withTransaction((tx) =>
    claimDueAsyncJobs(tx, {
      workerId: input.workerId ?? createWorkerId(),
      leaseSeconds: input.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
      batchSize: input.batchSize ?? DEFAULT_BATCH_SIZE,
      now: input.now,
    }),
  );

  summary.claimed = claimed.length;
  summary.leaseRecovered = claimed.filter((job) => job.previousStatus === "RUNNING").length;

  for (const job of claimed) {
    logJob("async_job_claimed", job, {
      leaseRecovered: job.previousStatus === "RUNNING",
    });
  }
  if (summary.leaseRecovered > 0) {
    logger.info("lease 过期回收（crash recovery）", "async-job-runner", {
      event: "async_job_lease_recovered",
      count: summary.leaseRecovered,
    });
  }

  await input.seams?.afterClaim?.(claimed);

  for (const job of claimed) {
    const result = await executeClaimedAsyncJob(job, {
      leaseSeconds: input.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
      seams: input.seams,
    });
    summary.fencedBeforeExecution += result.fencedBeforeExecution ? 1 : 0;
    summary.completed += result.completed ? 1 : 0;
    summary.idempotentNoOp += result.idempotentNoOp ? 1 : 0;
    summary.rescheduled += result.rescheduled ? 1 : 0;
    summary.retried += result.retried ? 1 : 0;
    summary.deadLettered += result.deadLettered ? 1 : 0;
    summary.fenced += result.fenced ? 1 : 0;
  }

  return summary;
}
