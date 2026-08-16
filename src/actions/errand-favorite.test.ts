import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePath,
  requireUser,
  auth,
  errandFavoriteFindUnique,
  errandFavoriteFindMany,
  errandFavoriteCreate,
  errandFavoriteDeleteMany,
  errandTaskUpdate,
  transactionMock,
} = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  auth: vi.fn(),
  errandFavoriteFindUnique: vi.fn(),
  errandFavoriteFindMany: vi.fn(),
  errandFavoriteCreate: vi.fn(),
  errandFavoriteDeleteMany: vi.fn(),
  errandTaskUpdate: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath,
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/lib/auth", () => ({
  auth,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    errandFavorite: {
      findUnique: errandFavoriteFindUnique,
      findMany: errandFavoriteFindMany,
      create: errandFavoriteCreate,
      deleteMany: errandFavoriteDeleteMany,
    },
    errandTask: {
      update: errandTaskUpdate,
    },
    $transaction: transactionMock,
  },
}));

import {
  toggleErrandFavorite,
  getMyErrandFavorites,
  checkErrandFavorited,
} from "@/actions/errand-favorite";

function p2002Error() {
  return Object.assign(
    new Error("Unique constraint failed on the fields: (`userId`,`errandTaskId`)"),
    { code: "P2002" },
  );
}

describe("errand favorite actions", () => {
  beforeEach(() => {
    revalidatePath.mockReset();
    requireUser.mockReset();
    auth.mockReset();
    errandFavoriteFindUnique.mockReset();
    errandFavoriteFindMany.mockReset();
    errandFavoriteCreate.mockReset();
    errandFavoriteDeleteMany.mockReset();
    errandTaskUpdate.mockReset();
    transactionMock.mockReset();

    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT" });
    auth.mockResolvedValue({ user: { id: "user-1" } });
    errandFavoriteDeleteMany.mockResolvedValue({ count: 0 });
    errandFavoriteCreate.mockResolvedValue({ id: "favorite-1" });
    errandTaskUpdate.mockResolvedValue({});
    // 事务回调与顶层 prisma 委托共享同一组 mock
    transactionMock.mockImplementation(
      async (run: (tx: unknown) => unknown) =>
        run({
          errandFavorite: {
            deleteMany: errandFavoriteDeleteMany,
            create: errandFavoriteCreate,
          },
          errandTask: { update: errandTaskUpdate },
        }),
    );
  });

  describe("toggleErrandFavorite", () => {
    it("adds a favorite for the session user only", async () => {
      errandFavoriteDeleteMany.mockResolvedValue({ count: 0 });

      const result = await toggleErrandFavorite("errand-1");

      expect(requireUser).toHaveBeenCalledTimes(1);
      expect(transactionMock).toHaveBeenCalledTimes(1);
      expect(errandFavoriteDeleteMany).toHaveBeenCalledWith({
        where: { userId: "user-1", errandTaskId: "errand-1" },
      });
      expect(errandFavoriteCreate).toHaveBeenCalledWith({
        data: { userId: "user-1", errandTaskId: "errand-1" },
      });
      expect(errandTaskUpdate).toHaveBeenCalledWith({
        where: { id: "errand-1" },
        data: { favoriteCount: { increment: 1 } },
      });
      expect(result).toEqual({ success: true, isFavorited: true });
      expect(revalidatePath).toHaveBeenCalledWith("/errands");
      expect(revalidatePath).toHaveBeenCalledWith("/my/favorites");
    });

    it("removes an existing favorite for the session user", async () => {
      errandFavoriteDeleteMany.mockResolvedValue({ count: 1 });

      const result = await toggleErrandFavorite("errand-1");

      expect(errandTaskUpdate).toHaveBeenCalledWith({
        where: { id: "errand-1" },
        data: { favoriteCount: { decrement: 1 } },
      });
      expect(errandTaskUpdate).toHaveBeenCalledTimes(1);
      expect(errandFavoriteCreate).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, isFavorited: false });
    });

    it("never trusts a foreign userId because identity comes from the session", async () => {
      errandFavoriteDeleteMany.mockResolvedValue({ count: 0 });

      await toggleErrandFavorite("errand-1");

      const deleteCall = errandFavoriteDeleteMany.mock.calls[0][0] as {
        where: { userId: string };
      };
      const createCall = errandFavoriteCreate.mock.calls[0][0] as {
        data: { userId: string };
      };
      expect(deleteCall.where.userId).toBe("user-1");
      expect(createCall.data.userId).toBe("user-1");
      expect(createCall.data.userId).not.toBe("user-2");
    });

    it("treats a concurrent create that loses the unique constraint race as idempotent", async () => {
      // 竞态模拟：另一个并发请求刚刚创建了收藏行
      errandFavoriteDeleteMany.mockResolvedValue({ count: 0 });
      errandFavoriteCreate.mockRejectedValue(p2002Error());

      const result = await toggleErrandFavorite("errand-1");

      expect(result).toEqual({ success: true, isFavorited: true });
      // create 失败时绝不能增减计数器，否则 favoriteCount 漂移
      expect(errandTaskUpdate).not.toHaveBeenCalled();
    });

    it("does not touch the database when there is no session", async () => {
      requireUser.mockRejectedValue(new Error("REDIRECT:/login"));

      await expect(toggleErrandFavorite("errand-1")).rejects.toThrow(
        "REDIRECT:/login",
      );

      expect(errandFavoriteDeleteMany).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it("returns a friendly error when the toggle fails", async () => {
      errandFavoriteDeleteMany.mockRejectedValue(new Error("db down"));

      const result = await toggleErrandFavorite("errand-1");

      expect(result).toEqual({ success: false, error: "操作失败" });
    });
  });

  describe("getMyErrandFavorites", () => {
    it("returns favorites when the session user matches the parameter", async () => {
      const favorites = [{ id: "favorite-1" }];
      errandFavoriteFindMany.mockResolvedValue(favorites);

      const result = await getMyErrandFavorites("user-1");

      expect(result).toBe(favorites);
      expect(errandFavoriteFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "user-1" } }),
      );
    });

    it("returns an empty list for guests", async () => {
      auth.mockResolvedValue(null);

      const result = await getMyErrandFavorites("user-1");

      expect(result).toEqual([]);
      expect(errandFavoriteFindMany).not.toHaveBeenCalled();
    });

    it("returns an empty list when the session user does not match the parameter", async () => {
      auth.mockResolvedValue({ user: { id: "user-1" } });

      const result = await getMyErrandFavorites("user-2");

      expect(result).toEqual([]);
      expect(errandFavoriteFindMany).not.toHaveBeenCalled();
    });
  });

  describe("checkErrandFavorited", () => {
    it("returns true when the session user has favorited the errand", async () => {
      errandFavoriteFindUnique.mockResolvedValue({ id: "favorite-1" });

      const result = await checkErrandFavorited("user-1", "errand-1");

      expect(result).toBe(true);
      expect(errandFavoriteFindUnique).toHaveBeenCalledWith({
        where: {
          userId_errandTaskId: {
            userId: "user-1",
            errandTaskId: "errand-1",
          },
        },
      });
    });

    it("returns false for guests", async () => {
      auth.mockResolvedValue(null);

      const result = await checkErrandFavorited("user-1", "errand-1");

      expect(result).toBe(false);
      expect(errandFavoriteFindUnique).not.toHaveBeenCalled();
    });

    it("returns false when the session user does not match the parameter", async () => {
      auth.mockResolvedValue({ user: { id: "user-1" } });

      const result = await checkErrandFavorited("user-2", "errand-1");

      expect(result).toBe(false);
      expect(errandFavoriteFindUnique).not.toHaveBeenCalled();
    });
  });
});
