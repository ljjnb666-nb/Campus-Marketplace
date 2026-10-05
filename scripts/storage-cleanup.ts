/**
 * 对象存储清理 + Phase 9 retention 任务（可重复执行、幂等、支持 dry-run）：
 *
 *   npm run storage:cleanup            # 执行完整一轮
 *   npm run storage:cleanup -- --dry-run   # 只打印计划不执行
 *
 * 覆盖目标（详见 docs/STORAGE.md / docs/PHASE9_OPERATIONS.md）：
 * 1. 孤儿临时资源：上传后未绑定业务且超过 ASSET_ORPHAN_TTL_HOURS
 * 2. 保留期到期的敏感资源：审核完成后的学生证材料等
 * 3. PENDING_DELETE 重试：历史对象删除失败的资源
 * 4. Phase 9C-03：导出 artifact 到期/stale 标记 + 物理删除
 * 5. Phase 9C-04：Phase 9 retention/reconcile（AsyncJob/OutboxEvent
 *    tombstone、NotificationDelivery PII redaction、dead-letter reconcile）
 *
 * 与生产 worker（scripts/ops/storage-cleanup-worker.ts）执行同一完整周期
 * （storage cleanup + Phase 9 retention，§34 同一操作入口，不产生第二套
 * 命令所有权）；retention 子任务失败（phase9Failures > 0）→ exit 1。
 */

import "dotenv/config";

import { runStorageCleanup } from "@/lib/asset-cleanup";
import { runPhase9RetentionMaintenance } from "@/lib/async/retention";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const summary = await runStorageCleanup({ dryRun });
  const phase9 = await runPhase9RetentionMaintenance({ dryRun });

  console.log(
    JSON.stringify(
      {
        dryRun: summary.dryRun,
        orphansMarked: summary.orphansMarked,
        retentionExpiredMarked: summary.retentionExpiredMarked,
        retentionHoldBlocked: summary.retentionHoldBlocked,
        objectsDeleted: summary.objectsDeleted,
        quotaReleasedBytes: summary.quotaReleasedBytes,
        purgeHoldBlocked: summary.purgeHoldBlocked,
        failures: summary.failures,
        dataExportArtifactsMarked: summary.dataExportArtifactsMarked,
        dataExportObjectsDeleted: summary.dataExportObjectsDeleted,
        dataExportFailures: summary.dataExportFailures,
        asyncJobsTombstoned: phase9.asyncJobsTombstoned,
        outboxEventsTombstoned: phase9.outboxEventsTombstoned,
        notificationDeadLettersReconciled: phase9.notificationDeadLettersReconciled,
        notificationDestinationsRedacted: phase9.notificationDestinationsRedacted,
        phase9Failures: phase9.phase9Failures,
      },
      null,
      2,
    ),
  );

  if (phase9.phase9Failures > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("[storage-cleanup] 执行失败:", error);
  process.exit(1);
});
