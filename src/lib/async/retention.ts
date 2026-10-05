import type { Prisma } from "@prisma/client";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  NOTIFICATION_DELIVERY_JOB_KIND,
  notificationDeliveryPayloadSchema,
} from "@/lib/async/job-types";
import {
  NOTIFICATION_CHANNEL_EMAIL,
  NOTIFICATION_DELIVERY_SUPPRESSION_JOB_DEAD_LETTER,
  REDACTED_EMAIL_DESTINATION,
} from "@/lib/notifications/notification-delivery";

/**
 * Phase 9C-04：Phase 9 bounded retention maintenance（§3/§4/§22/§23/§24）。
 *
 * 第一核心不变量（INV-9C04-01）：retention 永远不会释放已成功 intent/event
 * 的 dedupe identity。AsyncJob.dedupeKey / OutboxEvent.dedupeKey UNIQUE 不仅是
 * 历史字段，而是 exactly-once / replay suppression authority——DELETE 已
 * COMPLETED/PUBLISHED 行 = 释放幂等身份，stale domain retry / replay 会把
 * 同一意图重新 enqueue（duplicate side effect window）。因此 retention 对
 * terminal 行执行【in-place compaction tombstone】：
 *
 *   status 保持 COMPLETED / PUBLISHED（绝不新增第二套终态状态机）；
 *   payload → 固定机器 marker（故意不符合任何 job payload schema——
 *     COMPLETED 行永远不会再次 claim，形状漂移是安全的）；
 *   诊断/lease 字段清空；
 *   tombstonedAt → now（唯一的逻辑转移标记）；
 *   dedupeKey / kind / schemaVersion / attempts / terminal timestamps 永久保留。
 *
 * 其余不变量：
 * - DEAD_LETTER 绝不是 retention candidate（未决运维事件，保留诊断/requeue/
 *   reconcile 面，§10/INV-9C04-04）；
 * - pending EMAIL delivery（providerAcceptedAt 与 suppressedAt 皆空）绝不被
 *   PII redaction 触碰——worker 仍需要 destination 发送（§18/INV-9C04-06）；
 * - 全部子任务 bounded（默认 batchLimit=200，绝无一次 UPDATE 全 backlog，
 *   §22/INV-9C04-09）；
 * - candidate discovery 与 authoritative transition 分离（§23）：discovery
 *   只产出候选 id（deterministic 序），真正的转移是带 fresh predicate 的
 *   条件 UPDATE——并发 maintenance worker 可以 discover 同一行，但
 *   tombstonedAt/redactedAt IS NULL 谓词保证恰好一个赢得转移
 *   （INV-9C04-10），summary count 只统计实际转移行；
 * - terminal anchor 是 terminal 时间戳（completedAt / publishedAt /
 *   providerAcceptedAt / suppressedAt），绝不使用 createdAt（§21）。
 *
 * Failure model（§29）：单子任务失败计入 phase9Failures 并继续其余子任务
 * （全部转移幂等，部分成功 → 下轮继续安全）；调用方（cleanup worker）把
 * phase9Failures > 0 视为整周期 FAIL（下轮重试），绝不打印成功 summary。
 *
 * dry-run（§25/INV-9C04-11）：只计算 candidate counts（完整 backlog 只读
 * 可观测性），零 mutation——绝不"先 update 再 rollback"假装 dry-run。
 */

/** AsyncJob / OutboxEvent tombstone payload marker（§6）：machine-only，
 * 故意不符合任何已注册 job/outbox payload schema（COMPLETED/PUBLISHED 行
 * 永不再次 claim/dispatch，因此形状漂移无 runtime 风险）。 */
export const PHASE9_RETENTION_TOMBSTONE_MARKER: Prisma.InputJsonValue = {
  retained: "TOMBSTONE",
};

const DEFAULT_RETENTION_BATCH_LIMIT = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export type RetentionMaintenanceOptions = {
  dryRun?: boolean;
  now?: Date;
  /** 单周期 candidate 上限（§22 默认 200；任何单周期转移 <= 该值） */
  batchLimit?: number;
  /** retention 窗口（天）；缺省读 env（工程 baseline 30，min 1 max 3650） */
  retentionDays?: number;
};

export interface TerminalTombstoneSummary {
  dryRun: boolean;
  /** 实际 tombstone 转移数；dryRun 时 = 完整 candidate 数（只读计划） */
  tombstoned: number;
}

// ============================================================
// AsyncJob tombstone（§5/§6）
// ============================================================

/**
 * COMPLETED AsyncJob retention：只有 status = COMPLETED 且
 * completedAt <= cutoff 且 tombstonedAt IS NULL 的行参与；payload 收敛为
 * marker，诊断与 lease 字段清空，tombstonedAt = now。保留
 * id/kind/schemaVersion/dedupeKey/status/attempts/maxAttempts/completedAt/
 * createdAt/tombstonedAt（其中 dedupeKey UNIQUE 永不释放）。
 *
 * tombstoned 行安全性质（INV-9C04-02）：claim candidate 只含
 * PENDING/RETRY/RUNNING——COMPLETED+tombstoned 行永远不会再次 claim/进入
 * handler；requeueDeadLetterJobTx 只接受 DEAD_LETTER——不存在 tombstone
 * revive 路径；同 dedupeKey 的重复 enqueue 继续被 UNIQUE 命中（recorded=false）。
 */
export async function tombstoneCompletedAsyncJobs(
  options: RetentionMaintenanceOptions = {},
): Promise<TerminalTombstoneSummary> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();
  const batchLimit = options.batchLimit ?? DEFAULT_RETENTION_BATCH_LIMIT;
  const retentionDays = options.retentionDays ?? env.ASYNC_TERMINAL_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);

  const candidateWhere = {
    status: "COMPLETED" as const,
    completedAt: { lte: cutoff },
    tombstonedAt: null,
  };

  if (dryRun) {
    return { dryRun, tombstoned: await prisma.asyncJob.count({ where: candidateWhere }) };
  }

  const candidates = await prisma.asyncJob.findMany({
    where: candidateWhere,
    orderBy: [{ completedAt: "asc" }, { id: "asc" }],
    take: batchLimit,
    select: { id: true },
  });

  let tombstoned = 0;
  for (const candidate of candidates) {
    // fresh predicate（§23）：并发 worker 同时 discover 同一行时，
    // tombstonedAt IS NULL 谓词保证恰好一个赢得逻辑转移
    const result = await prisma.asyncJob.updateMany({
      where: { id: candidate.id, ...candidateWhere },
      data: {
        payload: PHASE9_RETENTION_TOMBSTONE_MARKER,
        lastErrorCode: null,
        lastErrorMessage: null,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        tombstonedAt: now,
      },
    });
    tombstoned += result.count;
  }

  return { dryRun, tombstoned };
}

// ============================================================
// OutboxEvent tombstone（§8）——与 AsyncJob 同构
// ============================================================

/**
 * PUBLISHED OutboxEvent retention：anchor 是 publishedAt；payload 收敛为
 * marker；保留 id/eventType/schemaVersion/aggregateType/aggregateId/
 * dedupeKey/status=PUBLISHED/publishedAt/createdAt/tombstonedAt。
 * tombstoned 行安全性质（INV-9C04-03）：claim candidate 只含
 * PENDING/PROCESSING——PUBLISHED 行永远不会再次 dispatch。
 */
export async function tombstonePublishedOutboxEvents(
  options: RetentionMaintenanceOptions = {},
): Promise<TerminalTombstoneSummary> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();
  const batchLimit = options.batchLimit ?? DEFAULT_RETENTION_BATCH_LIMIT;
  const retentionDays = options.retentionDays ?? env.ASYNC_TERMINAL_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);

  const candidateWhere = {
    status: "PUBLISHED" as const,
    publishedAt: { lte: cutoff },
    tombstonedAt: null,
  };

  if (dryRun) {
    return { dryRun, tombstoned: await prisma.outboxEvent.count({ where: candidateWhere }) };
  }

  const candidates = await prisma.outboxEvent.findMany({
    where: candidateWhere,
    orderBy: [{ publishedAt: "asc" }, { id: "asc" }],
    take: batchLimit,
    select: { id: true },
  });

  let tombstoned = 0;
  for (const candidate of candidates) {
    const result = await prisma.outboxEvent.updateMany({
      where: { id: candidate.id, ...candidateWhere },
      data: {
        payload: PHASE9_RETENTION_TOMBSTONE_MARKER,
        lastErrorCode: null,
        lastErrorMessage: null,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        tombstonedAt: now,
      },
    });
    tombstoned += result.count;
  }

  return { dryRun, tombstoned };
}

// ============================================================
// NotificationDelivery PII redaction（§16/§17）
// ============================================================

export interface NotificationRedactionSummary {
  dryRun: boolean;
  /** 实际 redaction 转移数；dryRun 时 = 完整 candidate 数（只读计划） */
  redacted: number;
}

/**
 * terminal EMAIL delivery contact snapshot retention：
 * destination（收件邮箱快照，DIRECT_IDENTITY / CONTACT_INFO）在 terminal
 * （providerAcceptedAt 或 suppressedAt）超过 cutoff 后收敛为
 * REDACTED_EMAIL_DESTINATION 哨兵 + redactedAt = now——PII 消失，delivery
 * provenance（provider / providerIdempotencyKey / providerMessageId /
 * firstAttemptAt / providerAcceptedAt / suppressedAt / suppressionCode）
 * 保留（§17：PII 消失，delivery provenance 保留）。
 *
 * pending 保护（§18/INV-9C04-06）：providerAcceptedAt 与 suppressedAt 皆空
 * 的行（无论 createdAt 多老）绝不是 candidate——worker 仍需要 destination
 * 发送。terminal anchor 是 providerAcceptedAt / suppressedAt，绝不是
 * createdAt（§21）。
 *
 * erasure interaction（§19/INV-9C04-08）：account erasure 的 immediate
 * redaction 同步设置 redactedAt（见 account-erasure.ts）——erasure race
 * authority 不变；本函数与 erasure 写同一谓词族（redactedAt IS NULL 条件
 * 转移），并发时恰好一个赢得转移，二者天然幂等。
 */
export async function redactTerminalNotificationDestinations(
  options: RetentionMaintenanceOptions = {},
): Promise<NotificationRedactionSummary> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();
  const batchLimit = options.batchLimit ?? DEFAULT_RETENTION_BATCH_LIMIT;
  const retentionDays =
    options.retentionDays ?? env.NOTIFICATION_DELIVERY_PII_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);

  const candidateWhere = {
    channel: NOTIFICATION_CHANNEL_EMAIL,
    redactedAt: null,
    OR: [{ providerAcceptedAt: { lte: cutoff } }, { suppressedAt: { lte: cutoff } }],
  };

  if (dryRun) {
    return {
      dryRun,
      redacted: await prisma.notificationDelivery.count({ where: candidateWhere }),
    };
  }

  const candidates = await prisma.notificationDelivery.findMany({
    where: candidateWhere,
    orderBy: [{ providerAcceptedAt: "asc" }, { id: "asc" }],
    take: batchLimit,
    select: { id: true },
  });

  let redacted = 0;
  for (const candidate of candidates) {
    // fresh predicate（§23）：redactedAt IS NULL + terminal-past-cutoff——
    // 并发 retention worker / erasure 路径同时命中时恰好一个赢得转移
    const result = await prisma.notificationDelivery.updateMany({
      where: {
        id: candidate.id,
        channel: NOTIFICATION_CHANNEL_EMAIL,
        redactedAt: null,
        OR: [
          { providerAcceptedAt: { lte: cutoff } },
          { suppressedAt: { lte: cutoff } },
        ],
      },
      data: {
        destination: REDACTED_EMAIL_DESTINATION,
        redactedAt: now,
      },
    });
    redacted += result.count;
  }

  return { dryRun, redacted };
}

// ============================================================
// NOTIFICATION_DELIVERY dead-letter reconcile（§12/§13/§14/§15）
// ============================================================

export interface NotificationDeadLetterReconciliationSummary {
  dryRun: boolean;
  /** 本周期进入 reconcile 的 DEAD_LETTER job 数（bounded） */
  scannedJobs: number;
  /** 实际 suppression 转移数；dryRun 时 = 候选转移数（只读计划） */
  reconciled: number;
  /** delivery 已 terminal（suppressed/accepted）的幂等跳过数 */
  alreadyResolved: number;
  /** 结构异常：job DEAD_LETTER 但 delivery 已 provider-accepted（§50，
   * 只报告计数，绝不改写 accepted provenance） */
  acceptedAnomalies: number;
  /** 结构异常：payload/dedupeKey 无法解析 deliveryId、或引用的 delivery
   * 缺失（§37 invariant violation，只报告计数，绝不猜测修复，§38） */
  unresolvedAnomalies: number;
}

/** NOTIFICATION_DELIVERY dedupeKey 前缀（写边界 buildNotificationDeliveryJobDedupeKey 契约）。 */
const NOTIFICATION_DELIVERY_DEDUPE_PREFIX = `${NOTIFICATION_DELIVERY_JOB_KIND}:`;

/**
 * 从 DEAD_LETTER job 解析 deliveryId：
 * 1. strict parse payload（§13 主路径）；
 * 2. fallback = dedupeKey 绑定（payload 损坏正是 DEAD_LETTER 成因之一，
 *    恰恰最需要收敛的 job 不能因解析失败被跳过——与 9C-03 导出 reconciler
 *    同一依据：dedupeKey 是写边界 enqueueAsyncJobTx 契约强制的权威绑定，
 *    不是猜测）；
 * 3. 两者皆不可解析 → null（调用方计 structural anomaly，绝不猜 id）。
 */
function resolveNotificationDeliveryId(
  payload: Prisma.JsonValue,
  dedupeKey: string,
): string | null {
  const parsed = notificationDeliveryPayloadSchema.safeParse(payload);
  if (parsed.success) {
    return parsed.data.deliveryId;
  }
  if (dedupeKey.startsWith(NOTIFICATION_DELIVERY_DEDUPE_PREFIX)) {
    const deliveryId = dedupeKey.slice(NOTIFICATION_DELIVERY_DEDUPE_PREFIX.length);
    if (deliveryId.length > 0) {
      return deliveryId;
    }
  }
  return null;
}

/**
 * bounded reconcile（§13）：只处理 AsyncJob.kind = NOTIFICATION_DELIVERY 且
 * status = DEAD_LETTER 的 job（generic DEAD_LETTER 不受影响；generic
 * requeueDeadLetterJobTx seam 保留，但 NOTIFICATION_DELIVERY 禁止经它盲目
 * 重发——§15，ops 文档明确）。对 delivery 的确定性收敛：
 *
 * - providerAcceptedAt != null → 不得 suppression（§50：accepted provenance
 *   是外部投递事实，reconcile 绝不改写；计 acceptedAnomalies 供 ops 关注）；
 * - suppressedAt != null → 幂等 no-op；
 * - 两者皆 null → suppressedAt = now + suppressionCode =
 *   NOTIFICATION_JOB_DEAD_LETTER（§14：dead-letter 投递不得 blind resend，
 *   terminal suppression 是正确收敛；重发必须显式新 intent）。
 *
 * 转移是 { id, providerAcceptedAt IS NULL, suppressedAt IS NULL } 条件更新
 *（§23 同款）：并发 reconcile / EMAIL worker 重放竞争时恰好一个赢家；
 * 重放的 job 见 suppressed → COMPLETED_IDEMPOTENT（0 provider call）。
 *
 * 未知结构异常（§38）只报告（unresolvedAnomalies），绝不自作主张修复。
 */
export async function reconcileDeadLetterNotificationDeliveries(
  options: Pick<RetentionMaintenanceOptions, "dryRun" | "now" | "batchLimit"> = {},
): Promise<NotificationDeadLetterReconciliationSummary> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();
  const batchLimit = options.batchLimit ?? DEFAULT_RETENTION_BATCH_LIMIT;

  const summary: NotificationDeadLetterReconciliationSummary = {
    dryRun,
    scannedJobs: 0,
    reconciled: 0,
    alreadyResolved: 0,
    acceptedAnomalies: 0,
    unresolvedAnomalies: 0,
  };

  const deadLetterJobs = await prisma.asyncJob.findMany({
    where: { kind: NOTIFICATION_DELIVERY_JOB_KIND, status: "DEAD_LETTER" },
    orderBy: [{ deadLetteredAt: "asc" }, { id: "asc" }],
    take: batchLimit,
    select: { id: true, payload: true, dedupeKey: true },
  });
  summary.scannedJobs = deadLetterJobs.length;

  for (const job of deadLetterJobs) {
    const deliveryId = resolveNotificationDeliveryId(job.payload, job.dedupeKey);
    if (!deliveryId) {
      summary.unresolvedAnomalies += 1;
      continue;
    }

    const delivery = await prisma.notificationDelivery.findUnique({
      where: { id: deliveryId },
      select: { id: true, providerAcceptedAt: true, suppressedAt: true },
    });
    if (!delivery) {
      // §37：unresolved DEAD_LETTER 引用缺失 delivery = invariant violation
      // ——report + fail strict（ops surface），绝不猜测修复（§38）
      summary.unresolvedAnomalies += 1;
      continue;
    }

    if (delivery.providerAcceptedAt !== null) {
      // §50：provider-accepted 的 dead-letter 异常——保留 accepted
      // provenance，绝不改写为 suppressed
      summary.acceptedAnomalies += 1;
      continue;
    }

    if (delivery.suppressedAt !== null) {
      summary.alreadyResolved += 1;
      continue;
    }

    if (dryRun) {
      summary.reconciled += 1;
      continue;
    }

    const updated = await prisma.notificationDelivery.updateMany({
      where: { id: delivery.id, providerAcceptedAt: null, suppressedAt: null },
      data: {
        suppressedAt: now,
        suppressionCode: NOTIFICATION_DELIVERY_SUPPRESSION_JOB_DEAD_LETTER,
      },
    });
    summary.reconciled += updated.count;
  }

  return summary;
}

// ============================================================
// 单周期 maintenance orchestrator（§26/§28/§29）
// ============================================================

export interface Phase9RetentionSummary {
  dryRun: boolean;
  asyncJobsTombstoned: number;
  outboxEventsTombstoned: number;
  notificationDeadLettersReconciled: number;
  notificationDestinationsRedacted: number;
  /** 本周期失败的 retention 子任务数（§29：> 0 时调用方必须把整周期
   * 视为 FAIL——绝不打印成功 summary；全部转移幂等，下轮继续安全） */
  phase9Failures: number;
}

/**
 * Phase 9 retention/reconcile 单周期入口（storage cleanup worker 的周期
 * cadence owner 调用；§26：不创建第二套 daemon，storage-cleanup 服务升级
 * 为 periodic cleanup / retention cadence owner）。四个 bounded 子任务
 * 顺序执行；单子任务失败计入 phase9Failures 并继续其余子任务（全部转移
 * 幂等，部分成功 → 下轮继续安全），观测只在实际 work > 0 时 INFO
 *（summary 只含 counts；失败日志只含 errorName，§63）。
 */
export async function runPhase9RetentionMaintenance(
  options: RetentionMaintenanceOptions = {},
): Promise<Phase9RetentionSummary> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();

  const summary: Phase9RetentionSummary = {
    dryRun,
    asyncJobsTombstoned: 0,
    outboxEventsTombstoned: 0,
    notificationDeadLettersReconciled: 0,
    notificationDestinationsRedacted: 0,
    phase9Failures: 0,
  };

  const subtasks: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: "async-job-tombstone",
      run: async () => {
        summary.asyncJobsTombstoned = (await tombstoneCompletedAsyncJobs({ ...options, now })).tombstoned;
      },
    },
    {
      name: "outbox-event-tombstone",
      run: async () => {
        summary.outboxEventsTombstoned = (await tombstonePublishedOutboxEvents({ ...options, now })).tombstoned;
      },
    },
    {
      name: "notification-dead-letter-reconcile",
      run: async () => {
        summary.notificationDeadLettersReconciled = (
          await reconcileDeadLetterNotificationDeliveries({ dryRun, now, batchLimit: options.batchLimit })
        ).reconciled;
      },
    },
    {
      name: "notification-destination-redaction",
      run: async () => {
        summary.notificationDestinationsRedacted = (
          await redactTerminalNotificationDestinations({ ...options, now })
        ).redacted;
      },
    },
  ];

  for (const subtask of subtasks) {
    try {
      await subtask.run();
    } catch (error) {
      summary.phase9Failures += 1;
      logger.error("Phase 9 retention 子任务失败，等待下轮重试", "phase9-retention", {
        event: "phase9_retention_subtask_failed",
        subtask: subtask.name,
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  const didWork =
    summary.asyncJobsTombstoned > 0 ||
    summary.outboxEventsTombstoned > 0 ||
    summary.notificationDeadLettersReconciled > 0 ||
    summary.notificationDestinationsRedacted > 0 ||
    summary.phase9Failures > 0;

  if (didWork && summary.phase9Failures === 0) {
    logger.info("Phase 9 retention 周期完成", "phase9-retention", {
      event: "phase9_retention_cycle_completed",
      ...summary,
    });
  }

  return summary;
}
