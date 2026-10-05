import { prisma } from "@/lib/prisma";

/**
 * Phase 9C-04：Phase 9 ops snapshot（§31/§32，只读 machine-only surface）。
 *
 * 服务 ops CLI（npm run ops:phase9-status）与未来受控 ops 面；绝不新增
 * public API / admin UI（§33）。红线（§32/INV-9C04-12）：本 surface 只返回
 * counts / ages / safe machine status——payload、destination（收件邮箱）、
 * objectKey、bucket、providerMessageId、dedupeKey raw、lastErrorMessage
 * raw、任何 contact/storage secret 绝不出现（PHASE9-OPS-NO-SECRET-01 以
 * CLI stdout 全量捕获为证）。
 *
 * DEAD_LETTER 语义（§11/§35）：dead letter 是 operational attention，不是
 * readiness 依赖——本 snapshot 不影响 /api/ready（§40 同哲学：backlog 是
 * 后台观测面）；attentionRequired 只表达"需要人看"，不代表平台不可运行。
 */

export type Phase9AsyncJobsOps = {
  pending: number;
  retry: number;
  running: number;
  completed: number;
  /** COMPLETED 且 tombstonedAt != null（payload 已收敛为机器 marker） */
  tombstoned: number;
  deadLetter: number;
  /** 最老 runnable（PENDING/RETRY）job 距 runAt 的 age（毫秒；无 = null） */
  oldestDueAgeMs: number | null;
  /** 最老 DEAD_LETTER job 距 deadLetteredAt 的 age（毫秒；无 = null） */
  oldestDeadLetterAgeMs: number | null;
};

export type Phase9OutboxOps = {
  pending: number;
  processing: number;
  published: number;
  tombstoned: number;
  deadLetter: number;
  /** 最老 available（PENDING）event 距 availableAt 的 age（毫秒；无 = null） */
  oldestDueAgeMs: number | null;
  /** 最老 DEAD_LETTER event 距 deadLetteredAt 的 age（毫秒；无 = null） */
  oldestDeadLetterAgeMs: number | null;
};

export type Phase9EmailOps = {
  /** providerAcceptedAt != null 的 EMAIL delivery 数 */
  accepted: number;
  /** suppressedAt != null 的 EMAIL delivery 数 */
  suppressed: number;
  /** NOTIFICATION_DELIVERY DEAD_LETTER 且 delivery 未收敛（accepted 与
   * suppressed 皆空）的数量——bounded reconcile 的真实工作面（§11） */
  unresolvedDeadLetter: number;
  /** terminal 但尚未 PII redaction 的 EMAIL delivery 数（redaction backlog） */
  piiRedactionBacklog: number;
  /** 最老 runnable NOTIFICATION_DELIVERY job 的 age（毫秒；无 = null） */
  oldestPendingAgeMs: number | null;
};

export type Phase9ExportOps = {
  writing: number;
  ready: number;
  pendingDelete: number;
  deleted: number;
};

export type Phase9OpsSnapshot = {
  generatedAt: string;
  asyncJobs: Phase9AsyncJobsOps;
  outbox: Phase9OutboxOps;
  email: Phase9EmailOps;
  export: Phase9ExportOps;
  /** dead letter / unresolved reconcile backlog 存在（operational attention
   * 标记，非 readiness / 非平台不可运行判定，§36） */
  attentionRequired: boolean;
};

type CountOnly = { _count: { _all: number } };

function countByStatus(rows: Array<{ status: string } & CountOnly>): Map<string, number> {
  return new Map(rows.map((row) => [row.status, row._count._all]));
}

function ageMsFrom(from: Date | null, now: Date): number | null {
  return from === null ? null : Math.max(0, now.getTime() - from.getTime());
}

export async function getPhase9OpsSnapshot(now = new Date()): Promise<Phase9OpsSnapshot> {
  const [
    jobGrouped,
    outboxGrouped,
    jobOldestDue,
    jobOldestDead,
    outboxOldestDue,
    outboxOldestDead,
    jobsTombstoned,
    outboxTombstoned,
  ] = await Promise.all([
    prisma.asyncJob.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.outboxEvent.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.asyncJob.findFirst({
      where: { status: { in: ["PENDING", "RETRY"] } },
      orderBy: { runAt: "asc" },
      select: { runAt: true },
    }),
    prisma.asyncJob.findFirst({
      where: { status: "DEAD_LETTER" },
      orderBy: { deadLetteredAt: "asc" },
      select: { deadLetteredAt: true },
    }),
    prisma.outboxEvent.findFirst({
      where: { status: "PENDING" },
      orderBy: { availableAt: "asc" },
      select: { availableAt: true },
    }),
    prisma.outboxEvent.findFirst({
      where: { status: "DEAD_LETTER" },
      orderBy: { deadLetteredAt: "asc" },
      select: { deadLetteredAt: true },
    }),
    prisma.asyncJob.count({ where: { status: "COMPLETED", tombstonedAt: { not: null } } }),
    prisma.outboxEvent.count({ where: { status: "PUBLISHED", tombstonedAt: { not: null } } }),
  ]);

  const jobs = countByStatus(jobGrouped);
  const outbox = countByStatus(outboxGrouped);

  const [emailAccepted, emailSuppressed, unresolvedDeadLetter, piiRedactionBacklog, notificationJobOldest] =
    await Promise.all([
      prisma.notificationDelivery.count({
        where: { channel: "EMAIL", providerAcceptedAt: { not: null } },
      }),
      prisma.notificationDelivery.count({
        where: { channel: "EMAIL", suppressedAt: { not: null } },
      }),
      // dedupeKey 绑定 join（写边界 NOTIFICATION_DELIVERY:<deliveryId> 契约）：
      // 未收敛 = delivery 的 accepted/suppressed 皆空——bounded reconcile 的工作面
      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count
        FROM "AsyncJob" j
        JOIN "NotificationDelivery" d
          ON j."dedupeKey" = 'NOTIFICATION_DELIVERY:' || d.id
        WHERE j."kind" = 'NOTIFICATION_DELIVERY'
          AND j."status" = 'DEAD_LETTER'
          AND d."providerAcceptedAt" IS NULL
          AND d."suppressedAt" IS NULL
      `,
      prisma.notificationDelivery.count({
        where: {
          channel: "EMAIL",
          redactedAt: null,
          OR: [{ providerAcceptedAt: { not: null } }, { suppressedAt: { not: null } }],
        },
      }),
      prisma.asyncJob.findFirst({
        where: { kind: "NOTIFICATION_DELIVERY", status: { in: ["PENDING", "RETRY"] } },
        orderBy: { runAt: "asc" },
        select: { runAt: true },
      }),
    ]);

  const [exportWriting, exportReady, exportPendingDelete, exportDeleted] = await Promise.all([
    prisma.dataExportArtifact.count({ where: { status: "WRITING" } }),
    prisma.dataExportArtifact.count({ where: { status: "READY" } }),
    prisma.dataExportArtifact.count({ where: { status: "PENDING_DELETE" } }),
    prisma.dataExportArtifact.count({ where: { status: "DELETED" } }),
  ]);

  const jobDeadLetter = jobs.get("DEAD_LETTER") ?? 0;
  const outboxDeadLetter = outbox.get("DEAD_LETTER") ?? 0;
  const unresolved = Number(unresolvedDeadLetter[0]?.count ?? BigInt(0));

  return {
    generatedAt: now.toISOString(),
    asyncJobs: {
      pending: jobs.get("PENDING") ?? 0,
      retry: jobs.get("RETRY") ?? 0,
      running: jobs.get("RUNNING") ?? 0,
      completed: jobs.get("COMPLETED") ?? 0,
      tombstoned: jobsTombstoned,
      deadLetter: jobDeadLetter,
      oldestDueAgeMs: ageMsFrom(jobOldestDue?.runAt ?? null, now),
      oldestDeadLetterAgeMs: ageMsFrom(jobOldestDead?.deadLetteredAt ?? null, now),
    },
    outbox: {
      pending: outbox.get("PENDING") ?? 0,
      processing: outbox.get("PROCESSING") ?? 0,
      published: outbox.get("PUBLISHED") ?? 0,
      tombstoned: outboxTombstoned,
      deadLetter: outboxDeadLetter,
      oldestDueAgeMs: ageMsFrom(outboxOldestDue?.availableAt ?? null, now),
      oldestDeadLetterAgeMs: ageMsFrom(outboxOldestDead?.deadLetteredAt ?? null, now),
    },
    email: {
      accepted: emailAccepted,
      suppressed: emailSuppressed,
      unresolvedDeadLetter: unresolved,
      piiRedactionBacklog: piiRedactionBacklog,
      oldestPendingAgeMs: ageMsFrom(notificationJobOldest?.runAt ?? null, now),
    },
    export: {
      writing: exportWriting,
      ready: exportReady,
      pendingDelete: exportPendingDelete,
      deleted: exportDeleted,
    },
    attentionRequired: jobDeadLetter > 0 || outboxDeadLetter > 0 || unresolved > 0,
  };
}

// ============================================================
// Structural inconsistency checks（§36/§37，--strict 判定依据）
// ============================================================

export type Phase9StructuralInconsistencies = {
  /** COMPLETED 但 completedAt 为空 */
  completedJobsMissingTerminalAt: number;
  /** PUBLISHED 但 publishedAt 为空 */
  publishedEventsMissingPublishedAt: number;
  /** redactedAt 已设但 destination 仍是真实值（未收敛哨兵） */
  redactedDeliveriesWithLiveDestination: number;
  /** NOTIFICATION_DELIVERY DEAD_LETTER 引用缺失 delivery */
  deadLetterJobsWithMissingDelivery: number;
  /** READY artifact 缺失 expiresAt（下载窗口 authority） */
  readyArtifactsMissingExpiry: number;
  /** 任一 > 0 */
  any: boolean;
};

/**
 * 只读 structural invariant 检查（§37 示例集）。这些是 invariant violation
 * （canonical 代码路径不可能产生），--strict CLI 据此 exit non-zero。
 * 本函数绝不修复任何状态（§38：未知结构异常 report + fail strict）。
 */
export async function getPhase9StructuralInconsistencies(): Promise<Phase9StructuralInconsistencies> {
  // dedupeKey 绑定 join：DEAD_LETTER 引用缺失 delivery（§37）
  const missingDeliveryRows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "AsyncJob" j
    WHERE j."kind" = 'NOTIFICATION_DELIVERY'
      AND j."status" = 'DEAD_LETTER'
      AND NOT EXISTS (
        SELECT 1 FROM "NotificationDelivery" d
        WHERE j."dedupeKey" = 'NOTIFICATION_DELIVERY:' || d.id
      )
  `;

  const [completedMissing, publishedMissing, redactedLive, readyNoExpiry] = await Promise.all([
    prisma.asyncJob.count({ where: { status: "COMPLETED", completedAt: null } }),
    prisma.outboxEvent.count({ where: { status: "PUBLISHED", publishedAt: null } }),
    // REDACTED_EMAIL_DESTINATION = ""（notification-delivery.ts SSOT 哨兵）：
    // redactedAt 已设的行 destination 必须已收敛为哨兵——raw SQL 以
    // destination <> '' 表达同一谓词（字面量与 SSOT 常量的一致性由
    // PHASE9-OPS 测试锁定）
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "NotificationDelivery"
      WHERE "redactedAt" IS NOT NULL
        AND "destination" <> ''
    `,
    prisma.dataExportArtifact.count({ where: { status: "READY", expiresAt: null } }),
  ]);

  const result: Phase9StructuralInconsistencies = {
    completedJobsMissingTerminalAt: completedMissing,
    publishedEventsMissingPublishedAt: publishedMissing,
    redactedDeliveriesWithLiveDestination: Number(redactedLive[0]?.count ?? BigInt(0)),
    deadLetterJobsWithMissingDelivery: Number(missingDeliveryRows[0]?.count ?? BigInt(0)),
    readyArtifactsMissingExpiry: readyNoExpiry,
    any: false,
  };
  result.any =
    result.completedJobsMissingTerminalAt > 0 ||
    result.publishedEventsMissingPublishedAt > 0 ||
    result.redactedDeliveriesWithLiveDestination > 0 ||
    result.deadLetterJobsWithMissingDelivery > 0 ||
    result.readyArtifactsMissingExpiry > 0;
  return result;
}
