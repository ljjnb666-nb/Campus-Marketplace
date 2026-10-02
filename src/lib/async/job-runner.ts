import { logger } from "@/lib/logger";
import { prisma, withTransaction } from "@/lib/prisma";
import { resolveJobHandler } from "@/lib/async/job-registry";
import {
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
 * Phase 9A：AsyncJob runner（§24/§26/§31/§33/§39）。
 *
 * 职责边界：wake up → invoke canonical domain lifecycle（handler）→
 * 条件落 completion marker。runner 绝不直接 UPDATE Order/Product。
 *
 * crash isolation（§33）：单个 job 的 handler throw / completion 失败只
 * 影响该 job（RETRY / DEAD_LETTER），同 batch 后续 job 继续执行；仅
 * 配置级 fatal（env 非法，worker entrypoint 层）才允许进程退出。
 *
 * crash-replay 安全（§57）：completion marker 以 { id, status = RUNNING,
 * leaseToken } 条件写，且在业务事务 COMMIT 之后——若 worker 在业务提交后、
 * marker 落库前崩溃，lease 过期回收后 handler 重放得到 NOT_PENDING →
 * COMPLETED_IDEMPOTENT，最终 COMPLETED 且副作用恰好一次。
 *
 * test seams（§70）：仅测试注入（生产不传），用于 claim 后 / 业务事务提交后
 * / completion 前的受控暂停；禁止以 sleep 作为并发证明。
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
  fenced: number;
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

/** 逐个执行一批已 claim 的 jobs；返回本批汇总（不改 claim 顺序）。 */
async function executeClaimedJobs(
  claimed: readonly ClaimedAsyncJob[],
  input: RunAsyncJobBatchInput,
  summary: JobBatchSummary,
): Promise<void> {
  for (const job of claimed) {
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
        summary.deadLettered += outcome.kind === "DEAD_LETTER" ? 1 : 0;
        summary.fenced += outcome.kind === "FENCED" ? 1 : 0;
        if (outcome.kind !== "FENCED") {
          logJob("async_job_dead_lettered", job, { errorCode });
        }
        continue;
      }

      const startedAt = Date.now();
      const outcome = await withTransaction((tx) => handler(tx, job));

      // §70 crash 模拟点：业务事务已提交、completion marker 未落库
      await input.seams?.afterJobTxCommit?.(job);
      await input.seams?.beforeCompletion?.(job);

      if (outcome.kind === "RESCHEDULE") {
        const reschedule = await rescheduleAsyncJob(prisma, {
          id: job.id,
          leaseToken: job.leaseToken,
          runAt: outcome.runAt,
        });
        if (reschedule.rescheduled) {
          summary.rescheduled += 1;
          logJob("async_job_rescheduled", job, { runAt: outcome.runAt.toISOString() });
        } else {
          summary.fenced += 1;
        }
        continue;
      }

      const completion = await completeAsyncJob(prisma, {
        id: job.id,
        leaseToken: job.leaseToken,
      });
      if (!completion.completed) {
        // stale worker：lease 已被他人回收/覆盖，本 worker 的完成意图被 fence
        summary.fenced += 1;
        logJob("async_job_completion_fenced", job, {});
        continue;
      }

      if (outcome.kind === "COMPLETED_IDEMPOTENT") {
        summary.idempotentNoOp += 1;
      } else {
        summary.completed += 1;
      }
      logJob("async_job_completed", job, {
        outcome: outcome.kind,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      try {
        const outcome = await failAsyncJob(prisma, {
          id: job.id,
          leaseToken: job.leaseToken,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          failureClass: classifyJobFailure(error),
          errorCode: jobErrorCode(error),
          errorMessage: jobErrorMessage(error),
        });
        if (outcome.kind === "RETRY") {
          summary.retried += 1;
          logJob("async_job_retry_scheduled", job, {
            errorCode: jobErrorCode(error),
            runAt: outcome.runAt.toISOString(),
          });
        } else if (outcome.kind === "DEAD_LETTER") {
          summary.deadLettered += 1;
          logJob("async_job_dead_lettered", job, { errorCode: jobErrorCode(error) });
        } else {
          summary.fenced += 1;
          logJob("async_job_completion_fenced", job, { errorCode: jobErrorCode(error) });
        }
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
      }
      // 结构化应用日志承载安全上下文（错误名/码），完整 stack 不入 job DB 行
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

  await executeClaimedJobs(claimed, input, summary);

  return summary;
}
