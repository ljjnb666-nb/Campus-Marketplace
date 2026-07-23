"use server";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { applyFavoriteToggle } from "@/lib/favorite-toggle";

export async function toggleErrandFavorite(userId: string, errandTaskId: string) {
  try {
    const existing = await prisma.errandFavorite.findUnique({
      where: {
        userId_errandTaskId: {
          userId,
          errandTaskId,
        },
      },
    });

    const result = await applyFavoriteToggle({
      existing,
      remove: () => [
        prisma.errandFavorite.delete({ where: { id: existing!.id } }),
        prisma.errandTask.update({
          where: { id: errandTaskId },
          data: { favoriteCount: { decrement: 1 } },
        }),
      ],
      add: () => [
        prisma.errandFavorite.create({
          data: { userId, errandTaskId },
        }),
        prisma.errandTask.update({
          where: { id: errandTaskId },
          data: { favoriteCount: { increment: 1 } },
        }),
      ],
    });

    revalidatePath("/errands");
    revalidatePath("/my/favorites");
    return result;
  } catch (error) {
    console.error("Failed to toggle errand favorite:", error);
    return { success: false as const, error: "操作失败" };
  }
}

export async function getMyErrandFavorites(userId: string) {
  const favorites = await prisma.errandFavorite.findMany({
    where: { userId },
    include: {
      errandTask: {
        include: {
          category: true,
          publisher: {
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

export async function checkErrandFavorited(userId: string, errandTaskId: string) {
  const favorite = await prisma.errandFavorite.findUnique({
    where: {
      userId_errandTaskId: {
        userId,
        errandTaskId,
      },
    },
  });

  return !!favorite;
}
