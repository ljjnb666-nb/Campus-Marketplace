"use server";
import { listingModerationPublicFilter } from "@/lib/moderation/listing-moderation-query";

import { revalidatePath } from "next/cache";
import { prepareActiveAccountMutation } from "@/lib/governance/active-account-mutation";
import { prisma, withTransaction } from "@/lib/prisma";
import { requireUser, getVerifiedSession } from "@/lib/server-auth";
import { RENTAL_PUBLIC_EXPOSURE_STATUS } from "@/lib/listings/listing-lifecycle";
import { applyFavoriteToggle } from "@/lib/favorite-toggle";

export async function toggleRentalFavorite(formData: FormData) {
  const user = await requireUser();
  const rentalListingId = String(formData.get("rentalListingId") ?? "");

  if (!rentalListingId) return;

  // 同一事务内的删除/新建 + 计数增减，并发下保持一致。
  // Phase 8F（§21）：new favorite 仅对 public exposure（AVAILABLE）listing
  // 开放——锁内 fresh 判定；移除既有收藏属 allowed wind-down，不受限。
  // exposure 判定失败走哨兵错误整体回滚（零计数漂移），与"listing 缺失"
  // 同形静默安全结局
  try {
    await withTransaction(async (tx) => {
      const exposed = await tx.rentalListing.findFirst({
        where: {
          id: rentalListingId,
          deletedAt: null,
          status: RENTAL_PUBLIC_EXPOSURE_STATUS,
          ...listingModerationPublicFilter(),
        },
        select: { id: true },
      });

      await applyFavoriteToggle({
        // RB-03：active-account 序列化（durable 用户所有态）
        beforeToggle: () => prepareActiveAccountMutation(tx, user.id),
        deleteFavorite: () =>
          tx.rentalFavorite.deleteMany({
            where: { userId: user.id, rentalListingId },
          }),
        createFavorite: () => {
          if (!exposed) {
            throw new Error("FAVORITE_LISTING_NOT_PUBLIC");
          }
          return tx.rentalFavorite.create({
            data: { userId: user.id, rentalListingId },
          });
        },
        decrementCount: () =>
          tx.rentalListing.update({
            where: { id: rentalListingId },
            data: { favoriteCount: { decrement: 1 } },
          }),
        incrementCount: () =>
          tx.rentalListing.update({
            where: { id: rentalListingId },
            data: { favoriteCount: { increment: 1 } },
          }),
      });
    });
  } catch (error) {
    if (error instanceof Error && error.message === "FAVORITE_LISTING_NOT_PUBLIC") {
      return;
    }
    throw error;
  }

  revalidatePath(`/rentals/${rentalListingId}`);
  revalidatePath("/rentals");
  revalidatePath("/my/rental-favorites");
}

export async function getMyRentalFavorites(userId: string) {
  // Phase 6C-2 raw-auth hardening：私有收藏读必须 ACTIVE 账号 DB 复查；
  // 非本人或账号非 ACTIVE（含 SUSPENDED）→ 既有抑制形状（[]）
  const verified = await getVerifiedSession();

  // 未登录/账号不可用或会话用户与传入 userId 不一致时，仅返回空结果
  if (!verified.ok || verified.user.id !== userId) {
    return [];
  }

  return prisma.rentalFavorite.findMany({
    where: {
      userId,
      // Phase 7C：PUBLIC 面——被治理隐藏的租赁物品不再出现在收藏列表；
      // 同时收口既有缺陷（nested include 不受软删扩展拦截）
      rentalListing: {
        deletedAt: null,
        ...listingModerationPublicFilter(),
      },
    },
    orderBy: { createdAt: "desc" },
    include: {
      rentalListing: {
        include: {
          category: { select: { id: true, name: true } },
          campus: { select: { id: true, name: true } },
          owner: {
            select: {
              id: true,
              name: true,
              verificationStatus: true,
            },
          },
          images: { orderBy: { sortOrder: "asc" }, take: 1 },
        },
      },
    },
  });
}
