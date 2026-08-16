import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePath,
  requireUser,
  auth,
  rentalListingFindFirst,
  rentalListingUpdate,
  rentalFavoriteFindUnique,
  rentalFavoriteFindMany,
  rentalFavoriteCreate,
  rentalFavoriteDeleteMany,
  transactionMock,
} = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  auth: vi.fn(),
  rentalListingFindFirst: vi.fn(),
  rentalListingUpdate: vi.fn(),
  rentalFavoriteFindUnique: vi.fn(),
  rentalFavoriteFindMany: vi.fn(),
  rentalFavoriteCreate: vi.fn(),
  rentalFavoriteDeleteMany: vi.fn(),
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
    rentalListing: {
      findFirst: rentalListingFindFirst,
      update: rentalListingUpdate,
    },
    rentalFavorite: {
      findUnique: rentalFavoriteFindUnique,
      findMany: rentalFavoriteFindMany,
      create: rentalFavoriteCreate,
      deleteMany: rentalFavoriteDeleteMany,
    },
    $transaction: transactionMock,
  },
}));

import {
  toggleRentalFavorite,
  getMyRentalFavorites,
} from "@/actions/rental-favorite";

function buildFormData(rentalListingId: string) {
  const formData = new FormData();
  formData.set("rentalListingId", rentalListingId);
  return formData;
}

function p2002Error() {
  return Object.assign(
    new Error(
      "Unique constraint failed on the fields: (`userId`,`rentalListingId`)",
    ),
    { code: "P2002" },
  );
}

describe("rental favorite actions", () => {
  beforeEach(() => {
    revalidatePath.mockReset();
    requireUser.mockReset();
    auth.mockReset();
    rentalListingFindFirst.mockReset();
    rentalListingUpdate.mockReset();
    rentalFavoriteFindUnique.mockReset();
    rentalFavoriteFindMany.mockReset();
    rentalFavoriteCreate.mockReset();
    rentalFavoriteDeleteMany.mockReset();
    transactionMock.mockReset();

    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT" });
    auth.mockResolvedValue({ user: { id: "user-1" } });
    rentalListingFindFirst.mockResolvedValue({ id: "rental-1" });
    rentalFavoriteDeleteMany.mockResolvedValue({ count: 0 });
    rentalFavoriteCreate.mockResolvedValue({ id: "favorite-1" });
    rentalListingUpdate.mockResolvedValue({});
    // 事务回调与顶层 prisma 委托共享同一组 mock
    transactionMock.mockImplementation(
      async (run: (tx: unknown) => unknown) =>
        run({
          rentalFavorite: {
            deleteMany: rentalFavoriteDeleteMany,
            create: rentalFavoriteCreate,
          },
          rentalListing: { update: rentalListingUpdate },
        }),
    );
  });

  describe("toggleRentalFavorite", () => {
    it("adds a favorite for the session user only", async () => {
      rentalFavoriteDeleteMany.mockResolvedValue({ count: 0 });

      await toggleRentalFavorite(buildFormData("rental-1"));

      expect(requireUser).toHaveBeenCalledTimes(1);
      expect(transactionMock).toHaveBeenCalledTimes(1);
      expect(rentalFavoriteDeleteMany).toHaveBeenCalledWith({
        where: { userId: "user-1", rentalListingId: "rental-1" },
      });
      expect(rentalFavoriteCreate).toHaveBeenCalledWith({
        data: { userId: "user-1", rentalListingId: "rental-1" },
      });
      expect(rentalListingUpdate).toHaveBeenCalledWith({
        where: { id: "rental-1" },
        data: { favoriteCount: { increment: 1 } },
      });
      expect(revalidatePath).toHaveBeenCalledWith("/rentals/rental-1");
      expect(revalidatePath).toHaveBeenCalledWith("/rentals");
      expect(revalidatePath).toHaveBeenCalledWith("/my/rental-favorites");
    });

    it("removes an existing favorite for the session user", async () => {
      rentalFavoriteDeleteMany.mockResolvedValue({ count: 1 });

      await toggleRentalFavorite(buildFormData("rental-1"));

      expect(rentalListingUpdate).toHaveBeenCalledWith({
        where: { id: "rental-1" },
        data: { favoriteCount: { decrement: 1 } },
      });
      expect(rentalListingUpdate).toHaveBeenCalledTimes(1);
      expect(rentalFavoriteCreate).not.toHaveBeenCalled();
    });

    it("never trusts a foreign userId because identity comes from the session", async () => {
      rentalFavoriteDeleteMany.mockResolvedValue({ count: 0 });

      await toggleRentalFavorite(buildFormData("rental-1"));

      const deleteCall = rentalFavoriteDeleteMany.mock.calls[0][0] as {
        where: { userId: string };
      };
      const createCall = rentalFavoriteCreate.mock.calls[0][0] as {
        data: { userId: string };
      };
      expect(deleteCall.where.userId).toBe("user-1");
      expect(createCall.data.userId).toBe("user-1");
      expect(createCall.data.userId).not.toBe("user-2");
    });

    it("treats a concurrent create that loses the unique constraint race as idempotent", async () => {
      // 竞态模拟：另一个并发请求刚刚创建了收藏行
      rentalFavoriteDeleteMany.mockResolvedValue({ count: 0 });
      rentalFavoriteCreate.mockRejectedValue(p2002Error());

      await expect(
        toggleRentalFavorite(buildFormData("rental-1")),
      ).resolves.toBeUndefined();

      // create 失败时绝不能增减计数器，否则 favoriteCount 漂移
      expect(rentalListingUpdate).not.toHaveBeenCalled();
      expect(revalidatePath).toHaveBeenCalledWith("/rentals/rental-1");
    });

    it("does not touch the database when there is no session", async () => {
      requireUser.mockRejectedValue(new Error("REDIRECT:/login"));

      await expect(
        toggleRentalFavorite(buildFormData("rental-1")),
      ).rejects.toThrow("REDIRECT:/login");

      expect(rentalListingFindFirst).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it("does nothing when the listing does not exist", async () => {
      rentalListingFindFirst.mockResolvedValue(null);

      await toggleRentalFavorite(buildFormData("rental-1"));

      expect(rentalFavoriteDeleteMany).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it("does nothing when the listing id is missing", async () => {
      await toggleRentalFavorite(new FormData());

      expect(rentalListingFindFirst).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    });
  });

  describe("getMyRentalFavorites", () => {
    it("returns favorites when the session user matches the parameter", async () => {
      const favorites = [{ id: "favorite-1" }];
      rentalFavoriteFindMany.mockResolvedValue(favorites);

      const result = await getMyRentalFavorites("user-1");

      expect(result).toBe(favorites);
      expect(rentalFavoriteFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "user-1" } }),
      );
    });

    it("returns an empty list for guests", async () => {
      auth.mockResolvedValue(null);

      const result = await getMyRentalFavorites("user-1");

      expect(result).toEqual([]);
      expect(rentalFavoriteFindMany).not.toHaveBeenCalled();
    });

    it("returns an empty list when the session user does not match the parameter", async () => {
      auth.mockResolvedValue({ user: { id: "user-1" } });

      const result = await getMyRentalFavorites("user-2");

      expect(result).toEqual([]);
      expect(rentalFavoriteFindMany).not.toHaveBeenCalled();
    });
  });
});
