"use server";

import { revalidatePath } from "next/cache";
import { prisma, withTransaction } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireUser, getVerifiedSession } from "@/lib/server-auth";
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
  // Phase 6C-2 raw-auth hardening：私有收藏读必须 ACTIVE 账号 DB 复查；
  // 非本人或账号非 ACTIVE（含 SUSPENDED）→ 既有抑制形状（[]）
  const verified = await getVerifiedSession();

  // 未登录/账号不可用或会话用户与传入 userId 不一致时，仅返回空结果
  if (!verified.ok || verified.user.id !== userId) {
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
  // Phase 6C-2 raw-auth hardening：私有收藏状态必须 ACTIVE 账号 DB 复查
  const verified = await getVerifiedSession();

  // 未登录/账号不可用或会话用户与传入 userId 不一致时，视为未收藏
  if (!verified.ok || verified.user.id !== userId) {
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
