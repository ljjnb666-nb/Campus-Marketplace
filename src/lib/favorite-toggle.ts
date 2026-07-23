import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type FavoriteToggleResult = {
  success: true;
  isFavorited: boolean;
};

/**
 * Shared create/delete + favoriteCount bump used by listing favorites.
 * Ops are factories so the unused branch is never constructed.
 */
export async function applyFavoriteToggle(ops: {
  existing: { id: string } | null;
  remove: () => Prisma.PrismaPromise<unknown>[];
  add: () => Prisma.PrismaPromise<unknown>[];
}): Promise<FavoriteToggleResult> {
  if (ops.existing) {
    await prisma.$transaction(ops.remove());
    return { success: true, isFavorited: false };
  }

  await prisma.$transaction(ops.add());
  return { success: true, isFavorited: true };
}
