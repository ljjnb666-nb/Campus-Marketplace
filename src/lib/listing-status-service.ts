import type { ListingStatus, Prisma, RentalListingStatus } from "@prisma/client";

import {
  prepareActiveAccountMutation,
  type ActiveAccountMutationSeams,
} from "@/lib/governance/active-account-mutation";
import { requireMarketplaceCapability } from "@/lib/enforcement/capability-gate";
import { ACTIVE_PRODUCT_ORDER_STATUSES } from "@/lib/product-order-lifecycle";

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
 * 锁内 fresh row 为准。非暴露型 wind-down（OFFLINE、PAUSED/OFFLINE）
 * 不要求 marketplace capability——保留既有 "ACTIVE but RISK_RESTRICTED
 * 仍可 wind-down" 的 Phase 6C-3 语义。
 *
 * Rental：fresh status 为 BANNED / PENDING_REVIEW（NOT_USER_SETTABLE）
 * 时 NO-OP——该判断必须在锁内以 fresh row 重新执行，不信任事务外
 * snapshot。
 *
 * AUDIT2-RB01：Product fresh 读升级为行级 FOR UPDATE；ACTIVE 目标额外
 * 要求"无 active PRODUCT order"（PENDING/ACCEPTED 占用 reservation 时
 * 手动重新曝光 → 安全 NO-OP），与订单取消侧的投影权威共用同一
 * ACTIVE_PRODUCT_ORDER_STATUSES 定义。
 *
 * seams 仅测试注入（beforeLock：discovery 后、锁前；afterCheck：复核
 * 通过后、写前）。生产调用不传。
 */

/**
 * Phase 8A-02（P8-B01）：卖家可主动控制的 Product 状态只剩 ACTIVE/OFFLINE。
 * RESERVED / SOLD 是 system-owned Order lifecycle projection（唯一生产来源：
 * createProductOrderTx 的 ACTIVE→RESERVED 与 PRODUCT Order COMPLETED 的 SOLD
 * 投影），seller mutation（UI/Server Action/domain 直调）不得制造或改写。
 * SOLD 进一步是 seller-terminal：完成交易的商品不得被卖家复活，再售应
 * 创建新 listing。
 */
export type SellerProductStatusTarget = Extract<ListingStatus, "ACTIVE" | "OFFLINE">;
export type ServiceStatusTarget = Extract<ListingStatus, "ACTIVE" | "PAUSED" | "OFFLINE">;
export type RentalStatusTarget = Extract<RentalListingStatus, "AVAILABLE" | "PAUSED" | "OFFLINE">;

/** 运行时权威白名单（TypeScript 类型不是安全边界；防 as never 绕过）。 */
const SELLER_PRODUCT_STATUS_TARGETS: ReadonlySet<string> = new Set(["ACTIVE", "OFFLINE"]);

export async function updateProductStatusTx(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  productId: string,
  targetStatus: SellerProductStatusTarget,
  seams?: ActiveAccountMutationSeams,
): Promise<boolean> {
  // Phase 8A-02：运行时 fail-closed——任何绕过类型系统的 RESERVED/SOLD
  // 目标在零锁/零读/零写处拒绝，绝不执行 Product.update
  if (!SELLER_PRODUCT_STATUS_TARGETS.has(targetStatus)) {
    return false;
  }

  await prepareActiveAccountMutation(tx, actorUserId, seams);

  // AUDIT2-RB01：fresh 读升级为真实 Product 行锁（USER 锁 → Product 行锁，
  // 与 cancellation / creation 的 domain 锁序一致，禁止反序）
  const lockedRows = await tx.$queryRaw<Array<{
    id: string; campusId: string; sellerId: string; status: string; deletedAt: Date | null;
  }>>`
    SELECT id, "campusId", "sellerId", status, "deletedAt"
    FROM "Product"
    WHERE id = ${productId}
    FOR UPDATE
  `;
  const fresh = lockedRows[0];

  // fresh missing / 非本人 / 已删除 → 保持原 action 安全语义：NO-OP
  if (!fresh || fresh.sellerId !== actorUserId || fresh.deletedAt !== null) {
    return false;
  }

  // Phase 8A-02：SOLD 是 seller-terminal（system 成交终态）。卖家任何
  // status mutation 都不得重新定义其生命周期（SOLD→ACTIVE 会把已完成
  // 交易的同一商品重新曝光）；历史 SOLD 不自动复活，再售走新 listing。
  if (fresh.status === "SOLD") {
    return false;
  }

  if (targetStatus === "ACTIVE") {
    // EXPOSURE_INCREASING：重新上架属 START_NEW_MARKETPLACE_ACTIVITY
    await requireMarketplaceCapability(tx, actorUserId, fresh.campusId);

    // AUDIT2-RB01：存在 active PRODUCT order 的 reservation 不得被手动
    // 重新曝光 → 安全 NO-OP（不抛 500，保持 action 现有 no-op 语义）。
    // Phase 8A-02：这也是历史 stale RESERVED（无 active order）恢复
    // ACTIVE 的唯一卖家路径——capability 仍是权威边界。
    const activeOrder = await tx.order.findFirst({
      where: {
        productId,
        type: "PRODUCT",
        status: { in: [...ACTIVE_PRODUCT_ORDER_STATUSES] },
      },
      select: { id: true },
    });

    if (activeOrder) {
      return false;
    }
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
