import { logger } from "@/lib/logger";
import { prisma, withTransaction } from "@/lib/prisma";
import { enqueueAsyncJobTx } from "@/lib/async/job-repository";
import {
  ERRAND_DEADLINE_EXPIRE_JOB_KIND,
  ERRAND_DEADLINE_EXPIRE_JOB_SCHEMA_VERSION,
} from "@/lib/async/job-types";

/**
 * Phase 9C-02（§10/§11/§12）：Errand deadline scheduler producer。
 *
 * 职责只有 discovery → enqueue durable one-shot intent：
 *
 *   discover due OPEN errands（DB-side anti-join 排除已存在 expiry job）
 *   → enqueue ERRAND_DEADLINE_EXPIRE@1（dedupeKey 幂等）
 *
 * 它不是业务状态 authority——materialize OPEN → CANCELLED 只能由
 * expireErrandDeadlineTx（canonical lifecycle）在 job handler 内完成；
 * producer 失败不修改 domain state、不伪造 expiry，下个 worker cycle
 * 重新 discovery（§20）。
 *
 * 架构冻结（§8/§12）：
 * - 不为每个未来 deadline 在 create/edit 时提前建 job——recurring
 *   producer 周期扫描即可覆盖历史 OPEN errands 与 deadline edit，
 *   不制造 Errand schema ↔ AsyncJob 的反向锁。
 * - Recurrence 属 scheduler producer / worker cycle；AsyncJob 属一次性
 *   durable intent。绝对禁止创建一个永久存在的 sweep job 然后
 *   RESCHEDULE 同一行无限循环——attempts = 实际 claim 次数（每次 claim
 *   +1）且 RESCHEDULE 不重置 attempts，forever-recurring job 会污染
 *   attempts/maxAttempts 语义。未来若需要"周期性业务 tick"，必须
 *   new job per deterministic time bucket（如
 *   RETENTION_CLEANUP:2026-10-04T00:00），而不是无限 reschedule 同一行。
 * - RESCHEDULE 仅允许用于 one-shot intent 的 NOT_DUE stale-schedule
 *   防御（PRODUCT_RESERVATION_EXPIRE / ERRAND_DEADLINE_EXPIRE 同一语义）。
 *
 * fairness / anti-join（§11）：候选 discovery 用 DB-side NOT EXISTS 排除
 * 已存在 `ERRAND_DEADLINE_EXPIRE:<errandId>` AsyncJob 的 errand——PENDING /
 * RETRY / RUNNING / COMPLETED / DEAD_LETTER 任何状态都代表"该 errand 已有
 * durable expiry intent"，绝不生成第二条（DEAD_LETTER 走既有
 * requeueDeadLetterJobTx seam，不由 scheduler 自动复制）。不做"先取前 N
 * 条再 skipDuplicates"——那会让已 schedule 未 materialize 的最老批次长期
 * 占满 batch window（head-of-line starvation）。
 *
 * 多实例 / crash / retry 安全（§10）：dedupeKey UNIQUE + createMany
 * skipDuplicates ⇒ 并发 scheduler 对同一 errand 恰好落一行，P2002 不外泄；
 * 单条 enqueue 失败只影响自身（记录 machine event，下轮重新 discovery）；
 * 逐条独立事务，crash 后未 enqueue 的候选由下轮重建 intent。
 * 日志只写 machine event + IDs/counts + errorName（§20 禁止 payload /
 * title / description / contactNote 入日志）。
 */

const DEFAULT_BATCH_LIMIT = 100;

export type ScheduleDueErrandDeadlinesInput = {
  /** 单轮 discovery 上限（有界 batch，确定性序 deadline ASC, id ASC）。 */
  batchLimit?: number;
  /** discovery 时钟（仅测试注入；生产不传）。 */
  now?: Date;
};

export type ScheduleDueErrandDeadlinesSummary = {
  discovered: number;
  enqueued: number;
};

export async function scheduleDueErrandDeadlineJobs(
  input: ScheduleDueErrandDeadlinesInput = {},
): Promise<ScheduleDueErrandDeadlinesSummary> {
  const batchLimit = input.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const now = input.now ?? new Date();

  // DB-side anti-join（§11）：NOT EXISTS 排除任何已存在 expiry intent 的
  // errand；确定性序（deadline ASC, id ASC）保证多实例扫描行为可预期。
  const candidates = await prisma.$queryRaw<Array<{ id: string; deadline: Date }>>`
    SELECT e.id, e."deadline"
    FROM "ErrandTask" e
    WHERE e."deletedAt" IS NULL
      AND e.status = 'OPEN'
      AND e."accepterId" IS NULL
      AND e."deadline" <= ${now}
      AND NOT EXISTS (
        SELECT 1
        FROM "AsyncJob" j
        WHERE j."dedupeKey" = ${`ERRAND_DEADLINE_EXPIRE:`} || e.id
      )
    ORDER BY e."deadline" ASC, e.id ASC
    LIMIT ${batchLimit}
  `;

  let enqueued = 0;

  for (const candidate of candidates) {
    try {
      // runAt = errand deadline（此刻已 due）；enqueue 幂等（dedupe 命中
      // recorded=false 不计入新 intent）
      const { recorded } = await withTransaction((tx) =>
        enqueueAsyncJobTx(tx, {
          kind: ERRAND_DEADLINE_EXPIRE_JOB_KIND,
          schemaVersion: ERRAND_DEADLINE_EXPIRE_JOB_SCHEMA_VERSION,
          dedupeKey: `${ERRAND_DEADLINE_EXPIRE_JOB_KIND}:${candidate.id}`,
          payload: { errandId: candidate.id },
          runAt: candidate.deadline,
        }),
      );
      if (recorded) {
        enqueued += 1;
      }
    } catch (error) {
      // 单条失败只影响自身：不修改 domain state，下轮重新 discovery。
      // 日志仅 machine event + errandId + errorName（无 payload/用户文本）
      logger.warn("errand deadline intent enqueue 失败，等待下轮 discovery", "errand-deadline-scheduler", {
        event: "errand_deadline_scheduler_enqueue_failed",
        errandId: candidate.id,
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  if (candidates.length > 0) {
    logger.info("errand deadline scheduler 周期完成", "errand-deadline-scheduler", {
      event: "errand_deadline_scheduler_cycle",
      discovered: candidates.length,
      enqueued,
    });
  }

  return { discovered: candidates.length, enqueued };
}
