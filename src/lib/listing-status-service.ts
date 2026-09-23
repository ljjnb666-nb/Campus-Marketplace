import type { ListingStatus, Prisma, RentalListingStatus } from "@prisma/client";

import {
  prepareActiveAccountMutation,
  type ActiveAccountMutationSeams,
} from "@/lib/governance/active-account-mutation";
import { requireMarketplaceCapability } from "@/lib/enforcement/capability-gate";

/**
 * RB-03 REVIEW FIX（LISTING_STATUS_LIFECYCLE_SERIALIZATION）：
 * USER_STATUS_MUTATION_CONTRACT —— 任何用户发起的 marketplace status
 * mutation 不得使用先于并发 erase/suspend 的 lifecycle 判定或目标状态
 * snapshot 提交。
 *
 * 冻结结构（同一事务）：
 *   USER:<actorId> subject lock → fresh account lifecycle 复核
 *   → fresh target row（ownership/deletedAt/campus/status 权威）
 *   → 暴露增加型目标（Product/Service ACTIVE、Rental AVAILABLE）追加
 *     requireMarketplaceCapability（checks-only；USER 锁已持有，
 *     不重复 enforce）
 *   → 状态写入 → COMMIT
 *
 * 事务外 pre-read 只能作 discovery；ownership/status/campus 一律以
 * 锁内 fresh row 为准。非暴露型 wind-down（RESERVED/SOLD/OFFLINE、
 * PAUSED/OFFLINE）不要求 marketplace capability——保留既有
 * "ACTIVE but RISK_RESTRICTED 仍可 wind-down" 的 Phase 6C-3 语义。
 *
 * Rental：fresh status 为 BANNED / PENDING_REVIEW（NOT_USER_SETTABLE）
 * 时 NO-OP——该判断必须在锁内以 fresh row 重新执行，不信任事务外
 * snapshot。
 *
 * seams 仅测试注入（beforeLock：discovery 后、锁前；afterCheck：复核
 * 通过后、写前）。生产调用不传。
 */

export type ProductStatusTarget = Extract<ListingStatus, "ACTIVE" | "RESERVED" | "SOLD" | "OFFLINE">;
export type ServiceStatusTarget = Extract<ListingStatus, "ACTIVE" | "PAUSED" | "OFFLINE">;
export type RentalStatusTarget = Extract<RentalListingStatus, "AVAILABLE" | "PAUSED" | "OFFLINE">;

export async function updateProductStatusTx(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  productId: string,
  targetStatus: ProductStatusTarget,
  seams?: ActiveAccountMutationSeams,
): Promise<boolean> {
  await prepareActiveAccountMutation(tx, actorUserId, seams);

  const fresh = await tx.product.findFirst({
    where: { id: productId, sellerId: actorUserId, deletedAt: null },
    select: { id: true, campusId: true, status: true },
  });

  // fresh missing / 非本人 / 已删除 → 保持原 action 安全语义：NO-OP
  if (!fresh) {
    return false;
  }

  if (targetStatus === "ACTIVE") {
    // EXPOSURE_INCREASING：重新上架属 START_NEW_MARKETPLACE_ACTIVITY
    await requireMarketplaceCapability(tx, actorUserId, fresh.campusId);
  }

  await tx.product.update({
    where: { id: productId },
    data: { status: targetStatus },
  });

  return true;
}

export async function updateServiceStatusTx(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  serviceId: string,
  targetStatus: ServiceStatusTarget,
  seams?: ActiveAccountMutationSeams,
): Promise<boolean> {
  await prepareActiveAccountMutation(tx, actorUserId, seams);

  const fresh = await tx.serviceListing.findFirst({
    where: { id: serviceId, providerId: actorUserId, deletedAt: null },
    select: { id: true, campusId: true, status: true },
  });

  if (!fresh) {
    return false;
  }

  if (targetStatus === "ACTIVE") {
    await requireMarketplaceCapability(tx, actorUserId, fresh.campusId);
  }

  await tx.serviceListing.update({
    where: { id: serviceId },
    data: { status: targetStatus },
  });

  return true;
}

export async function updateRentalListingStatusTx(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  listingId: string,
  targetStatus: RentalStatusTarget,
  seams?: ActiveAccountMutationSeams,
): Promise<boolean> {
  await prepareActiveAccountMutation(tx, actorUserId, seams);

  const fresh = await tx.rentalListing.findFirst({
    where: { id: listingId, ownerId: actorUserId, deletedAt: null },
    select: { id: true, campusId: true, status: true },
  });

  if (!fresh) {
    return false;
  }

  // NOT_USER_SETTABLE：BANNED / PENDING_REVIEW 必须以锁内 fresh status
  // 重新判断（治理态不得被用户 status 写穿越）
  if (fresh.status === "BANNED" || fresh.status === "PENDING_REVIEW") {
    return false;
  }

  if (targetStatus === "AVAILABLE") {
    await requireMarketplaceCapability(tx, actorUserId, fresh.campusId);
  }

  await tx.rentalListing.update({
    where: { id: listingId },
    data: { status: targetStatus },
  });

  return true;
}
