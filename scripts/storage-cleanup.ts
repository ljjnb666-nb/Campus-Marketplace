/**
 * 对象存储清理任务（可重复执行、幂等、支持 dry-run）：
 *
 *   npm run storage:cleanup            # 执行清理
 *   npm run storage:cleanup -- --dry-run   # 只打印计划不执行
 *
 * 覆盖三类目标（详见 docs/STORAGE.md）：
 * 1. 孤儿临时资源：上传后未绑定业务且超过 ASSET_ORPHAN_TTL_HOURS
 * 2. 保留期到期的敏感资源：审核完成后的学生证材料等
 * 3. PENDING_DELETE 重试：历史对象删除失败的资源
 */

import "dotenv/config";

import { runStorageCleanup } from "@/lib/asset-cleanup";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const summary = await runStorageCleanup({ dryRun });

  console.log(
    JSON.stringify(
      {
        dryRun: summary.dryRun,
        orphansMarked: summary.orphansMarked,
        retentionExpiredMarked: summary.retentionExpiredMarked,
        objectsDeleted: summary.objectsDeleted,
        quotaReleasedBytes: summary.quotaReleasedBytes,
        failures: summary.failures,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("[storage-cleanup] 执行失败:", error);
  process.exit(1);
});
