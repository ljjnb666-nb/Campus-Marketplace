"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/server-auth";
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

  const existing = await prisma.rentalFavorite.findUnique({
    where: {
      userId_rentalListingId: {
        userId: user.id,
        rentalListingId,
      },
    },
  });

  await applyFavoriteToggle({
    existing,
    remove: () => [
      prisma.rentalFavorite.delete({
        where: {
          userId_rentalListingId: {
            userId: user.id,
            rentalListingId,
          },
        },
      }),
      prisma.rentalListing.update({
        where: { id: rentalListingId },
        data: { favoriteCount: { decrement: 1 } },
      }),
    ],
    add: () => [
      prisma.rentalFavorite.create({
        data: {
          userId: user.id,
          rentalListingId,
        },
      }),
      prisma.rentalListing.update({
        where: { id: rentalListingId },
        data: { favoriteCount: { increment: 1 } },
      }),
    ],
  });

  revalidatePath(`/rentals/${rentalListingId}`);
  revalidatePath("/rentals");
  revalidatePath("/my/rental-favorites");
}

export async function getMyRentalFavorites(userId: string) {
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
