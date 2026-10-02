import type { ListingStatus, Prisma, RentalListingStatus } from "@prisma/client";

import {
  RENTAL_LEGACY_STATUSES,
  RENTAL_STATUS_TARGETS,
  SELLER_PRODUCT_STATUS_TARGETS,
  SERVICE_STATUS_TARGETS,
} from "@/lib/listings/listing-lifecycle";
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
 *   运行时目标白名单（TypeScript 类型不是安全边界；防 as never 绕过）
 *   → USER:<actorId> subject lock → fresh account lifecycle 复核
 *   → fresh target row FOR UPDATE（ownership/deletedAt/campus/status 权威）
 *   → 暴露增加型目标（Product/Service ACTIVE、Rental AVAILABLE）追加
 *     requireMarketplaceCapability（checks-only；USER 锁已持有，
 *     不重复 enforce）
 *   → 状态写入 → COMMIT
 *
 * Phase 8F：Product / ServiceListing / RentalListing 三者全部升级为真实
 * 行级 FOR UPDATE（此前 Service/Rental 使用普通 Prisma read——read snapshot
 * → 并发 delete/status change → stale write 的窗口被关闭）。Service/Rental
 * 运行时目标白名单与 Product 对齐，internal caller 无法绕过 validator 直写。
 *
 * 事务外 pre-read 只能作 discovery；ownership/status/campus 一律以
 * 锁内 fresh row 为准。非暴露型 wind-down（OFFLINE、PAUSED/OFFLINE）
 * 不要求 marketplace capability——保留既有 "ACTIVE but RISK_RESTRICTED
 * 仍可 wind-down" 的 Phase 6C-3 语义。
 *
 * Product（Phase 8A-02 + 8F 收紧）：RESERVED 是 system-owned reservation
 * projection——存在 active PRODUCT order 时 seller 的任何 target（含
 * OFFLINE）都 DENY；无 active order 的 stale RESERVED 只保留唯一恢复路径
 * RESERVED → ACTIVE（capability 权威），不得 stale → OFFLINE。SOLD 是
 * seller-terminal。Rental fresh status 为 BANNED / PENDING_REVIEW /
 * FULLY_BOOKED（NOT_USER_SETTABLE / legacy）时 NO-OP——一律以锁内 fresh
 * row 重新判断。
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

type ProductLockRow = {
  id: string; campusId: string; sellerId: string; status: string; deletedAt: Date | null;
};

type ListingLockRow = {
  id: string; campusId: string; ownerId: string; status: string; deletedAt: Date | null;
};

/** 锁内 fresh Product 行的 active PRODUCT order 防御读取（与订单侧投影权威共用 SSOT）。 */
async function findActiveProductOrderId(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<string | null> {
  const activeOrder = await tx.order.findFirst({
    where: {
      productId,
      type: "PRODUCT",
      status: { in: [...ACTIVE_PRODUCT_ORDER_STATUSES] },
    },
    select: { id: true },
  });
  return activeOrder?.id ?? null;
}

export async function updateProductStatusTx(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  productId: string,
  targetStatus: SellerProductStatusTarget,
  seams?: ActiveAccountMutationSeams,
): Promise<boolean> {
  // Phase 8A-02：运行时 fail-closed——任何绕过类型系统的 RESERVED/SOLD/PAUSED
  // 目标在零锁/零读/零写处拒绝，绝不执行 Product.update
  if (!SELLER_PRODUCT_STATUS_TARGETS.has(targetStatus)) {
    return false;
  }

  if (seams?.beforeLock) {
    await seams.beforeLock(tx);
  }

  await prepareActiveAccountMutation(tx, actorUserId, seams);

  // AUDIT2-RB01：fresh 读升级为真实 Product 行锁（USER 锁 → Product 行锁，
  // 与 cancellation / creation 的 domain 锁序一致，禁止反序）
  const lockedRows = await tx.$queryRaw<ProductLockRow[]>`
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

  if (seams?.afterCheck) {
    await seams.afterCheck(tx);
  }

  // Phase 8A-02：SOLD 是 seller-terminal（system 成交终态）。卖家任何
  // status mutation 都不得重新定义其生命周期（SOLD→ACTIVE 会把已完成
  // 交易的同一商品重新曝光）；历史 SOLD 不自动复活，再售走新 listing。
  if (fresh.status === "SOLD") {
    return false;
  }

  // Phase 8F（§4）：RESERVED 是 system-owned reservation projection。
  //   RESERVED + active PRODUCT order → 任何 seller target 都 DENY
  //   （ACTIVE 与 OFFLINE 一视同仁——正常 reservation 不允许 seller 覆盖）
  //   RESERVED + 无 active order（stale projection anomaly）→ 唯一恢复
  //   路径 RESERVED → ACTIVE（capability 权威）；stale → OFFLINE DENY
  //   （不得把正常 reservation 与 stale recovery 混为一谈）
  if (fresh.status === "RESERVED") {
    const activeOrderId = await findActiveProductOrderId(tx, productId);

    if (activeOrderId) {
      return false;
    }

    if (targetStatus !== "ACTIVE") {
      return false;
    }

    await requireMarketplaceCapability(tx, actorUserId, fresh.campusId);
    await tx.product.update({
      where: { id: productId },
      data: { status: targetStatus },
    });
    return true;
  }

  if (targetStatus === "ACTIVE") {
    // EXPOSURE_INCREASING：重新上架属 START_NEW_MARKETPLACE_ACTIVITY
    await requireMarketplaceCapability(tx, actorUserId, fresh.campusId);

    // AUDIT2-RB01：存在 active PRODUCT order 的 reservation 不得被手动
    // 重新曝光 → 安全 NO-OP（不抛 500，保持 action 现有 no-op 语义）。
    const activeOrderId = await findActiveProductOrderId(tx, productId);
    if (activeOrderId) {
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
  // Phase 8F（§26）：运行时目标白名单——禁止 as never / internal caller 绕过
  if (!SERVICE_STATUS_TARGETS.has(targetStatus)) {
    return false;
  }

  if (seams?.beforeLock) {
    await seams.beforeLock(tx);
  }

  await prepareActiveAccountMutation(tx, actorUserId, seams);

  // Phase 8F（§24）：fresh 读升级为 ServiceListing 行锁（USER provider 锁
  // → ServiceListing 行锁），禁止 read snapshot → concurrent delete/status
  // change → stale write
  const lockedRows = await tx.$queryRaw<ListingLockRow[]>`
    SELECT id, "campusId", "providerId" AS "ownerId", status, "deletedAt"
    FROM "ServiceListing"
    WHERE id = ${serviceId}
    FOR UPDATE
  `;
  const fresh = lockedRows[0];

  if (!fresh || fresh.ownerId !== actorUserId || fresh.deletedAt !== null) {
    return false;
  }

  if (seams?.afterCheck) {
    await seams.afterCheck(tx);
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
  // Phase 8F（§26）：运行时目标白名单（AVAILABLE/PAUSED/OFFLINE 之外 DENY）
  if (!RENTAL_STATUS_TARGETS.has(targetStatus)) {
    return false;
  }

  if (seams?.beforeLock) {
    await seams.beforeLock(tx);
  }

  await prepareActiveAccountMutation(tx, actorUserId, seams);

  // Phase 8F（§25）：fresh 读升级为 RentalListing 行锁（USER owner 锁
  // → RentalListing 行锁），fresh 检查 ownerId / deletedAt / status / campusId
  const lockedRows = await tx.$queryRaw<ListingLockRow[]>`
    SELECT id, "campusId", "ownerId", status, "deletedAt"
    FROM "RentalListing"
    WHERE id = ${listingId}
    FOR UPDATE
  `;
  const fresh = lockedRows[0];

  if (!fresh || fresh.ownerId !== actorUserId || fresh.deletedAt !== null) {
    return false;
  }

  if (seams?.afterCheck) {
    await seams.afterCheck(tx);
  }

  // NOT_USER_SETTABLE / legacy：BANNED / PENDING_REVIEW / FULLY_BOOKED 必须
  // 以锁内 fresh status 重新判断（治理态与 legacy 值不得被用户 status 写
  // 穿越；§25 legacy fail closed）
  if (RENTAL_LEGACY_STATUSES.includes(fresh.status)) {
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
