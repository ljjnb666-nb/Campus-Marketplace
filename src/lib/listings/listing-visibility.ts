import { prisma } from "@/lib/prisma";
import {
  ERRAND_PUBLIC_EXPOSURE_STATUS,
  isProductPubliclyExposed,
  isRentalPubliclyExposed,
  isServicePubliclyExposed,
} from "@/lib/listings/listing-lifecycle";

/**
 * Phase 8F（§14-§17）：Detail Access Policy——公开详情访问 ≠ discovery。
 *
 * 三种 actor：
 *   PUBLIC        匿名 / 无关第三方：只允许 public exposure 状态
 *                 （Product ACTIVE / Service ACTIVE / Errand OPEN /
 *                 Rental AVAILABLE），否则 notFound——不能泄漏 title /
 *                 description / location / seller / status / price。
 *   OWNER         owner / provider / publisher：只要 deletedAt == null
 *                 （repository 已保证），允许查看自己的 wind-down listing，
 *                 操作按钮按 lifecycle policy 收敛（§45 中文状态提示）。
 *   PARTICIPANT   既有交易参与方（Product: Order(productId) 买卖双方 /
 *                 Service: Order(serviceListingId) / Errand: publisher +
 *                 accepter / Rental: RentalOrder owner + renter）：
 *                 private obligation continuity——允许查看非公开 listing
 *                 的履约上下文，但这不是 public exposure，绝不进入
 *                 search / homepage / favorites discovery / metadata /
 *                 view count / 新义务资格。
 *
 * Moderation overlay（Phase 7C 合同不变）在 lifecycle gate 之后独立裁决：
 * 参与方特权不得绕过治理保密——治理隐藏 listing 的非 owner 一律仍走
 * notFound（errand accepter 的 Phase 7C additionalAllowedViewerIds 特例
 * 保持不变），既有义务继续走 Order / RentalOrder private surfaces。
 */

export type ListingDetailAccessRole = "PUBLIC" | "OWNER" | "PARTICIPANT";

/**
 * lifecycle 维度的详情访问裁决（不含 moderation；纯函数，client-safe）。
 *
 * Phase 9C-02：本裁决仍是 status-only（Phase 8F 冻结合同不变）。Errand
 * 调用方必须叠加 deadline 维度——PUBLIC 角色返回前由页面用
 * isErrandPubliclyExposed(status, deadline, now) 复核（deadline 已过的
 * OPEN 任务对陌生人不返回 PUBLIC 详情）；OWNER / PARTICIPANT 特权不受
 * deadline 影响（履约上下文保留）。
 */
export function resolveListingLifecycleAccess(input: {
  status: string;
  viewerId: string | null;
  ownerId: string;
  isParticipant: boolean;
}): ListingDetailAccessRole | null {
  if (input.viewerId !== null && input.viewerId === input.ownerId) {
    return "OWNER";
  }
  if (input.isParticipant) {
    return "PARTICIPANT";
  }
  // status-only 裁决（Phase 8F 冻结）：Errand 分支只比较 status 常量——
  // deadline 维度由 Errand 详情调用方经 isErrandPubliclyExposed 叠加
  //（见上方 docstring），本函数保持四域对称的纯 status 语义。
  if (
    isProductPubliclyExposed(input.status) ||
    isServicePubliclyExposed(input.status) ||
    input.status === ERRAND_PUBLIC_EXPOSURE_STATUS ||
    isRentalPubliclyExposed(input.status)
  ) {
    return "PUBLIC";
  }
  return null;
}

/**
 * 既有交易参与方判定（viewer 与 listing 存在任一状态的历史订单关系即算；
 * 参与方资格与订单状态无关——COMPLETED 历史交易同样保留履约/售后上下文）。
 * 四域 typed 查询；viewerId 为 null 恒 false。
 */
export async function isListingTransactionParticipant(
  domain: "PRODUCT" | "SERVICE" | "ERRAND" | "RENTAL",
  listingId: string,
  viewerId: string | null,
): Promise<boolean> {
  if (viewerId === null) {
    return false;
  }

  switch (domain) {
    case "PRODUCT": {
      const order = await prisma.order.findFirst({
        where: { productId: listingId, buyerId: viewerId },
        select: { id: true },
      });
      if (order) return true;
      const sold = await prisma.order.findFirst({
        where: { productId: listingId, sellerId: viewerId },
        select: { id: true },
      });
      return sold !== null;
    }
    case "SERVICE": {
      const order = await prisma.order.findFirst({
        where: { serviceListingId: listingId, buyerId: viewerId },
        select: { id: true },
      });
      if (order) return true;
      const provided = await prisma.order.findFirst({
        where: { serviceListingId: listingId, sellerId: viewerId },
        select: { id: true },
      });
      return provided !== null;
    }
    case "ERRAND": {
      const errand = await prisma.errandTask.findFirst({
        where: {
          id: listingId,
          OR: [{ publisherId: viewerId }, { accepterId: viewerId }],
        },
        select: { id: true },
      });
      return errand !== null;
    }
    case "RENTAL": {
      const order = await prisma.rentalOrder.findFirst({
        where: {
          rentalListingId: listingId,
          OR: [{ ownerId: viewerId }, { renterId: viewerId }],
        },
        select: { id: true },
      });
      return order !== null;
    }
  }
}

/** ERRAND 特化：publisher / accepter 与 ownerId 判定合一（accepter 是 owner
 * 之外的第二特权身份；detail 页面直接用本函数避免双查询漂移）。 */
export function isErrandParticipant(
  errand: { publisherId: string; accepterId: string | null },
  viewerId: string | null,
): boolean {
  if (viewerId === null) return false;
  return errand.publisherId === viewerId || errand.accepterId === viewerId;
}
