import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePath,
  requireUser,
  auth,
  serviceFavoriteFindUnique,
  serviceFavoriteFindMany,
  serviceFavoriteCreate,
  serviceFavoriteDeleteMany,
  serviceListingUpdate,
  transactionMock,
} = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  auth: vi.fn(),
  serviceFavoriteFindUnique: vi.fn(),
  serviceFavoriteFindMany: vi.fn(),
  serviceFavoriteCreate: vi.fn(),
  serviceFavoriteDeleteMany: vi.fn(),
  serviceListingUpdate: vi.fn(),
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
    serviceFavorite: {
      findUnique: serviceFavoriteFindUnique,
      findMany: serviceFavoriteFindMany,
      create: serviceFavoriteCreate,
      deleteMany: serviceFavoriteDeleteMany,
    },
    serviceListing: {
      update: serviceListingUpdate,
    },
    $transaction: transactionMock,
  },
  withTransaction: transactionMock,
}));

import {
  toggleServiceFavorite,
  getMyServiceFavorites,
  checkServiceFavorited,
} from "@/actions/service-favorite";

function p2002Error() {
  return Object.assign(
    new Error(
      "Unique constraint failed on the fields: (`userId`,`serviceListingId`)",
    ),
    { code: "P2002" },
  );
}

describe("service favorite actions", () => {
  beforeEach(() => {
    revalidatePath.mockReset();
    requireUser.mockReset();
    auth.mockReset();
    serviceFavoriteFindUnique.mockReset();
    serviceFavoriteFindMany.mockReset();
    serviceFavoriteCreate.mockReset();
    serviceFavoriteDeleteMany.mockReset();
    serviceListingUpdate.mockReset();
    transactionMock.mockReset();

    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT" });
    auth.mockResolvedValue({ user: { id: "user-1" } });
    serviceFavoriteDeleteMany.mockResolvedValue({ count: 0 });
    serviceFavoriteCreate.mockResolvedValue({ id: "favorite-1" });
    serviceListingUpdate.mockResolvedValue({});
    // 事务回调与顶层 prisma 委托共享同一组 mock
    transactionMock.mockImplementation(
      async (run: (tx: unknown) => unknown) =>
        run({
          serviceFavorite: {
            deleteMany: serviceFavoriteDeleteMany,
            create: serviceFavoriteCreate,
          },
          serviceListing: { update: serviceListingUpdate },
        }),
    );
  });

  describe("toggleServiceFavorite", () => {
    it("adds a favorite for the session user only", async () => {
      serviceFavoriteDeleteMany.mockResolvedValue({ count: 0 });

      const result = await toggleServiceFavorite("service-1");

      expect(requireUser).toHaveBeenCalledTimes(1);
      expect(transactionMock).toHaveBeenCalledTimes(1);
      expect(serviceFavoriteDeleteMany).toHaveBeenCalledWith({
        where: { userId: "user-1", serviceListingId: "service-1" },
      });
      expect(serviceFavoriteCreate).toHaveBeenCalledWith({
        data: { userId: "user-1", serviceListingId: "service-1" },
      });
      expect(serviceListingUpdate).toHaveBeenCalledWith({
        where: { id: "service-1" },
        data: { favoriteCount: { increment: 1 } },
      });
      expect(result).toEqual({ success: true, isFavorited: true });
      expect(revalidatePath).toHaveBeenCalledWith("/services");
      expect(revalidatePath).toHaveBeenCalledWith("/my/favorites");
    });

    it("removes an existing favorite for the session user", async () => {
      serviceFavoriteDeleteMany.mockResolvedValue({ count: 1 });

      const result = await toggleServiceFavorite("service-1");

      expect(serviceListingUpdate).toHaveBeenCalledWith({
        where: { id: "service-1" },
        data: { favoriteCount: { decrement: 1 } },
      });
      expect(serviceListingUpdate).toHaveBeenCalledTimes(1);
      expect(serviceFavoriteCreate).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, isFavorited: false });
    });

    it("never trusts a foreign userId because identity comes from the session", async () => {
      serviceFavoriteDeleteMany.mockResolvedValue({ count: 0 });

      await toggleServiceFavorite("service-1");

      const deleteCall = serviceFavoriteDeleteMany.mock.calls[0][0] as {
        where: { userId: string };
      };
      const createCall = serviceFavoriteCreate.mock.calls[0][0] as {
        data: { userId: string };
      };
      expect(deleteCall.where.userId).toBe("user-1");
      expect(createCall.data.userId).toBe("user-1");
      expect(createCall.data.userId).not.toBe("user-2");
    });

    it("treats a concurrent create that loses the unique constraint race as idempotent", async () => {
      // 竞态模拟：另一个并发请求刚刚创建了收藏行
      serviceFavoriteDeleteMany.mockResolvedValue({ count: 0 });
      serviceFavoriteCreate.mockRejectedValue(p2002Error());

      const result = await toggleServiceFavorite("service-1");

      expect(result).toEqual({ success: true, isFavorited: true });
      // create 失败时绝不能增减计数器，否则 favoriteCount 漂移
      expect(serviceListingUpdate).not.toHaveBeenCalled();
    });

    it("does not touch the database when there is no session", async () => {
      requireUser.mockRejectedValue(new Error("REDIRECT:/login"));

      await expect(toggleServiceFavorite("service-1")).rejects.toThrow(
        "REDIRECT:/login",
      );

      expect(serviceFavoriteDeleteMany).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it("returns a friendly error when the toggle fails", async () => {
      serviceFavoriteDeleteMany.mockRejectedValue(new Error("db down"));

      const result = await toggleServiceFavorite("service-1");

      expect(result).toEqual({ success: false, error: "操作失败" });
    });
  });

  describe("getMyServiceFavorites", () => {
    it("returns favorites when the session user matches the parameter", async () => {
      const favorites = [{ id: "favorite-1" }];
      serviceFavoriteFindMany.mockResolvedValue(favorites);

      const result = await getMyServiceFavorites("user-1");

      expect(result).toBe(favorites);
      expect(serviceFavoriteFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "user-1" } }),
      );
    });

    it("returns an empty list for guests", async () => {
      auth.mockResolvedValue(null);

      const result = await getMyServiceFavorites("user-1");

      expect(result).toEqual([]);
      expect(serviceFavoriteFindMany).not.toHaveBeenCalled();
    });

    it("returns an empty list when the session user does not match the parameter", async () => {
      auth.mockResolvedValue({ user: { id: "user-1" } });

      const result = await getMyServiceFavorites("user-2");

      expect(result).toEqual([]);
      expect(serviceFavoriteFindMany).not.toHaveBeenCalled();
    });
  });

  describe("checkServiceFavorited", () => {
    it("returns true when the session user has favorited the service", async () => {
      serviceFavoriteFindUnique.mockResolvedValue({ id: "favorite-1" });

      const result = await checkServiceFavorited("user-1", "service-1");

      expect(result).toBe(true);
      expect(serviceFavoriteFindUnique).toHaveBeenCalledWith({
        where: {
          userId_serviceListingId: {
            userId: "user-1",
            serviceListingId: "service-1",
          },
        },
      });
    });

    it("returns false for guests", async () => {
      auth.mockResolvedValue(null);

      const result = await checkServiceFavorited("user-1", "service-1");

      expect(result).toBe(false);
      expect(serviceFavoriteFindUnique).not.toHaveBeenCalled();
    });

    it("returns false when the session user does not match the parameter", async () => {
      auth.mockResolvedValue({ user: { id: "user-1" } });

      const result = await checkServiceFavorited("user-2", "service-1");

      expect(result).toBe(false);
      expect(serviceFavoriteFindUnique).not.toHaveBeenCalled();
    });
  });
});
