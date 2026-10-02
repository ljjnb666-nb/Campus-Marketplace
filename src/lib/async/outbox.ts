import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { computeBackoffDelayMs } from "@/lib/async/backoff";
import {
  OutboxEventIntentContractError,
  validateOutboxIntent,
} from "@/lib/async/outbox-event-registry";
import type { ClaimedOutboxEvent } from "@/lib/async/outbox-event-registry";

/**
 * Phase 9A：Transactional Outbox repository（PostgreSQL authority）。
 *
 * 与 AsyncJob 语义分离（§21）：OutboxEvent = 已发生的 domain fact，等待
 * 幂等派生副作用；AsyncJob = 稍后必须执行的领域动作。禁止合并大表。
 *
 * claim 与 AsyncJob 同一算法（§58）：FOR UPDATE SKIP LOCKED + leaseToken
 * fencing——两个 dispatcher 并发 claim 同一 event 时至多一个有效 lease。
 */

type OutboxQueueClient = Prisma.TransactionClient | typeof prisma;

export type RecordOutboxEventInput = {
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  dedupeKey: string;
  payload: Prisma.InputJsonValue;
  availableAt?: Date;
};

/**
 * 幂等 event 落库（§23）：dedupeKey UNIQUE + createMany skipDuplicates。
 * 必须在产生该 event 的业务事务内调用（domain transition + outbox insert
 * 同事务原子落盘）；重复记录（dedupe 命中）返回 recorded = false。
 *
 * RB04 写边界（privacy contract）：先 resolve 已注册 eventType/version 并
 * strict 校验 payload，只持久化 canonical parsed payload——未知
 * eventType/version / 非法形状（含未知键）→ 抛 OutboxEventIntentContractError，
 * 事务回滚、零 OutboxEvent 行。运行时 unknown → DEAD_LETTER 合同保留
 * （第二层 defense-in-depth）。
 */
export async function recordOutboxEventTx(
  tx: Prisma.TransactionClient,
  input: RecordOutboxEventInput,
): Promise<{ recorded: boolean }> {
  const validated = validateOutboxIntent(
    input.eventType,
    input.schemaVersion,
    input.payload,
  );
  if (!validated.ok) {
    throw new OutboxEventIntentContractError(
      validated.reason,
      input.eventType,
      input.schemaVersion,
    );
  }
  const result = await tx.outboxEvent.createMany({
    data: [
      {
        eventType: input.eventType,
        schemaVersion: input.schemaVersion,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        dedupeKey: input.dedupeKey,
        payload: validated.payload,
        availableAt: input.availableAt ?? new Date(),
      },
    ],
    skipDuplicates: true,
  });
  return { recorded: result.count > 0 };
}

/** Dead-letter requeue seam（与 AsyncJob §19 对称；9B governance/ops 复用）。 */
export async function requeueDeadLetterOutboxEventTx(
  tx: Prisma.TransactionClient,
  eventId: string,
): Promise<{ requeued: boolean }> {
  const result = await tx.outboxEvent.updateMany({
    where: { id: eventId, status: "DEAD_LETTER" },
    data: {
      status: "PENDING",
      attempts: 0,
      availableAt: new Date(),
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      deadLetteredAt: null,
      publishedAt: null,
    },
  });
  return { requeued: result.count > 0 };
}

export type ClaimOutboxEventsInput = {
  workerId: string;
  leaseSeconds: number;
  batchSize: number;
  now?: Date;
};

/**
 * claim 一批 available events（PENDING 且 availableAt <= now ∪ PROCESSING
 * 且 leaseExpiresAt <= now 的 crash recovery）。单条 UPDATE ... FROM
 * （FOR UPDATE SKIP LOCKED）原子抢占 + 写 lease。
 */
export async function claimDueOutboxEvents(
  tx: Prisma.TransactionClient,
  input: ClaimOutboxEventsInput,
): Promise<ClaimedOutboxEvent[]> {
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1000);

  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      eventType: string;
      schemaVersion: number;
      aggregateType: string;
      aggregateId: string;
      payload: Prisma.JsonValue;
      attempts: number;
      maxAttempts: number;
      leaseToken: string;
      previousStatus: string;
    }>
  >`
    WITH candidates AS (
      SELECT id, status AS "previousStatus"
      FROM "OutboxEvent"
      WHERE (
          "status" = 'PENDING'
          AND "availableAt" <= ${now}
        )
        OR (
          "status" = 'PROCESSING'
          AND "leaseExpiresAt" <= ${now}
        )
      ORDER BY "availableAt" ASC, "createdAt" ASC, id ASC
      LIMIT ${input.batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "OutboxEvent" AS e
    SET "status" = 'PROCESSING',
        "attempts" = e."attempts" + 1,
        "leaseOwner" = ${input.workerId},
        "leaseToken" = gen_random_uuid()::text,
        "leaseExpiresAt" = ${leaseExpiresAt},
        "lastErrorCode" = NULL,
        "lastErrorMessage" = NULL,
        "updatedAt" = ${now}
    FROM candidates c
    WHERE e.id = c.id
    RETURNING
      e.id,
      e."eventType",
      e."schemaVersion",
      e."aggregateType",
      e."aggregateId",
      e.payload,
      e.attempts,
      e."maxAttempts",
      e."leaseToken",
      c."previousStatus"
  `;

  return rows.map((row) => ({
    id: row.id,
    eventType: row.eventType,
    schemaVersion: row.schemaVersion,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    leaseToken: row.leaseToken,
    previousStatus: row.previousStatus,
  }));
}

/**
 * §29 materializer 事务原语：在同一事务内 verify event 仍属当前 lease
 * （PROCESSING + leaseToken，行锁刷新 lease）→ handler 派生副作用 →
 * 条件置 PUBLISHED。crash before commit = 副作用与 PUBLISHED 都不提交；
 * crash after commit = 两者都已提交。绝不产生"通知已写、event 仍 PENDING"
 * 的 duplicate window。
 */
export async function beginOutboxMaterializeTx(
  tx: Prisma.TransactionClient,
  input: { id: string; leaseToken: string; leaseSeconds: number; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const result = await tx.outboxEvent.updateMany({
    where: { id: input.id, status: "PROCESSING", leaseToken: input.leaseToken },
    data: { leaseExpiresAt: new Date(now.getTime() + input.leaseSeconds * 1000) },
  });
  return result.count > 0;
}

export async function publishOutboxEventTx(
  tx: Prisma.TransactionClient,
  input: { id: string; leaseToken: string; now?: Date },
): Promise<boolean> {
  const result = await tx.outboxEvent.updateMany({
    where: { id: input.id, status: "PROCESSING", leaseToken: input.leaseToken },
    data: {
      status: "PUBLISHED",
      publishedAt: input.now ?? new Date(),
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });
  return result.count > 0;
}

export type FailOutboxEventInput = {
  id: string;
  leaseToken: string;
  attempts: number;
  maxAttempts: number;
  failureClass: "RETRYABLE" | "PERMANENT";
  errorCode: string;
  errorMessage: string;
  now?: Date;
};

export type FailOutboxEventOutcome =
  | { kind: "RETRY"; availableAt: Date }
  | { kind: "DEAD_LETTER" }
  | { kind: "FENCED" };

/** 与 failAsyncJob 同一分类/退避合同（PERMANENT 立即 dead-letter；
 * RETRYABLE until maxAttempts；fenced 时零写入）。 */
export async function failOutboxEvent(
  client: OutboxQueueClient,
  input: FailOutboxEventInput,
): Promise<FailOutboxEventOutcome> {
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

  if (input.failureClass === "PERMANENT") {
    const result = await client.outboxEvent.updateMany({
      where: { id: input.id, status: "PROCESSING", leaseToken: input.leaseToken },
      data: deadLetterData,
    });
    return result.count > 0 ? { kind: "DEAD_LETTER" } : { kind: "FENCED" };
  }

  if (input.attempts >= input.maxAttempts) {
    const result = await client.outboxEvent.updateMany({
      where: {
        id: input.id,
        status: "PROCESSING",
        leaseToken: input.leaseToken,
        attempts: { gte: input.maxAttempts },
      },
      data: deadLetterData,
    });
    return result.count > 0 ? { kind: "DEAD_LETTER" } : { kind: "FENCED" };
  }

  const availableAt = new Date(now.getTime() + computeBackoffDelayMs(input.attempts));
  const result = await client.outboxEvent.updateMany({
    where: {
      id: input.id,
      status: "PROCESSING",
      leaseToken: input.leaseToken,
      attempts: { lt: input.maxAttempts },
    },
    data: {
      status: "PENDING",
      availableAt,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: input.errorCode,
      lastErrorMessage: input.errorMessage,
    },
  });
  return result.count > 0 ? { kind: "RETRY", availableAt } : { kind: "FENCED" };
}
