import type { Prisma } from "@prisma/client";

export type FavoriteToggleResult = {
  success: true;
  isFavorited: boolean;
};

function isUniqueConstraintViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * 竞态安全的收藏切换，必须放在同一个 prisma.$transaction 回调中执行。
 *
 * deleteMany 的返回值能证明是否真的删掉了行，因此只有真正移除收藏时才
 * 递减 favoriteCount；两个并发的“添加”同时看到无收藏时，只有一个 create
 * 成功，另一个触发唯一约束 P2002，按幂等的“已收藏”处理而不是把错误抛
 * 给用户。计数器永远不会漂移。
 *
 * Ops 是零参工厂，让未走到的分支完全不执行。
 */
export async function applyFavoriteToggle(ops: {
  deleteFavorite: () => Promise<{ count: number }>;
  createFavorite: () => Promise<unknown>;
  decrementCount: () => Promise<unknown>;
  incrementCount: () => Promise<unknown>;
}): Promise<FavoriteToggleResult> {
  const removed = await ops.deleteFavorite();

  if (removed.count > 0) {
    await ops.decrementCount();
    return { success: true, isFavorited: false };
  }

  try {
    await ops.createFavorite();
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      // 并发切换已经创建了收藏行，视为幂等成功
      return { success: true, isFavorited: true };
    }

    throw error;
  }

  await ops.incrementCount();
  return { success: true, isFavorited: true };
}
