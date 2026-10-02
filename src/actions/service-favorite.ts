"use server";
import { listingModerationPublicFilter } from "@/lib/moderation/listing-moderation-query";

import { revalidatePath } from "next/cache";
import { prepareActiveAccountMutation } from "@/lib/governance/active-account-mutation";
import { prisma, withTransaction } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { requireUser, getVerifiedSession } from "@/lib/server-auth";
import { applyFavoriteToggle } from "@/lib/favorite-toggle";
import { SERVICE_PUBLIC_EXPOSURE_STATUS } from "@/lib/listings/listing-lifecycle";

export async function toggleServiceFavorite(serviceListingId: string) {
  // 身份只能来自会话，绝不信任客户端传入的 userId
  const user = await requireUser();

  try {
    // 同一事务内的删除/新建 + 计数增减，并发下保持一致。
    // Phase 8F（§21）：new favorite 仅对 public exposure（ACTIVE）listing
    // 开放——锁内 fresh 判定（补上此前缺失的 listing 存在性/软删/治理检查）；
    // 移除既有收藏属 allowed wind-down，不受限
    const result = await withTransaction(async (tx) => {
      const exposed = await tx.serviceListing.findFirst({
        where: {
          id: serviceListingId,
          deletedAt: null,
          status: SERVICE_PUBLIC_EXPOSURE_STATUS,
          ...listingModerationPublicFilter(),
        },
        select: { id: true },
      });

      return applyFavoriteToggle({
        // RB-03：active-account 序列化（durable 用户所有态）
        beforeToggle: () => prepareActiveAccountMutation(tx, user.id),
        deleteFavorite: () =>
          tx.serviceFavorite.deleteMany({
            where: { userId: user.id, serviceListingId },
          }),
        createFavorite: () => {
          if (!exposed) {
            throw new Error("FAVORITE_LISTING_NOT_PUBLIC");
          }
          return tx.serviceFavorite.create({
            data: { userId: user.id, serviceListingId },
          });
        },
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
      });
    });

    revalidatePath("/services");
    revalidatePath("/my/favorites");
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === "FAVORITE_LISTING_NOT_PUBLIC") {
      return { success: false as const, error: "该服务当前不可收藏" };
    }
    logger.error("切换服务收藏失败", "toggleServiceFavorite", { error });
    return { success: false as const, error: "操作失败" };
  }
}

export async function getMyServiceFavorites(userId: string) {
  // Phase 6C-2 raw-auth hardening：私有收藏读必须 ACTIVE 账号 DB 复查；
  // 非本人或账号非 ACTIVE（含 SUSPENDED）→ 既有抑制形状（[]）
  const verified = await getVerifiedSession();

  // 未登录/账号不可用或会话用户与传入 userId 不一致时，仅返回空结果
  if (!verified.ok || verified.user.id !== userId) {
    return [];
  }

  const favorites = await prisma.serviceFavorite.findMany({
    where: {
      userId,
      // Phase 7C：PUBLIC 面——被治理隐藏的服务不再出现在收藏列表；
      // 同时收口既有缺陷（nested include 不受软删扩展拦截）
      // RB01 review repair（Phase 8F §9）：read = discovery projection，
      // 只投影 exposure state（ACTIVE）；favorite 行保留（visibility !=
      // existence）
      serviceListing: {
        deletedAt: null,
        status: SERVICE_PUBLIC_EXPOSURE_STATUS,
        ...listingModerationPublicFilter(),
      },
    },
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
  // Phase 6C-2 raw-auth hardening：私有收藏状态必须 ACTIVE 账号 DB 复查
  const verified = await getVerifiedSession();

  // 未登录/账号不可用或会话用户与传入 userId 不一致时，视为未收藏
  if (!verified.ok || verified.user.id !== userId) {
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
