import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { prisma, withTransaction } from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { markArtifactDeletedIfPendingDelete } from "@/lib/privacy/data-export-artifact";

/**
 * Phase 9C-03：DataExportArtifact 清理任务（§27/§28，幂等、bounded、
 * crash-safe）。接入既有 storage cleanup 生产 topology（compose
 * storage-cleanup 服务 / npm run storage:cleanup），不创建第二套 daemon。
 *
 * 三步（每步独立可重试）：
 * 1. 到期（§26/§27）：READY + expiresAt <= now → PENDING_DELETE。
 *    PII object 绝不永久留置（本阶段自建 cleanup，不等 9C-04）。
 * 2. 孤儿 WRITING sweep（defense-in-depth）：request 已 terminal 但
 *    artifact 仍 WRITING 的组合在 canonical 代码路径中不可能出现
 *    （收敛/终局与 artifact 状态转移同事务）；本 sweep 覆盖手工改库 /
 *    历史迁移缺口。stale WRITING + 非终态 request 不动——那属于
 *    AsyncJob retry / dead-letter reconciler 的活跃工作面。
 * 3. 物理删除（§28）：PENDING_DELETE → S3 DeleteObject（幂等）→ 条件
 *    DELETED 转移（PENDING_DELETE 谓词，two workers 恰好一个完成逻辑
 *    转移；DeleteObject success + DB fail → 行保留 PENDING_DELETE，下轮
 *    重删重转，crash-safe）。
 *
 * DataHold 语义（§25）：DataExportArtifact = derived / ephemeral copy
 * （非 authoritative source record）——ACTIVE USER hold 不阻断 export
 * artifact 的到期清理（hold 的目的是保存 authoritative user/governance
 * data，绝不为 legal hold 永久保存用户自行生成的 JSON 副本）。
 */

const DEFAULT_BATCH_LIMIT = 200;

export interface DataExportCleanupSummary {
  dryRun: boolean;
  /** 到期 READY → PENDING_DELETE 标记数 */
  expiryMarked: number;
  /** 孤儿 WRITING sweep 标记数 */
  staleWritingMarked: number;
  /** 本轮物理删除并收敛 DELETED 的对象数 */
  objectsDeleted: number;
  failures: number;
}

export async function runDataExportArtifactCleanup(
  options: { dryRun?: boolean; now?: Date; batchLimit?: number } = {},
): Promise<DataExportCleanupSummary> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();
  const batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;

  const summary: DataExportCleanupSummary = {
    dryRun,
    expiryMarked: 0,
    staleWritingMarked: 0,
    objectsDeleted: 0,
    failures: 0,
  };

  // 1. 到期 READY → PENDING_DELETE（RB01：bounded）
  // discovery 与 authoritative transition 分离——discovery 只取本周期
  // batchLimit 个候选（expiresAt ASC, id ASC 确定序），真正的状态推进逐条
  // 以谓词条件更新执行（status=READY AND expiresAt<=now）。并发 cleanup
  // worker 可以 discover 同一候选：谓词语义保证恰好一个赢得转移，count
  // 只计实际转移行——任何单周期内到期推进至多 batchLimit，绝不一次
  // UPDATE 整个 backlog（backlog 再大也只能按周期分批收敛）。
  // dryRun 报告的是完整候选数（只读可观测性，不构成转移）。
  const expiryWhere = {
    status: "READY" as const,
    expiresAt: { lte: now },
  };

  if (dryRun) {
    summary.expiryMarked = await prisma.dataExportArtifact.count({ where: expiryWhere });
  } else {
    const expiryCandidates = await prisma.dataExportArtifact.findMany({
      where: expiryWhere,
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: batchLimit,
      select: { id: true },
    });

    for (const candidate of expiryCandidates) {
      const marked = await prisma.dataExportArtifact.updateMany({
        where: { id: candidate.id, status: "READY", expiresAt: { lte: now } },
        data: { status: "PENDING_DELETE" },
      });
      summary.expiryMarked += marked.count;
    }
  }

  // 2. 孤儿 WRITING sweep（request terminal 但 artifact 仍 WRITING）
  const staleWritingIds = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT a.id
    FROM "DataExportArtifact" a
    JOIN "PrivacyRequest" r ON r.id = a."requestId"
    WHERE a."status" = 'WRITING'
      AND r."status" IN ('REJECTED', 'CANCELLED', 'COMPLETED')
    ORDER BY a."updatedAt" ASC, a.id ASC
    LIMIT ${batchLimit}
  `;

  if (dryRun) {
    summary.staleWritingMarked = staleWritingIds.length;
  } else {
    for (const candidate of staleWritingIds) {
      const marked = await prisma.dataExportArtifact.updateMany({
        where: { id: candidate.id, status: "WRITING" },
        data: { status: "PENDING_DELETE" },
      });
      summary.staleWritingMarked += marked.count;
    }
  }

  // 3. 物理删除 PENDING_DELETE（含本轮与历史失败重试）
  const pendingDiscoveryWhere = { status: "PENDING_DELETE" as const };

  if (dryRun) {
    summary.objectsDeleted = await prisma.dataExportArtifact.count({
      where: pendingDiscoveryWhere,
    });
    return summary;
  }

  const pendingArtifacts = await prisma.dataExportArtifact.findMany({
    where: pendingDiscoveryWhere,
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: batchLimit,
    select: { id: true, bucket: true, objectKey: true },
  });

  const storage = getStorage();

  for (const artifact of pendingArtifacts) {
    try {
      // S3 delete 幂等：对象不存在视为成功（§28）
      // RB04：opaque diagnosticRef——失败日志不携带 raw locator
      await storage.deleteObject(
        { bucket: artifact.bucket, objectKey: artifact.objectKey },
        { diagnosticRef: `data-export:${artifact.id}` },
      );

      // 条件 DELETED 转移：two cleanup workers → one logical transition
      const deleted = await withTransaction((tx) =>
        markArtifactDeletedIfPendingDelete(tx, artifact.id, now),
      );

      if (deleted) {
        summary.objectsDeleted += 1;
      }
    } catch (error) {
      // 单条失败不中断批次：行保持 PENDING_DELETE，下轮自动重试
      summary.failures += 1;
      // RB04：只记 errorName——S3 error message 可能内嵌 bucket/key，
      // logSafe=false 的私有定位符不得进入结构化日志
      logger.error("导出 artifact 清理失败，下轮重试", "data-export-cleanup", {
        operation: "artifact-cleanup",
        artifactId: artifact.id,
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  if (
    summary.expiryMarked > 0 ||
    summary.staleWritingMarked > 0 ||
    summary.objectsDeleted > 0 ||
    summary.failures > 0
  ) {
    logger.info("导出 artifact 清理周期完成", "data-export-cleanup", {
      operation: "artifact-cleanup",
      ttlHours: env.DATA_EXPORT_ARTIFACT_TTL_HOURS,
      ...summary,
    });
  }

  return summary;
}
