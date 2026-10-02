import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import os from "node:os";

import { prisma } from "@/lib/prisma";
import { computeBackoffDelayMs } from "@/lib/async/backoff";
import {
  AsyncJobIntentContractError,
  validateJobIntent,
  type ClaimedAsyncJob,
} from "@/lib/async/job-types";

/**
 * Phase 9A：AsyncJob durable queue repository（PostgreSQL authority）。
 *
 * claim 算法（§11）：真实 PostgreSQL FOR UPDATE SKIP LOCKED——绝不以
 * findMany → update 模拟队列。candidate = runnable（PENDING/RETRY 且
 * runAt <= now）∪ crash recovery（RUNNING 且 leaseExpiresAt <= now）。
 * claim 与 lease 写入在单条 UPDATE ... FROM 内原子完成。
 *
 * lease fencing（§12/§13）：每次 claim 每行生成新的 DB 端 leaseToken
 * （gen_random_uuid）；completion / failure / reschedule 更新必须条件命中
 * { id, status = RUNNING, leaseToken = current }，0 rows = stale worker
 * 被 fence（worker A 的 lease 过期被 worker B 回收后，A 不得完成 B 的
 * lease）——J-LEASE-02 合同。
 *
 * attempts（§14）= 实际 execution claim 次数：claim 即 +1（含 crash
 * recovery reclaim），不是 failure 次数。
 */

type AsyncJobQueueClient = Prisma.TransactionClient | typeof prisma;

export type EnqueueAsyncJobInput = {
  kind: string;
  schemaVersion: number;
  dedupeKey: string;
  payload: Prisma.InputJsonValue;
  runAt: Date;
};

/**
 * 幂等 enqueue（§45）：dedupeKey UNIQUE + createMany skipDuplicates——
 * 重复 schedule 同一业务意图（如同一个 orderId）恰好落一行，P2002 不外泄。
 * 必须在业务事务内调用（domain state + job intent 同事务原子落盘）。
 *
 * RB04 写边界（privacy contract）：先 resolve 已注册 kind/version 并对
 * payload 做 strict 校验，只持久化 canonical parsed payload——未知
 * kind/version / 非法形状（含未知键）→ 抛 AsyncJobIntentContractError，
 * 事务回滚、零 AsyncJob 行。绝不"先落 raw payload、再靠 worker
 * dead-letter 补救"（privacy violation 已发生）。执行边界的
 * unknown → DEAD_LETTER 运行时合同保留（legacy corruption / 手工改库 /
 * 未来漂移的 defense-in-depth 第二层）。
 */
export async function enqueueAsyncJobTx(
  tx: Prisma.TransactionClient,
  input: EnqueueAsyncJobInput,
): Promise<{ recorded: boolean }> {
  const validated = validateJobIntent(input.kind, input.schemaVersion, input.payload);
  if (!validated.ok) {
    throw new AsyncJobIntentContractError(validated.reason, input.kind, input.schemaVersion);
  }
  const result = await tx.asyncJob.createMany({
    data: [
      {
        kind: input.kind,
        schemaVersion: input.schemaVersion,
        dedupeKey: input.dedupeKey,
        payload: validated.payload,
        runAt: input.runAt,
      },
    ],
    skipDuplicates: true,
  });
  return { recorded: result.count > 0 };
}

/**
 * Dead-letter requeue seam（§19）：内部 service 专用（本阶段无 public
 * HTTP / admin console）。仅 DEAD_LETTER 可 requeue：
 *   DEAD_LETTER → PENDING, attempts → 0, runAt → now,
 *   lease fields → null, deadLetteredAt → null。
 * 非 dead-letter：DENY（零 mutation）。
 */
export async function requeueDeadLetterJobTx(
  tx: Prisma.TransactionClient,
  jobId: string,
): Promise<{ requeued: boolean }> {
  const result = await tx.asyncJob.updateMany({
    where: { id: jobId, status: "DEAD_LETTER" },
    data: {
      status: "PENDING",
      attempts: 0,
      runAt: new Date(),
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      deadLetteredAt: null,
      completedAt: null,
    },
  });
  return { requeued: result.count > 0 };
}

export type ClaimAsyncJobsInput = {
  workerId: string;
  leaseSeconds: number;
  batchSize: number;
  now?: Date;
};

/**
 * claim 一批 due jobs（调用方自行决定事务边界；worker 路径经 withTransaction）。
 * 单条 UPDATE ... FROM (candidates FOR UPDATE SKIP LOCKED)：
 * 抢占 + lease 写入 + attempts 递增原子完成；两 worker 并发 claim 时
 * 每行至多被一个事务持有（SKIP LOCKED 跳过他人行锁）——J-RACE-01/02。
 */
export async function claimDueAsyncJobs(
  tx: Prisma.TransactionClient,
  input: ClaimAsyncJobsInput,
): Promise<ClaimedAsyncJob[]> {
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1000);

  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      kind: string;
      schemaVersion: number;
      payload: Prisma.JsonValue;
      attempts: number;
      maxAttempts: number;
      leaseToken: string;
      previousStatus: string;
    }>
  >`
    WITH candidates AS (
      SELECT id, status AS "previousStatus"
      FROM "AsyncJob"
      WHERE (
          "status" IN ('PENDING', 'RETRY')
          AND "runAt" <= ${now}
        )
        OR (
          "status" = 'RUNNING'
          AND "leaseExpiresAt" <= ${now}
        )
      ORDER BY "runAt" ASC, "createdAt" ASC, id ASC
      LIMIT ${input.batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "AsyncJob" AS j
    SET "status" = 'RUNNING',
        "attempts" = j."attempts" + 1,
        "leaseOwner" = ${input.workerId},
        "leaseToken" = gen_random_uuid()::text,
        "leaseExpiresAt" = ${leaseExpiresAt},
        "lastErrorCode" = NULL,
        "lastErrorMessage" = NULL,
        "updatedAt" = ${now}
    FROM candidates c
    WHERE j.id = c.id
    RETURNING
      j.id,
      j.kind,
      j."schemaVersion",
      j.payload,
      j.attempts,
      j."maxAttempts",
      j."leaseToken",
      c."previousStatus"
  `;

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    schemaVersion: row.schemaVersion,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    leaseToken: row.leaseToken,
    previousStatus: row.previousStatus,
  }));
}

export type CompleteAsyncJobInput = {
  id: string;
  leaseToken: string;
  now?: Date;
};

/**
 * RB01 execution fencing（与 beginOutboxMaterializeTx 同构）：
 * 在【handler 的同一个数据库事务】内以条件 UPDATE 复核 execution ownership
 * ——WHERE { id, status = RUNNING, leaseToken = current } 命中即刷新
 * leaseExpiresAt。该 UPDATE 取得 AsyncJob 行锁，且因与 handler 同事务，
 * 行锁保持到 handler 事务 COMMIT：期间其它 worker 的 FOR UPDATE SKIP LOCKED
 * 必须跳过该行（即使最初 claim 的 lease 时间已接近到期，execution
 * transaction 仍有数据库行锁保护）。
 *
 * 返回 false = execution ownership 已丢失（lease 过期被 worker B 回收等）
 * → 调用方必须让 handler 完全不运行（STALE WORKER MUST NOT ENTER DOMAIN
 * HANDLER SIDE EFFECTS；domain side effects = 0）。
 */
export async function beginAsyncJobExecutionTx(
  tx: Prisma.TransactionClient,
  input: { id: string; leaseToken: string; leaseSeconds: number; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const result = await tx.asyncJob.updateMany({
    where: { id: input.id, status: "RUNNING", leaseToken: input.leaseToken },
    data: { leaseExpiresAt: new Date(now.getTime() + input.leaseSeconds * 1000) },
  });
  return result.count > 0;
}

/**
 * 完成 marker（独立于业务事务的 fencing 写）：条件 { id, status = RUNNING,
 * leaseToken }。0 rows = lease 已被回收/覆盖（stale worker）→ FENCED，
 * 绝不允许 A 完成 B 的 lease（J-LEASE-02 merge blocker）。
 */
export async function completeAsyncJob(
  client: AsyncJobQueueClient,
  input: CompleteAsyncJobInput,
): Promise<{ completed: boolean }> {
  const result = await client.asyncJob.updateMany({
    where: { id: input.id, status: "RUNNING", leaseToken: input.leaseToken },
    data: {
      status: "COMPLETED",
      completedAt: input.now ?? new Date(),
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });
  return { completed: result.count > 0 };
}

export type FailAsyncJobInput = {
  id: string;
  leaseToken: string;
  attempts: number;
  maxAttempts: number;
  failureClass: "RETRYABLE" | "PERMANENT";
  errorCode: string;
  errorMessage: string;
  now?: Date;
};

export type FailAsyncJobOutcome =
  | { kind: "RETRY"; runAt: Date }
  | { kind: "DEAD_LETTER" }
  | { kind: "FENCED" };

/**
 * 失败分类落库（§15/§16/§17）：
 *   PERMANENT（unknown kind / schemaVersion / payload 非法 / 结构性损坏）
 *     → 立即 DEAD_LETTER；
 *   RETRYABLE 且 attempts >= maxAttempts → DEAD_LETTER（§16，清 lease）；
 *   RETRYABLE 且仍有余量 → RETRY + runAt = now + min(BASE*2^(attempts-1), MAX)。
 * 两分支都以 { id, status = RUNNING, leaseToken } 为条件——fenced 时
 * 返回 FENCED，不产生任何写入。
 */
export async function failAsyncJob(
  client: AsyncJobQueueClient,
  input: FailAsyncJobInput,
): Promise<FailAsyncJobOutcome> {
  const now = input.now ?? new Date();
  const deadLetterData = {
    status: "DEAD_LETTER" as const,
    deadLetteredAt: now,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    lastErrorCode: input.errorCode,
    lastErrorMessage: input.errorMessage,
  };
  const failureMetadata = {
    lastErrorCode: input.errorCode,
    lastErrorMessage: input.errorMessage,
  };

  if (input.failureClass === "PERMANENT") {
    const result = await client.asyncJob.updateMany({
      where: { id: input.id, status: "RUNNING", leaseToken: input.leaseToken },
      data: deadLetterData,
    });
    return result.count > 0 ? { kind: "DEAD_LETTER" } : { kind: "FENCED" };
  }

  if (input.attempts >= input.maxAttempts) {
    const result = await client.asyncJob.updateMany({
      where: {
        id: input.id,
        status: "RUNNING",
        leaseToken: input.leaseToken,
        attempts: { gte: input.maxAttempts },
      },
      data: deadLetterData,
    });
    return result.count > 0 ? { kind: "DEAD_LETTER" } : { kind: "FENCED" };
  }

  const runAt = new Date(now.getTime() + computeBackoffDelayMs(input.attempts));
  const result = await client.asyncJob.updateMany({
    where: {
      id: input.id,
      status: "RUNNING",
      leaseToken: input.leaseToken,
      attempts: { lt: input.maxAttempts },
    },
    data: {
      status: "RETRY",
      runAt,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      ...failureMetadata,
    },
  });
  return result.count > 0 ? { kind: "RETRY", runAt } : { kind: "FENCED" };
}

export type RescheduleAsyncJobInput = {
  id: string;
  leaseToken: string;
  runAt: Date;
  now?: Date;
};

/**
 * NOT_DUE 防御分支（§26）：按权威 deadline 重新排程，不计失败。
 * 正常不发生（job runAt = 创建时的 authoritative deadline）；防 clock 漂移
 * 与 stale schedule。
 */
export async function rescheduleAsyncJob(
  client: AsyncJobQueueClient,
  input: RescheduleAsyncJobInput,
): Promise<{ rescheduled: boolean }> {
  const result = await client.asyncJob.updateMany({
    where: { id: input.id, status: "RUNNING", leaseToken: input.leaseToken },
    data: {
      status: "PENDING",
      runAt: input.runAt,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  return { rescheduled: result.count > 0 };
}

/** 生成 process-instance unique workerId（§13：hostname 仅是 label 成分，
 * 绝不作为唯一 fencing token——fencing authority 是 leaseToken）。 */
export function createWorkerId(label = "async-worker"): string {
  return `${label}:${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}
