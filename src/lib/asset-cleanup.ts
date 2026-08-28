import type { AssetStatus } from "@prisma/client";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { batchCount, purgePendingDeleteAsset } from "@/lib/asset-service";

/**
 * 存储清理任务（可重复执行、幂等、支持 dry-run）：
 *
 * 1. 孤儿回收：UPLOADED 且 createdAt 超过 ASSET_ORPHAN_TTL_HOURS 的临时资源
 *    （用户上传后未完成发品/提交即离开）→ 标记 PENDING_DELETE
 * 2. 保留期到期：expiresAt 已过的敏感资源（如审核完成后的学生证材料）
 *    → 标记 PENDING_DELETE；认证结论等业务数据不受影响
 * 3. 物理清理：所有 PENDING_DELETE 资源删除远端对象 → DELETED + 释放配额；
 *    删除失败保留 PENDING_DELETE，下次执行自动重试（CASE F）
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

  // 1. 孤儿临时资源
  const orphanCutoff = new Date(now.getTime() - env.ASSET_ORPHAN_TTL_HOURS * 60 * 60 * 1000);
  const orphanWhere = { status: "UPLOADED" as const, createdAt: { lt: orphanCutoff } };
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
      } else {
        summary.failures += 1;
      }
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
