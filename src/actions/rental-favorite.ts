"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/server-auth";
import { auth } from "@/lib/auth";
import { applyFavoriteToggle } from "@/lib/favorite-toggle";

export async function toggleRentalFavorite(formData: FormData) {
  const user = await requireUser();
  const rentalListingId = String(formData.get("rentalListingId") ?? "");

  if (!rentalListingId) return;

  const listing = await prisma.rentalListing.findFirst({
    where: { id: rentalListingId, deletedAt: null },
    select: { id: true },
  });
  if (!listing) return;

  // 同一事务内的删除/新建 + 计数增减，并发下保持一致
  await prisma.$transaction(async (tx) =>
    applyFavoriteToggle({
      deleteFavorite: () =>
        tx.rentalFavorite.deleteMany({
          where: { userId: user.id, rentalListingId },
        }),
      createFavorite: () =>
        tx.rentalFavorite.create({
          data: { userId: user.id, rentalListingId },
        }),
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
    }),
  );

  revalidatePath(`/rentals/${rentalListingId}`);
  revalidatePath("/rentals");
  revalidatePath("/my/rental-favorites");
}

export async function getMyRentalFavorites(userId: string) {
  const session = await auth();

  // 未登录或会话用户与传入 userId 不一致时，仅返回空结果
  if (!session?.user?.id || session.user.id !== userId) {
    return [];
  }

  return prisma.rentalFavorite.findMany({
    where: { userId },
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
