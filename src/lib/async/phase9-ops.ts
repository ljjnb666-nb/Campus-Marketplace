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
 *
 * Review R1（RB01/RB02）后语义冻结：
 * - email.unresolvedDeadLetter = canonical actionable unresolved dead-letter
 *  （payload strict-parseable + dedupeKey == canonical key + delivery 存在
 *   + accepted/suppressed 皆空）——与 reconcile discovery 同一谓词；
 * - structural corruption（invalid payload / binding mismatch / missing
 *   delivery / accepted anomaly）单独计数（notificationDeadLetterAnomalies），
 *   不与 actionable backlog 混算（§31）。
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
  /** canonical actionable unresolved dead-letter（RB01/RB02 修复后语义）：
   * NOTIFICATION_DELIVERY DEAD_LETTER 且 payload/dedupeKey canonical binding
   * 且 delivery 存在且 accepted/suppressed 皆空——bounded reconcile 的真实
   * 工作面；structural corruption 不计入（见 notificationDeadLetterAnomalies） */
  unresolvedDeadLetter: number;
  /** terminal 但尚未 PII redaction 的 EMAIL delivery 数（redaction backlog） */
  piiRedactionBacklog: number;
  /** 最老 runnable NOTIFICATION_DELIVERY job 的 age（毫秒；无 = null） */
  oldestPendingAgeMs: number | null;
};

/**
 * RB02（§12）：NOTIFICATION_DELIVERY dead-letter structural anomaly counts
 * （machine-only，只计数，绝不输出 payload / dedupeKey raw / deliveryId
 * raw / 任何 contact 信息）。与 reconcile discovery 使用同一 canonical
 * binding 谓词，分类互斥、首中即停：invalidPayload → bindingMismatch →
 * missingDelivery → acceptedAnomaly。canonical binding 且 delivery
 * unresolved 的行不计入本组（那是 actionable backlog = email.unresolvedDeadLetter）。
 */
export type Phase9NotificationDeadLetterAnomalies = {
  /** payload 不是 strict { deliveryId: string(min1) } 单键对象 */
  invalidPayload: number;
  /** payload 可解析但 dedupeKey != NOTIFICATION_DELIVERY:<payload.deliveryId> */
  bindingMismatch: number;
  /** binding canonical 但引用的 delivery 行缺失 */
  missingDelivery: number;
  /** binding canonical 且 delivery 已 provider-accepted——job 说 DEAD_LETTER
   * 而 delivery 说 provider accepted = contradictory terminal provenance */
  acceptedAnomaly: number;
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
  notificationDeadLetterAnomalies: Phase9NotificationDeadLetterAnomalies;
  export: Phase9ExportOps;
  /** dead letter / unresolved reconcile backlog / structural anomaly 任一存在
   * （operational attention 标记，非 readiness / 非平台不可运行判定，§36/§32） */
  attentionRequired: boolean;
};

type CountOnly = { _count: { _all: number } };

function countByStatus(rows: Array<{ status: string } & CountOnly>): Map<string, number> {
  return new Map(rows.map((row) => [row.status, row._count._all]));
}

function ageMsFrom(from: Date | null, now: Date): number | null {
  return from === null ? null : Math.max(0, now.getTime() - from.getTime());
}

/**
 * NOTIFICATION_DELIVERY dead-letter 分类（RB01/RB02 单遍 SQL）。
 *
 * canonical payload 谓词（zod notificationDeliveryPayloadSchema .strict()
 * 的 SQL 等价：jsonb object + 恰好一个键 deliveryId + 非空 string）——
 * CASE 双层嵌套保证 jsonb_object_keys 只在 object 分支求值（PostgreSQL
 * 不保证 AND 操作数求值顺序，标量 payload 绝不能进入 keys 展开）。
 *
 * 分类互斥（首中即停）：
 *   canonical_id IS NULL                                    → invalidPayload
 *   canonical_id 非空 且 dedupeKey != 'ND:' || canonical_id → bindingMismatch
 *   binding 一致 且 delivery 缺失（LEFT JOIN d.id IS NULL）  → missingDelivery
 *   binding 一致 且 delivery 存在 且 providerAcceptedAt     → acceptedAnomaly
 *   binding 一致 且 delivery 存在 且 accepted/suppressed 皆空 → canonical
 *                                                             actionable
 */
async function classifyNotificationDeadLetterJobs() {
  return prisma.$queryRaw<
    Array<{
      unresolved: bigint;
      invalid_payload: bigint;
      binding_mismatch: bigint;
      missing_delivery: bigint;
      accepted_anomaly: bigint;
    }>
  >`
    SELECT
      (COUNT(*) FILTER (WHERE s.canonical_id IS NOT NULL
                         AND s.binding_canonical
                         AND s.delivery_id IS NOT NULL
                         AND s.provider_accepted_at IS NULL
                         AND s.suppressed_at IS NULL))::bigint AS unresolved,
      (COUNT(*) FILTER (WHERE s.canonical_id IS NULL))::bigint AS invalid_payload,
      (COUNT(*) FILTER (WHERE s.canonical_id IS NOT NULL
                         AND NOT s.binding_canonical))::bigint AS binding_mismatch,
      (COUNT(*) FILTER (WHERE s.canonical_id IS NOT NULL
                         AND s.binding_canonical
                         AND s.delivery_id IS NULL))::bigint AS missing_delivery,
      (COUNT(*) FILTER (WHERE s.canonical_id IS NOT NULL
                         AND s.binding_canonical
                         AND s.delivery_id IS NOT NULL
                         AND s.provider_accepted_at IS NOT NULL))::bigint AS accepted_anomaly
    FROM (
      SELECT
        j."dedupeKey" AS dedupe_key,
        c.canonical_id,
        (j."dedupeKey" = 'NOTIFICATION_DELIVERY:' || c.canonical_id) AS binding_canonical,
        d.id AS delivery_id,
        d."providerAcceptedAt" AS provider_accepted_at,
        d."suppressedAt" AS suppressed_at
      FROM "AsyncJob" j
      LEFT JOIN "NotificationDelivery" d
        ON j."dedupeKey" = 'NOTIFICATION_DELIVERY:' || d.id
      CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN jsonb_typeof(j.payload) = 'object' THEN
                   CASE
                     WHEN (SELECT COUNT(*) FROM jsonb_object_keys(j.payload)) = 1
                       AND jsonb_typeof(j.payload->'deliveryId') = 'string'
                       AND j.payload->>'deliveryId' <> ''
                     THEN j.payload->>'deliveryId'
                   END
               END AS canonical_id
      ) c
      WHERE j."kind" = 'NOTIFICATION_DELIVERY'
        AND j."status" = 'DEAD_LETTER'
    ) s
  `;
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

  const [emailAccepted, emailSuppressed, deadLetterClassification, piiRedactionBacklog, notificationJobOldest] =
    await Promise.all([
      prisma.notificationDelivery.count({
        where: { channel: "EMAIL", providerAcceptedAt: { not: null } },
      }),
      prisma.notificationDelivery.count({
        where: { channel: "EMAIL", suppressedAt: { not: null } },
      }),
      classifyNotificationDeadLetterJobs(),
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
  const classification = deadLetterClassification[0];
  const unresolved = Number(classification?.unresolved ?? BigInt(0));
  const anomalies: Phase9NotificationDeadLetterAnomalies = {
    invalidPayload: Number(classification?.invalid_payload ?? BigInt(0)),
    bindingMismatch: Number(classification?.binding_mismatch ?? BigInt(0)),
    missingDelivery: Number(classification?.missing_delivery ?? BigInt(0)),
    acceptedAnomaly: Number(classification?.accepted_anomaly ?? BigInt(0)),
  };
  const anyAnomaly =
    anomalies.invalidPayload > 0 ||
    anomalies.bindingMismatch > 0 ||
    anomalies.missingDelivery > 0 ||
    anomalies.acceptedAnomaly > 0;

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
    notificationDeadLetterAnomalies: anomalies,
    export: {
      writing: exportWriting,
      ready: exportReady,
      pendingDelete: exportPendingDelete,
      deleted: exportDeleted,
    },
    attentionRequired:
      jobDeadLetter > 0 || outboxDeadLetter > 0 || unresolved > 0 || anyAnomaly,
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
  /** NOTIFICATION_DELIVERY DEAD_LETTER payload 不是 strict { deliveryId } 单键对象 */
  notificationDeadLetterInvalidPayload: number;
  /** payload 与 dedupeKey binding 不一致（RB02：绝不自动 mutation） */
  notificationDeadLetterBindingMismatch: number;
  /** canonical binding 但引用的 delivery 缺失 */
  notificationDeadLetterMissingDelivery: number;
  /** binding canonical 且 delivery 已 provider-accepted（矛盾 terminal
   * provenance；§33 决议：strict FAIL——canonical 代码路径不可能产生） */
  notificationDeadLetterAcceptedAnomaly: number;
  /** READY artifact 缺失 expiresAt（下载窗口 authority） */
  readyArtifactsMissingExpiry: number;
  /** 任一 > 0 */
  any: boolean;
};

/**
 * 只读 structural invariant 检查（§37 示例集 + RB02 扩展）。这些是
 * invariant violation（canonical 代码路径不可能产生），--strict CLI 据此
 * exit non-zero。本函数绝不修复任何状态（§38：未知结构异常 report +
 * fail strict）。
 */
export async function getPhase9StructuralInconsistencies(): Promise<Phase9StructuralInconsistencies> {
  const [completedMissing, publishedMissing, redactedLive, readyNoExpiry, notificationDeadLetter] =
    await Promise.all([
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
      classifyNotificationDeadLetterJobs(),
    ]);

  const nd = notificationDeadLetter[0];
  const result: Phase9StructuralInconsistencies = {
    completedJobsMissingTerminalAt: completedMissing,
    publishedEventsMissingPublishedAt: publishedMissing,
    redactedDeliveriesWithLiveDestination: Number(redactedLive[0]?.count ?? BigInt(0)),
    notificationDeadLetterInvalidPayload: Number(nd?.invalid_payload ?? BigInt(0)),
    notificationDeadLetterBindingMismatch: Number(nd?.binding_mismatch ?? BigInt(0)),
    notificationDeadLetterMissingDelivery: Number(nd?.missing_delivery ?? BigInt(0)),
    notificationDeadLetterAcceptedAnomaly: Number(nd?.accepted_anomaly ?? BigInt(0)),
    readyArtifactsMissingExpiry: readyNoExpiry,
    any: false,
  };
  result.any =
    result.completedJobsMissingTerminalAt > 0 ||
    result.publishedEventsMissingPublishedAt > 0 ||
    result.redactedDeliveriesWithLiveDestination > 0 ||
    result.notificationDeadLetterInvalidPayload > 0 ||
    result.notificationDeadLetterBindingMismatch > 0 ||
    result.notificationDeadLetterMissingDelivery > 0 ||
    result.notificationDeadLetterAcceptedAnomaly > 0 ||
    result.readyArtifactsMissingExpiry > 0;
  return result;
}
