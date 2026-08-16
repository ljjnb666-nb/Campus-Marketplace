import { Prisma } from "@prisma/client";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

// 个人订单历史上限，避免无限增长的全量查询
const MY_ORDERS_LIMIT = 100;

// 用户公开摘要字段（避免查询 passwordHash 等敏感字段，与 user-summary-card 展示需求对齐）
const userSummarySelect = {
  id: true,
  name: true,
  avatarUrl: true,
  schoolName: true,
  completedOrdersCount: true,
  positiveReviewRate: true,
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

export async function checkTimeConflict(
  tx: Prisma.TransactionClient,
  rentalListingId: string,
  startTime: Date,
  endTime: Date,
  quantity: number,
  excludeOrderId?: string,
): Promise<{ available: boolean; conflictCount: number }> {
  const listing = await tx.rentalListing.findUnique({
    where: { id: rentalListingId },
    select: { totalQuantity: true },
  });

  if (!listing) return { available: false, conflictCount: 0 };

  const conflictCount = await tx.rentalOrder.count({
    where: {
      rentalListingId,
      status: { notIn: ["CANCELLED", "REJECTED", "CLOSED"] },
      ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}),
      AND: [
        { startTime: { lt: endTime } },
        { endTime: { gt: startTime } },
      ],
    },
  });

  return {
    available: conflictCount + quantity <= listing.totalQuantity,
    conflictCount,
  };
}
