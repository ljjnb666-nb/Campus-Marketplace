"use server";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { applyFavoriteToggle } from "@/lib/favorite-toggle";

export async function toggleServiceFavorite(userId: string, serviceListingId: string) {
  try {
    const existing = await prisma.serviceFavorite.findUnique({
      where: {
        userId_serviceListingId: {
          userId,
          serviceListingId,
        },
      },
    });

    const result = await applyFavoriteToggle({
      existing,
      remove: () => [
        prisma.serviceFavorite.delete({ where: { id: existing!.id } }),
        prisma.serviceListing.update({
          where: { id: serviceListingId },
          data: { favoriteCount: { decrement: 1 } },
        }),
      ],
      add: () => [
        prisma.serviceFavorite.create({
          data: { userId, serviceListingId },
        }),
        prisma.serviceListing.update({
          where: { id: serviceListingId },
          data: { favoriteCount: { increment: 1 } },
        }),
      ],
    });

    revalidatePath("/services");
    revalidatePath("/my/favorites");
    return result;
  } catch (error) {
    console.error("Failed to toggle service favorite:", error);
    return { success: false as const, error: "操作失败" };
  }
}

export async function getMyServiceFavorites(userId: string) {
  const favorites = await prisma.serviceFavorite.findMany({
    where: { userId },
    include: {
      serviceListing: {
        include: {
          category: true,
          provider: {
            select: {
              id: true,
              name: true,
              verificationStatus: true,
            },
          },
          campus: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return favorites;
}

export async function checkServiceFavorited(userId: string, serviceListingId: string) {
  const favorite = await prisma.serviceFavorite.findUnique({
    where: {
      userId_serviceListingId: {
        userId,
        serviceListingId,
      },
    },
  });

  return !!favorite;
}
