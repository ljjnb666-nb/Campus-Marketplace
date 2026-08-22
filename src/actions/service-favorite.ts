"use server";

import { revalidatePath } from "next/cache";
import { prisma, withTransaction } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireUser } from "@/lib/server-auth";
import { auth } from "@/lib/auth";
import { applyFavoriteToggle } from "@/lib/favorite-toggle";

export async function toggleServiceFavorite(serviceListingId: string) {
  // 身份只能来自会话，绝不信任客户端传入的 userId
  const user = await requireUser();

  try {
    // 同一事务内的删除/新建 + 计数增减，并发下保持一致
    const result = await withTransaction((tx) =>
      applyFavoriteToggle({
        deleteFavorite: () =>
          tx.serviceFavorite.deleteMany({
            where: { userId: user.id, serviceListingId },
          }),
        createFavorite: () =>
          tx.serviceFavorite.create({
            data: { userId: user.id, serviceListingId },
          }),
        decrementCount: () =>
          tx.serviceListing.update({
            where: { id: serviceListingId },
            data: { favoriteCount: { decrement: 1 } },
          }),
        incrementCount: () =>
          tx.serviceListing.update({
            where: { id: serviceListingId },
            data: { favoriteCount: { increment: 1 } },
          }),
      }),
    );

    revalidatePath("/services");
    revalidatePath("/my/favorites");
    return result;
  } catch (error) {
    logger.error("切换服务收藏失败", "toggleServiceFavorite", { error });
    return { success: false as const, error: "操作失败" };
  }
}

export async function getMyServiceFavorites(userId: string) {
  const session = await auth();

  // 未登录或会话用户与传入 userId 不一致时，仅返回空结果
  if (!session?.user?.id || session.user.id !== userId) {
    return [];
  }

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
  const session = await auth();

  // 未登录或会话用户与传入 userId 不一致时，视为未收藏
  if (!session?.user?.id || session.user.id !== userId) {
    return false;
  }

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
