import type { Prisma } from "@prisma/client";

import {
  ACTIVE_SERVICE_ORDER_STATUSES,
  RENTAL_TERMINAL_ORDER_STATUSES,
} from "@/lib/listings/listing-lifecycle";
import {
  prepareActiveAccountMutation,
  type ActiveAccountMutationSeams,
} from "@/lib/governance/active-account-mutation";
import { ACTIVE_PRODUCT_ORDER_STATUSES } from "@/lib/product-order-lifecycle";

/**
 * Phase 8F（§27/§28）：canonical soft-delete services——Product / Service /
 * Rental 用户删除的唯一权威实现（Errand 的 deleteErrandTx 保持既有权威，
 * 不搬入本模块）。
 *
 * 此前三个 delete action 均为「事务外读 → 事务外 active-order count →
 * 裸 prisma.update」：USER 锁缺失、行锁缺失、Product/Service 甚至不检查
 * active obligation，与订单创建/状态机没有 serialization point。Phase 8F
 * 冻结结构（同一事务）：
 *
 *   prepareActiveAccountMutation（USER subject lock → fresh account lifecycle）
 *   → listing FOR UPDATE（fresh ownership / deletedAt / campus 权威）
 *   → active obligations check（domain SSOT，禁止复制第二份状态数组）
 *   → canonical delete write（status = OFFLINE + deletedAt = now）
 *
 * delete monotonicity（§29）：deletedAt: null → timestamp 单向；本模块只
 * 从未删除行出发写入 deletedAt，绝不反向（NO restore / NO resurrection；
 * 重新发布 = 新 listing）。
 *
 * Delete status normalization（§34）：三域 manual delete 一律
 * OFFLINE + deletedAt；Errand（deleteErrandTx）为 CANCELLED + deletedAt；
 * DB CHECK（migration 20261002120000）作结构兜底。
 *
 * ACTIVE_OBLIGATION / SOLD_TERMINAL 是稳定 domain outcome——action 层负责
 * 中文提示（§70/§72：不得 silent no-op），UI 只看到中文。
 *
 * seams 仅测试注入（beforeLock / afterCheck 同
 * ActiveAccountMutationSeams 语义；生产不传）。
 */

export type ListingDeleteOutcome =
  | "DELETED"
  | "ALREADY_DELETED"
  | "MISSING_OR_FORBIDDEN"
  | "ACTIVE_OBLIGATION"
  | "SOLD_TERMINAL";

type LockedListingRow = {
  id: string;
  ownerId: string;
  status: string;
  deletedAt: Date | null;
};

/**
 * §30 Product 用户删除：owner + deletedAt == null + 无 active PRODUCT Order
 * （ACTIVE_PRODUCT_ORDER_STATUSES = PENDING/ACCEPTED/IN_DISPUTE）。
 * RESERVED + active order → ACTIVE_OBLIGATION（不得破坏 reservation）；
 * SOLD → SOLD_TERMINAL（成交历史不经用户删除破坏；账号注销/privacy
 * erasure 是独立 privileged path，不受此限制）。
 */
export async function deleteProductListingTx(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  productId: string,
  seams?: ActiveAccountMutationSeams,
): Promise<ListingDeleteOutcome> {
  if (seams?.beforeLock) {
    await seams.beforeLock(tx);
  }

  await prepareActiveAccountMutation(tx, actorUserId, seams);

  const lockedRows = await tx.$queryRaw<LockedListingRow[]>`
    SELECT id, "sellerId" AS "ownerId", status, "deletedAt"
    FROM "Product"
    WHERE id = ${productId}
    FOR UPDATE
  `;
  const fresh = lockedRows[0];

  if (!fresh || fresh.ownerId !== actorUserId) {
    return "MISSING_OR_FORBIDDEN";
  }

  // delete monotonicity：已删除 → 幂等安全结局（零二次副作用）
  if (fresh.deletedAt !== null) {
    return "ALREADY_DELETED";
  }

  if (fresh.status === "SOLD") {
    return "SOLD_TERMINAL";
  }

  const activeOrder = await tx.order.findFirst({
    where: {
      productId,
      type: "PRODUCT",
      status: { in: [...ACTIVE_PRODUCT_ORDER_STATUSES] },
    },
    select: { id: true },
  });

  if (activeOrder) {
    return "ACTIVE_OBLIGATION";
  }

  if (seams?.afterCheck) {
    await seams.afterCheck(tx);
  }

  await tx.product.update({
    where: { id: productId },
    data: { status: "OFFLINE", deletedAt: new Date() },
  });

  return "DELETED";
}

/**
 * §31 ServiceListing 用户删除：provider + deletedAt == null + 无 active
 * SERVICE Order（ACTIVE_SERVICE_ORDER_STATUSES central helper）。有 active
 * order 时 provider 仍可 PAUSED / OFFLINE（stop new business != destroy
 * active obligation context），但 delete DENY。
 */
export async function deleteServiceListingTx(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  serviceId: string,
  seams?: ActiveAccountMutationSeams,
): Promise<ListingDeleteOutcome> {
  if (seams?.beforeLock) {
    await seams.beforeLock(tx);
  }

  await prepareActiveAccountMutation(tx, actorUserId, seams);

  const lockedRows = await tx.$queryRaw<LockedListingRow[]>`
    SELECT id, "providerId" AS "ownerId", status, "deletedAt"
    FROM "ServiceListing"
    WHERE id = ${serviceId}
    FOR UPDATE
  `;
  const fresh = lockedRows[0];

  if (!fresh || fresh.ownerId !== actorUserId) {
    return "MISSING_OR_FORBIDDEN";
  }

  if (fresh.deletedAt !== null) {
    return "ALREADY_DELETED";
  }

  const activeOrder = await tx.order.findFirst({
    where: {
      serviceListingId: serviceId,
      type: "SERVICE",
      status: { in: [...ACTIVE_SERVICE_ORDER_STATUSES] },
    },
    select: { id: true },
  });

  if (activeOrder) {
    return "ACTIVE_OBLIGATION";
  }

  if (seams?.afterCheck) {
    await seams.afterCheck(tx);
  }

  await tx.serviceListing.update({
    where: { id: serviceId },
    data: { status: "OFFLINE", deletedAt: new Date() },
  });

  return "DELETED";
}

/**
 * §32 RentalListing 用户删除：owner + deletedAt == null + 无 active
 * RentalOrder（active = status NOT IN RENTAL_TERMINAL_ORDER_STATUSES；
 * COMPLETED/CANCELLED/REJECTED/CLOSED 是 terminal）。锁内 fresh count
 * 取代既有事务外 count。
 */
export async function deleteRentalListingTx(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  listingId: string,
  seams?: ActiveAccountMutationSeams,
): Promise<ListingDeleteOutcome> {
  if (seams?.beforeLock) {
    await seams.beforeLock(tx);
  }

  await prepareActiveAccountMutation(tx, actorUserId, seams);

  const lockedRows = await tx.$queryRaw<LockedListingRow[]>`
    SELECT id, "ownerId", status, "deletedAt"
    FROM "RentalListing"
    WHERE id = ${listingId}
    FOR UPDATE
  `;
  const fresh = lockedRows[0];

  if (!fresh || fresh.ownerId !== actorUserId) {
    return "MISSING_OR_FORBIDDEN";
  }

  if (fresh.deletedAt !== null) {
    return "ALREADY_DELETED";
  }

  const activeOrder = await tx.rentalOrder.findFirst({
    where: {
      rentalListingId: listingId,
      status: { notIn: [...RENTAL_TERMINAL_ORDER_STATUSES] },
    },
    select: { id: true },
  });

  if (activeOrder) {
    return "ACTIVE_OBLIGATION";
  }

  if (seams?.afterCheck) {
    await seams.afterCheck(tx);
  }

  await tx.rentalListing.update({
    where: { id: listingId },
    data: { status: "OFFLINE", deletedAt: new Date() },
  });

  return "DELETED";
}
