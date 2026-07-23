import { Prisma } from "@prisma/client";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

export async function getMyRenterOrders(userId: string) {
  return prisma.rentalOrder.findMany({
    where: { renterId: userId },
    orderBy: { createdAt: "desc" },
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
      owner: true,
      renter: true,
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
