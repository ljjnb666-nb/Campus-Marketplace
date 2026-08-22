"use server";

import { revalidatePath } from "next/cache";
import { prisma, withTransaction } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireUser } from "@/lib/server-auth";
import { auth } from "@/lib/auth";
import { applyFavoriteToggle } from "@/lib/favorite-toggle";

export async function toggleErrandFavorite(errandTaskId: string) {
  // 身份只能来自会话，绝不信任客户端传入的 userId
  const user = await requireUser();

  try {
    // 同一事务内的删除/新建 + 计数增减，并发下保持一致
    const result = await withTransaction((tx) =>
      applyFavoriteToggle({
        deleteFavorite: () =>
          tx.errandFavorite.deleteMany({
            where: { userId: user.id, errandTaskId },
          }),
        createFavorite: () =>
          tx.errandFavorite.create({
            data: { userId: user.id, errandTaskId },
          }),
        decrementCount: () =>
          tx.errandTask.update({
            where: { id: errandTaskId },
            data: { favoriteCount: { decrement: 1 } },
          }),
        incrementCount: () =>
          tx.errandTask.update({
            where: { id: errandTaskId },
            data: { favoriteCount: { increment: 1 } },
          }),
      }),
    );

    revalidatePath("/errands");
    revalidatePath("/my/favorites");
    return result;
  } catch (error) {
    logger.error("切换跑腿收藏失败", "toggleErrandFavorite", { error });
    return { success: false as const, error: "操作失败" };
  }
}

export async function getMyErrandFavorites(userId: string) {
  const session = await auth();

  // 未登录或会话用户与传入 userId 不一致时，仅返回空结果
  if (!session?.user?.id || session.user.id !== userId) {
    return [];
  }

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
  const session = await auth();

  // 未登录或会话用户与传入 userId 不一致时，视为未收藏
  if (!session?.user?.id || session.user.id !== userId) {
    return false;
  }

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
