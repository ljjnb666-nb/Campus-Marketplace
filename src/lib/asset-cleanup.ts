import type { AssetStatus } from "@prisma/client";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  batchCount,
  markRetentionExpiredAssetPendingDelete,
  purgePendingDeleteAsset,
} from "@/lib/asset-service";
import { listActiveUserHoldSubjectIds } from "@/lib/privacy/data-hold-service";

/**
 * 存储清理任务（可重复执行、幂等、支持 dry-run）：
 *
 * 1. 孤儿/僵死回收：UPLOADING（预留后崩溃，对象可能存在也可能不存在）与
 *    UPLOADED（上传完成但未绑定业务）超过 ASSET_ORPHAN_TTL_HOURS 的资源
 *    → 标记 PENDING_DELETE（对象删除幂等，两种情形都安全；
 *      既有 crash-recovery contract 保持不变）
 * 2. 保留期到期：expiresAt 已过的敏感资源（如审核完成后的学生证材料）
 *    → candidate discovery 与 authoritative transition 分离——discovery 只
 *    产出候选 id（bounded batch），真正的 PENDING_DELETE 推进逐条在
 *    USER governance subject 锁内 fresh 复核（hold check + 行 predicate）
 *    后执行；ACTIVE hold 时保持原状态
 * 3. 物理清理：PENDING_DELETE 候选经 hold-safe destructive boundary
 *    （purgePendingDeleteAsset）删除远端对象 → 单事务完成 DELETED 转移 +
 *    配额减额（exactly-once，并发 worker 安全）；
 *    失败保留 PENDING_DELETE，下次执行自动重试
 *
 * DataHold 语义（Phase 9C-01）：
 * - ACTIVE USER hold 是 business/governance block，不是 failure，也不触发
 *   重试风暴：被 hold 的候选保持原状并计入 holdBlocked 计数；
 * - discovery 阶段的 NOT EXISTS hold 预过滤（listActiveUserHoldSubjectIds）
 *   只是公平性优化（防止长期 hold 的行永久占据 batch 前部），
 *   不是 authority——真正破坏性决策仍以 subject 锁内 fresh 复核为准；
 * - 破坏性推进（保留期标记 + 物理清除）全部走 asset-service 的
 *   DataHold-safe boundary，本文件不复制删除状态机。
 */

export interface CleanupSummary {
  dryRun: boolean;
  orphansMarked: number;
  retentionExpiredMarked: number;
  /** 保留期候选中因 ACTIVE USER hold 未被推进的数量 */
  retentionHoldBlocked: number;
  objectsDeleted: number;
  quotaReleasedBytes: number;
  /** PENDING_DELETE 中因 ACTIVE USER hold 被跳过的数量（预过滤 + 锁内复核） */
  purgeHoldBlocked: number;
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
    retentionHoldBlocked: 0,
    objectsDeleted: 0,
    quotaReleasedBytes: 0,
    purgeHoldBlocked: 0,
    failures: 0,
  };

  // 公平性预过滤：当前被 ACTIVE USER hold 冻结的 owner 集合（discovery-only）
  const heldOwnerIds = await listActiveUserHoldSubjectIds();

  // 1. 孤儿与僵死资源：UPLOADING（崩溃遗留，对象可能存在）+ UPLOADED（未绑定业务）。
  //    crash-recovery contract 不因 hold 收窄：标记本身非破坏性（对象不动、
  //    配额不动），物理清除仍必须通过锁内 fresh hold 复核。
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

  // 2. 保留期到期：discovery（bounded，hold 预过滤）与 authoritative transition 分离
  const expiredWhere = {
    expiresAt: { lt: now },
    status: { in: ["UPLOADED", "ATTACHED"] as AssetStatus[] },
  };
  const expiredDiscoveryWhere = heldOwnerIds.length
    ? { ...expiredWhere, ownerId: { notIn: heldOwnerIds } }
    : expiredWhere;

  if (dryRun) {
    summary.retentionExpiredMarked = await prisma.uploadedAsset.count({
      where: expiredDiscoveryWhere,
    });
    if (heldOwnerIds.length) {
      summary.retentionHoldBlocked = await prisma.uploadedAsset.count({
        where: { ...expiredWhere, ownerId: { in: heldOwnerIds } },
      });
    }
  } else {
    const candidates = await prisma.uploadedAsset.findMany({
      where: expiredDiscoveryWhere,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: batchLimit,
      select: { id: true },
    });
    for (const candidate of candidates) {
      try {
        const outcome = await markRetentionExpiredAssetPendingDelete(candidate.id, now);
        if (outcome === "MARKED") {
          summary.retentionExpiredMarked += 1;
        } else if (outcome === "HOLD_BLOCKED") {
          // 锁内 fresh 复核命中 hold（discovery 后新创建的 hold）：保持原状态
          summary.retentionHoldBlocked += 1;
        }
      } catch (error) {
        summary.failures += 1;
        logger.error("保留期标记事务失败，下次执行重试", "asset-cleanup", {
          operation: "retention-mark",
          assetId: candidate.id,
          error,
        });
      }
    }
    if (heldOwnerIds.length) {
      summary.retentionHoldBlocked += await prisma.uploadedAsset.count({
        where: { ...expiredWhere, ownerId: { in: heldOwnerIds } },
      });
    }
  }

  // 3. 物理清理 PENDING_DELETE（含本轮与历史失败重试）
  const pendingWhere = { status: "PENDING_DELETE" as const };
  const pendingDiscoveryWhere = heldOwnerIds.length
    ? { ...pendingWhere, ownerId: { notIn: heldOwnerIds } }
    : pendingWhere;

  if (dryRun) {
    summary.objectsDeleted = await prisma.uploadedAsset.count({
      where: pendingDiscoveryWhere,
    });
    if (heldOwnerIds.length) {
      summary.purgeHoldBlocked = await prisma.uploadedAsset.count({
        where: { ...pendingWhere, ownerId: { in: heldOwnerIds } },
      });
    }
    return summary;
  }

  const pendingAssets = await prisma.uploadedAsset.findMany({
    where: pendingDiscoveryWhere,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: batchLimit,
    select: { id: true },
  });

  for (const asset of pendingAssets) {
    try {
      const purge = await purgePendingDeleteAsset(asset.id);
      switch (purge.outcome) {
        case "PURGED":
          summary.objectsDeleted += 1;
          summary.quotaReleasedBytes += purge.releasedQuotaBytes;
          break;
        case "HOLD_BLOCKED":
          // discovery 预过滤与 purge 之间新创建的 hold：business block，非失败
          summary.purgeHoldBlocked += 1;
          break;
        case "NOOP":
          // 并发 worker 抢先完成转移：正常竞争结果，不计失败，配额由对方释放一次
          break;
        case "RETRYABLE_FAILURE":
          summary.failures += 1;
          break;
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

  // 预过滤跳过的 held 行（本轮未处理但真实存在；含 in-lock 复核计数）
  if (heldOwnerIds.length) {
    summary.purgeHoldBlocked += await prisma.uploadedAsset.count({
      where: { ...pendingWhere, ownerId: { in: heldOwnerIds } },
    });
  }

  logger.info("存储清理完成", "asset-cleanup", {
    operation: "cleanup",
    ...summary,
  });

  return summary;
}
