import { Prisma } from "@prisma/client";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

// 个人订单历史上限，避免无限增长的全量查询
const MY_ORDERS_LIMIT = 100;

// 用户公开摘要字段（避免查询 passwordHash 等敏感字段，与 user-summary-card 展示需求对齐）
// Phase 8E：positiveReviewRate 已移除——PUBLIC/USER_VISIBLE 好评率一律走
// canonical visible 聚合（src/lib/reviews/review-query.ts），stored User 字段
// 是 NON_AUTHORITATIVE_DERIVED_CACHE，禁止继续向外供给
const userSummarySelect = {
  id: true,
  name: true,
  avatarUrl: true,
  schoolName: true,
  completedOrdersCount: true,
  verificationStatus: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export async function getMyRenterOrders(userId: string) {
  return prisma.rentalOrder.findMany({
    where: { renterId: userId },
    orderBy: { createdAt: "desc" },
    take: MY_ORDERS_LIMIT,
    include: {
      rentalListing: {
        select: {
          title: true,
          images: { take: 1, orderBy: { sortOrder: "asc" } },
        },
      },
      owner: { select: { name: true } },
    },
  });
}

export async function getMyOwnerOrders(userId: string) {
  return prisma.rentalOrder.findMany({
    where: { ownerId: userId },
    orderBy: { createdAt: "desc" },
    take: MY_ORDERS_LIMIT,
    include: {
      rentalListing: {
        select: {
          title: true,
          images: { take: 1, orderBy: { sortOrder: "asc" } },
        },
      },
      renter: { select: { name: true } },
    },
  });
}

// 统一订单中心:租客视角的租赁订单(含出租方与物品摘要)
export async function getMyRenterOrdersDetailed(userId: string) {
  return prisma.rentalOrder.findMany({
    where: { renterId: userId },
    include: {
      owner: { select: { id: true, name: true, avatarUrl: true, schoolName: true } },
      rentalListing: { select: { id: true, title: true, images: { take: 1 } } },
      reviews: { select: { authorId: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

// 统一订单中心:出租方视角的租赁订单(含租客与物品摘要)
export async function getMyOwnerOrdersDetailed(userId: string) {
  return prisma.rentalOrder.findMany({
    where: { ownerId: userId },
    include: {
      renter: { select: { id: true, name: true, avatarUrl: true, schoolName: true } },
      rentalListing: { select: { id: true, title: true, images: { take: 1 } } },
      reviews: { select: { authorId: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getRentalOrderDetail(orderId: string, userId: string) {
  const order = await prisma.rentalOrder.findFirst({
    where: {
      id: orderId,
      OR: [{ ownerId: userId }, { renterId: userId }],
    },
    include: {
      rentalListing: {
        include: { images: true, category: true },
      },
      owner: { select: userSummarySelect },
      renter: { select: userSummarySelect },
      handoverRecord: true,
      returnRecord: true,
      extensionRequests: true,
      damageClaims: true,
      disputes: true,
      statusLogs: { orderBy: { createdAt: "asc" } },
      reviews: true,
    },
  });

  if (!order) notFound();
  return order;
}

/**
 * R07：库存权威是 [start,end) 内的峰值并发占用，不是所有曾重叠订单之和。
 * PostgreSQL 单语句生成 start +quantity、end -quantity 事件；同刻先
 * 扣 end 再加 start，窗口 SUM 取峰值，不传输任意多条订单到应用。
 * 调用方必须在 RentalListing 行锁内执行此函数以保证并发序列化。
 */
export async function checkTimeConflict(
  tx: Prisma.TransactionClient,
  rentalListingId: string,
  startTime: Date,
  endTime: Date,
  quantity: number,
  excludeOrderId?: string,
): Promise<{ available: boolean; reservedQuantity: number }> {
  const listing = await tx.rentalListing.findUnique({
    where: { id: rentalListingId },
    select: { totalQuantity: true },
  });
  if (!listing) return { available: false, reservedQuantity: 0 };
  if (!Number.isSafeInteger(quantity) || quantity < 1 || !(startTime < endTime)) {
    return { available: false, reservedQuantity: 0 };
  }
  const exclude = excludeOrderId
    ? Prisma.sql`AND ro."id" <> ${excludeOrderId}`
    : Prisma.empty;
  const peaks = await tx.$queryRaw<Array<{ reservedQuantity: bigint | number }>>`
    WITH active AS (
      SELECT GREATEST(ro."startTime", ${startTime}) AS "fromTime",
             LEAST(ro."endTime", ${endTime}) AS "toTime",
             ro."quantity" AS quantity
      FROM "RentalOrder" ro
      WHERE ro."rentalListingId" = ${rentalListingId}
        AND ro."status" NOT IN ('CANCELLED', 'REJECTED', 'CLOSED')
        AND ro."startTime" < ${endTime}
        AND ro."endTime" > ${startTime}
        ${exclude}
    ),
    boundaries AS (
      SELECT "fromTime" AS moment, 1 AS boundary_order, quantity AS delta FROM active
      UNION ALL
      SELECT "toTime" AS moment, 0 AS boundary_order, -quantity AS delta FROM active
    ),
    timeline AS (
      SELECT SUM(delta) OVER (
        ORDER BY moment, boundary_order
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS occupied FROM boundaries
    )
    SELECT COALESCE(MAX(occupied), 0) AS "reservedQuantity" FROM timeline
  `;
  const reservedQuantity = Number(peaks[0]?.reservedQuantity ?? 0);
  if (!Number.isSafeInteger(reservedQuantity) || reservedQuantity < 0) {
    return { available: false, reservedQuantity: Number.MAX_SAFE_INTEGER };
  }
  return {
    available: reservedQuantity + quantity <= listing.totalQuantity,
    reservedQuantity,
  };
}
