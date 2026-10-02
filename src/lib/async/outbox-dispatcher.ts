import type { OutboxEventStatus } from "@prisma/client";

import { logger } from "@/lib/logger";
import { prisma, withTransaction } from "@/lib/prisma";
import { PermanentJobFailure } from "@/lib/async/job-types";
import { createWorkerId } from "@/lib/async/job-repository";
import {
  beginOutboxMaterializeTx,
  claimDueOutboxEvents,
  failOutboxEvent,
  publishOutboxEventTx,
} from "@/lib/async/outbox";
import {
  outboxEventErrorCode,
  outboxEventErrorMessage,
  type ClaimedOutboxEvent,
} from "@/lib/async/outbox-event-registry";
import { resolveOutboxEventHandler } from "@/lib/async/outbox-registry";

/**
 * Phase 9A：Outbox dispatcher（§27/§29/§33/§39/§58）。
 *
 * 与 job runner 同一拓扑与安全合同：SKIP LOCKED claim + leaseToken
 * fencing + 单 event 失败隔离 + backoff retry + DEAD_LETTER。
 *
 * materializer 原子性（§29）：verify event 仍属当前 lease（行锁刷新）→
 * handler 派生副作用 → 条件置 PUBLISHED，全部在同一数据库事务内 COMMIT。
 * crash before commit = 副作用与 PUBLISHED 都不提交；crash after commit =
 * 两者都已提交——不存在"通知已写、event 仍 PENDING"的重复窗口。
 */

export type OutboxDispatcherSeams = {
  afterClaim?: (claimed: readonly ClaimedOutboxEvent[]) => Promise<void>;
  /** materializer 事务开启前（crash after claim 模拟点）。 */
  beforeHandlerTx?: (event: ClaimedOutboxEvent) => Promise<void>;
};

export type RunOutboxBatchInput = {
  batchSize?: number;
  leaseSeconds?: number;
  workerId?: string;
  seams?: OutboxDispatcherSeams;
  now?: Date;
};

export type OutboxBatchSummary = {
  claimed: number;
  leaseRecovered: number;
  published: number;
  retried: number;
  deadLettered: number;
  fenced: number;
};

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LEASE_SECONDS = 60;

function logEvent(event: string, claimed: ClaimedOutboxEvent, extra: Record<string, unknown>): void {
  logger.info(event, "outbox-dispatcher", {
    event,
    eventId: claimed.id,
    eventType: claimed.eventType,
    schemaVersion: claimed.schemaVersion,
    aggregateType: claimed.aggregateType,
    attempt: claimed.attempts,
    ...extra,
  });
}

/** claim + 派发一个 batch（run-once / 常驻循环共用的最小单元）。 */
export async function runOutboxBatchOnce(
  input: RunOutboxBatchInput = {},
): Promise<OutboxBatchSummary> {
  const summary: OutboxBatchSummary = {
    claimed: 0,
    leaseRecovered: 0,
    published: 0,
    retried: 0,
    deadLettered: 0,
    fenced: 0,
  };

  const claimed = await withTransaction((tx) =>
    claimDueOutboxEvents(tx, {
      workerId: input.workerId ?? createWorkerId("outbox-dispatcher"),
      leaseSeconds: input.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
      batchSize: input.batchSize ?? DEFAULT_BATCH_SIZE,
      now: input.now,
    }),
  );

  summary.claimed = claimed.length;
  summary.leaseRecovered = claimed.filter((event) => event.previousStatus === "PROCESSING").length;

  for (const event of claimed) {
    logEvent("outbox_event_claimed", event, {
      leaseRecovered: event.previousStatus === "PROCESSING",
    });
  }
  if (summary.leaseRecovered > 0) {
    logger.info("outbox lease 过期回收（crash recovery）", "outbox-dispatcher", {
      event: "outbox_event_lease_recovered",
      count: summary.leaseRecovered,
    });
  }

  await input.seams?.afterClaim?.(claimed);

  for (const event of claimed) {
    await dispatchClaimedEvent(event, input, summary);
  }

  return summary;
}

async function dispatchClaimedEvent(
  event: ClaimedOutboxEvent,
  input: RunOutboxBatchInput,
  summary: OutboxBatchSummary,
): Promise<void> {
  try {
    const handler = resolveOutboxEventHandler(event.eventType, event.schemaVersion);
    if (!handler) {
      // §22 fail closed：未知 eventType / schemaVersion → PERMANENT → DEAD_LETTER
      await recordOutboxFailure(event, input, summary, {
        failureClass: "PERMANENT",
        errorCode: "OUTBOX_EVENT_TYPE_OR_SCHEMA_VERSION_UNKNOWN",
        errorMessage: `未注册的 outbox eventType/schemaVersion：${event.eventType}@${event.schemaVersion}`,
      });
      return;
    }

    await input.seams?.beforeHandlerTx?.(event);

    const startedAt = Date.now();
    const published = await withTransaction(async (tx) => {
      // verify PROCESSING + leaseToken（行锁刷新 lease）→ 派生副作用 → PUBLISHED
      const owned = await beginOutboxMaterializeTx(tx, {
        id: event.id,
        leaseToken: event.leaseToken,
        leaseSeconds: input.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
        now: input.now,
      });
      if (!owned) {
        return false;
      }
      await handler(tx, event);
      return publishOutboxEventTx(tx, {
        id: event.id,
        leaseToken: event.leaseToken,
        now: input.now,
      });
    });

    if (!published) {
      // stale dispatcher：lease 已被回收/覆盖，本次 materialize 被 fence
      summary.fenced += 1;
      logEvent("outbox_event_completion_fenced", event, {});
      return;
    }

    summary.published += 1;
    logEvent("outbox_event_published", event, { durationMs: Date.now() - startedAt });
  } catch (error) {
    await recordOutboxFailure(event, input, summary, {
      failureClass: classifyOutboxFailure(error),
      errorCode: outboxEventErrorCode(error),
      errorMessage: outboxEventErrorMessage(error),
    });
    logger.warn("outbox event 派发失败", "outbox-dispatcher", {
      event: "outbox_event_handler_failed",
      eventId: event.id,
      eventType: event.eventType,
      errorCode: outboxEventErrorCode(error),
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }
}

function classifyOutboxFailure(error: unknown): "RETRYABLE" | "PERMANENT" {
  return error instanceof PermanentJobFailure ? "PERMANENT" : "RETRYABLE";
}

type FailureDescriptor = {
  failureClass: "RETRYABLE" | "PERMANENT";
  errorCode: string;
  errorMessage: string;
};

async function recordOutboxFailure(
  event: ClaimedOutboxEvent,
  input: RunOutboxBatchInput,
  summary: OutboxBatchSummary,
  failure: FailureDescriptor,
): Promise<void> {
  try {
    const outcome = await failOutboxEvent(prisma, {
      id: event.id,
      leaseToken: event.leaseToken,
      attempts: event.attempts,
      maxAttempts: event.maxAttempts,
      failureClass: failure.failureClass,
      errorCode: failure.errorCode,
      errorMessage: failure.errorMessage,
      now: input.now,
    });
    if (outcome.kind === "RETRY") {
      summary.retried += 1;
      logEvent("outbox_event_retry_scheduled", event, {
        errorCode: failure.errorCode,
        availableAt: outcome.availableAt.toISOString(),
      });
    } else if (outcome.kind === "DEAD_LETTER") {
      summary.deadLettered += 1;
      logEvent("outbox_event_dead_lettered", event, { errorCode: failure.errorCode });
    } else {
      summary.fenced += 1;
      logEvent("outbox_event_completion_fenced", event, { errorCode: failure.errorCode });
    }
  } catch (completionError) {
    // 失败落库本身异常（DB 闪断）：lease 过期回收后重放；不阻断同 batch 后续 event
    logger.warn("outbox event 失败处理落库异常，等待 lease recovery", "outbox-dispatcher", {
      event: "outbox_event_failure_record_failed",
      eventId: event.id,
      eventType: event.eventType,
      errorName: completionError instanceof Error ? completionError.name : "unknown",
    });
  }
}

// 状态机引用（文档化；运行时无行为）
export type { OutboxEventStatus };
