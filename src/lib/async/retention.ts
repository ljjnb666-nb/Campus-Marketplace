import type { Prisma } from "@prisma/client";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  NOTIFICATION_DELIVERY_JOB_KIND,
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
 * erasure interaction（§19/INV-9C04-08 + Review R1 RB03/INV-R1-05/06/07）：
 * account erasure 的 immediate redaction 同步设置 redactedAt（account-
 * erasure.ts Step 3，redactedAt IS NULL 条件回填）——redactedAt 是
 * 【第一次将 destination 收敛为 redacted sentinel 的时间】（NULL →
 * timestamp 单向迁移，绝不 timestamp → newer / → null）；retention 与
 * erasure 并发时无论谁先，最终 destination 为 sentinel 且首次 transition
 * 的时间戳保留（后到路径条件谓词不命中，零覆盖）。erasure 的 destination
 * 写入是无条件的（INV-R1-06：注销后 destination 必须立即 redacted，即便
 * redactedAt 已存在）；本函数的 destination 写入仅发生在 redactedAt IS NULL
 * 的候选上——二者组合覆盖全部并发顺序。
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
// NOTIFICATION_DELIVERY dead-letter reconcile（§12/§13/§14/§15；
// Review R1 RB01/RB02 修复后合同）
// ============================================================

export interface NotificationDeadLetterReconciliationSummary {
  dryRun: boolean;
  /** 本周期 discovery 命中的 canonical actionable 候选数（bounded；resolved /
   * anomaly / structural corruption 行不占 batch——INV-R1-01） */
  scannedCanonical: number;
  /** 实际 suppression 转移数；dryRun 时 = canonical 候选数（只读计划） */
  reconciled: number;
}

/** NOTIFICATION_DELIVERY dedupeKey 前缀（写边界 buildNotificationDeliveryJobDedupeKey 契约）。 */
const NOTIFICATION_DELIVERY_DEDUPE_PREFIX = `${NOTIFICATION_DELIVERY_JOB_KIND}:`;

/**
 * canonical reconciliable binding（RB02 新权威合同，INV-R1-02）：
 *
 *   payload strict parse PASS（zod .strict() 等价谓词：jsonb object +
 *   恰好一个键 deliveryId + 非空 string——SQL CASE 双层嵌套保证
 *   jsonb_object_keys 只在 object 分支求值）
 *
 *   AND dedupeKey == buildNotificationDeliveryJobDedupeKey(payload.deliveryId)
 *
 *   AND delivery 存在
 *
 * 三个条件全部在【discovery SQL 谓词层】强制——payload 与 dedupeKey 不一致
 * （如 payload.deliveryId=B 而 dedupeKey=NOTIFICATION_DELIVERY:A）的行
 * 绝不进入 automatic reconciliation batch（不同代码路径会认不同 delivery，
 * 自动 suppress 任一方都是正确性错误）。dedupeKey 只用于 structural
 * validation（与 payload 的一致性证明），绝不在 payload invalid 时充当
 * replacement authority（INV-R1-03：structural corruption 只报告不猜修）。
 */

/**
 * bounded reconcile（RB01/RB02 修复后）：
 *
 * - fairness（INV-R1-01）：candidate discovery 在 SQL 层只选择【canonical
 *   binding + unresolved delivery】的行——已 suppressed、provider-accepted
 *   异常、invalid payload、binding mismatch、missing delivery 全部不占
 *   batch（ORDER BY deadLetteredAt, id LIMIT batchLimit 只作用于真正
 *   actionable backlog，有限 backlog 必然有限轮次内收敛）。
 * - 收敛动作（§14）：suppressedAt = now + suppressionCode =
 *   NOTIFICATION_JOB_DEAD_LETTER（dead-letter 投递不得 blind resend；
 *   重发必须显式新 intent）。条件更新
 *   { id, providerAcceptedAt IS NULL, suppressedAt IS NULL }——并发
 *   reconcile / worker 重放竞争时恰好一个赢家；重放 job 见 suppressed →
 *   COMPLETED_IDEMPOTENT（0 provider call）。
 * - anomaly 可见性（§6/§12/§31）：accepted/invalid/binding/missing 的
 *   structural counts 由 phase9-ops 的只读 structural path 提供（与
 *   reconcile discovery 分离——绝不为 summary 把 anomaly 行塞回主 batch），
 *   strict CLI 据此 FAIL（§33）。
 *
 * 与 9C-03 导出 reconciler 的差异说明：本函数不再做 per-job payload
 * 解析分类——分类职责整体移入 ops structural path；reconcile path 只消费
 * 已被 SQL 证明 canonical 的 actionable 候选。
 */
export async function reconcileDeadLetterNotificationDeliveries(
  options: Pick<RetentionMaintenanceOptions, "dryRun" | "now" | "batchLimit"> = {},
): Promise<NotificationDeadLetterReconciliationSummary> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();
  const batchLimit = options.batchLimit ?? DEFAULT_RETENTION_BATCH_LIMIT;

  const candidates = await prisma.$queryRaw<Array<{ jobId: string; deliveryId: string }>>`
    SELECT j.id AS "jobId", d.id AS "deliveryId"
    FROM "AsyncJob" j
    JOIN "NotificationDelivery" d
      ON j."dedupeKey" = ${NOTIFICATION_DELIVERY_DEDUPE_PREFIX} || d.id
    WHERE j."kind" = ${NOTIFICATION_DELIVERY_JOB_KIND}
      AND j."status" = 'DEAD_LETTER'
      AND CASE
            WHEN jsonb_typeof(j.payload) = 'object' THEN
              CASE
                WHEN (SELECT COUNT(*) FROM jsonb_object_keys(j.payload)) = 1
                  AND jsonb_typeof(j.payload->'deliveryId') = 'string'
                  AND j.payload->>'deliveryId' <> ''
                THEN j.payload->>'deliveryId'
              END
          END = d.id
      AND d."providerAcceptedAt" IS NULL
      AND d."suppressedAt" IS NULL
    ORDER BY j."deadLetteredAt" ASC NULLS LAST, j.id ASC
    LIMIT ${batchLimit}
  `;

  const summary: NotificationDeadLetterReconciliationSummary = {
    dryRun,
    scannedCanonical: candidates.length,
    // dryRun：reconciled = canonical 候选数（只读计划，与 §25 planned 语义
    // 一致——orchestrator 的 notificationDeadLettersReconciled 据此上报
    // dry-run 计划量）；实际执行路径下方逐条条件转移累计
    reconciled: dryRun ? candidates.length : 0,
  };

  if (dryRun) {
    return summary;
  }

  for (const candidate of candidates) {
    const updated = await prisma.notificationDelivery.updateMany({
      where: { id: candidate.deliveryId, providerAcceptedAt: null, suppressedAt: null },
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
