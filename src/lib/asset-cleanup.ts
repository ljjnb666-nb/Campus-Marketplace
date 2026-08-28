import type { AssetStatus } from "@prisma/client";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { batchCount, purgePendingDeleteAsset } from "@/lib/asset-service";

/**
 * 存储清理任务（可重复执行、幂等、支持 dry-run）：
 *
 * 1. 孤儿/僵死回收：UPLOADING（预留后崩溃，对象可能存在也可能不存在）与
 *    UPLOADED（上传完成但未绑定业务）超过 ASSET_ORPHAN_TTL_HOURS 的资源
 *    → 标记 PENDING_DELETE（对象删除幂等，两种情形都安全）
 * 2. 保留期到期：expiresAt 已过的敏感资源（如审核完成后的学生证材料）
 *    → 标记 PENDING_DELETE；认证结论等业务数据不受影响
 * 3. 物理清理：所有 PENDING_DELETE 资源删除远端对象 → 单事务完成
 *    DELETED 转移 + 配额减额（exactly-once，并发 worker 安全）；
 *    失败保留 PENDING_DELETE，下次执行自动重试（CASE F）
 */

export interface CleanupSummary {
  dryRun: boolean;
  orphansMarked: number;
  retentionExpiredMarked: number;
  objectsDeleted: number;
  quotaReleasedBytes: number;
  failures: number;
}

export interface CleanupOptions {
  dryRun?: boolean;
  now?: Date;
  /** 单次物理清理的最大资源数（防长事务/内存压力） */
  batchLimit?: number;
}

const DEFAULT_BATCH_LIMIT = 200;

export async function runStorageCleanup(options: CleanupOptions = {}): Promise<CleanupSummary> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();
  const batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;

  const summary: CleanupSummary = {
    dryRun,
    orphansMarked: 0,
    retentionExpiredMarked: 0,
    objectsDeleted: 0,
    quotaReleasedBytes: 0,
    failures: 0,
  };

  // 1. 孤儿与僵死资源：UPLOADING（崩溃遗留，对象可能存在）+ UPLOADED（未绑定业务）
  const orphanCutoff = new Date(now.getTime() - env.ASSET_ORPHAN_TTL_HOURS * 60 * 60 * 1000);
  const orphanWhere = {
    status: { in: ["UPLOADING", "UPLOADED"] as AssetStatus[] },
    createdAt: { lt: orphanCutoff },
  };
  if (dryRun) {
    summary.orphansMarked = await prisma.uploadedAsset.count({ where: orphanWhere });
  } else {
    const marked = await prisma.uploadedAsset.updateMany({
      where: orphanWhere,
      data: { status: "PENDING_DELETE" },
    });
    summary.orphansMarked = batchCount(marked);
  }

  // 2. 保留期到期的敏感资源
  const expiredWhere = {
    expiresAt: { lt: now },
    status: { in: ["UPLOADED", "ATTACHED"] as AssetStatus[] },
  };
  if (dryRun) {
    summary.retentionExpiredMarked = await prisma.uploadedAsset.count({ where: expiredWhere });
  } else {
    const marked = await prisma.uploadedAsset.updateMany({
      where: expiredWhere,
      data: { status: "PENDING_DELETE" },
    });
    summary.retentionExpiredMarked = batchCount(marked);
  }

  if (dryRun) {
    const pendingCount = await prisma.uploadedAsset.count({
      where: { status: "PENDING_DELETE" },
    });
    summary.objectsDeleted = pendingCount;
    return summary;
  }

  // 3. 物理清理 PENDING_DELETE（含本轮与历史失败重试）
  const pendingAssets = await prisma.uploadedAsset.findMany({
    where: { status: "PENDING_DELETE" },
    orderBy: { createdAt: "asc" },
    take: batchLimit,
    select: {
      id: true,
      ownerId: true,
      bucket: true,
      objectKey: true,
      sizeBytes: true,
    },
  });

  for (const asset of pendingAssets) {
    try {
      const purged = await purgePendingDeleteAsset(asset);
      if (purged) {
        summary.objectsDeleted += 1;
        summary.quotaReleasedBytes += asset.sizeBytes;
      }
      // purged=false：条件转移被并发 worker 抢先完成（或对象删除失败已被 purge 内部
      // 记录）——前者是正常竞争结果，不计入 failures，配额也只会被对方释放一次
    } catch (error) {
      // 单条失败不中断批次（下一条继续），下次执行重试
      summary.failures += 1;
      logger.error("清理单条资源失败", "asset-cleanup", {
        operation: "cleanup",
        assetId: asset.id,
        error,
      });
    }
  }

  logger.info("存储清理完成", "asset-cleanup", {
    operation: "cleanup",
    ...summary,
  });

  return summary;
}
