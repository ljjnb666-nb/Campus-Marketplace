import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  productFindMany,
  productCount,
  favoriteFindMany,
} = vi.hoisted(() => ({
  productFindMany: vi.fn(),
  productCount: vi.fn(),
  favoriteFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: {
      findMany: productFindMany,
      count: productCount,
    },
    favorite: {
      findMany: favoriteFindMany,
    },
  },
}));

import {
  getMyFavoriteProducts,
  getMyProducts,
  getProductList,
} from "@/repositories/product-repository";

describe("product repository", () => {
  beforeEach(() => {
    productFindMany.mockReset();
    productCount.mockReset();
    favoriteFindMany.mockReset();
  });

  it("builds product list filters, sorting, pagination and favorites include", async () => {
    productFindMany.mockResolvedValue([{ id: "product-1" }]);
    productCount.mockResolvedValue(25);

    const result = await getProductList({
      q: "教材",
      category: "category-1",
      status: "ACTIVE",
      minPrice: "10",
      maxPrice: "30",
      sort: "popular",
      page: 2,
      currentUserId: "user-1",
    });

    expect(productFindMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        OR: [
          { title: { contains: "教材", mode: "insensitive" } },
          { description: { contains: "教材", mode: "insensitive" } },
          { locationText: { contains: "教材", mode: "insensitive" } },
        ],
        categoryId: "category-1",
        status: "ACTIVE",
        price: {
          gte: expect.anything(),
          lte: expect.anything(),
        },
      },
      orderBy: [
        { favoriteCount: "desc" },
        { viewCount: "desc" },
        { createdAt: "desc" },
      ],
      skip: 12,
      take: 12,
      include: {
        category: true,
        seller: {
          select: {
            id: true,
            name: true,
            verificationStatus: true,
            schoolName: true,
          },
        },
        images: {
          orderBy: { sortOrder: "asc" },
          take: 1,
        },
        favorites: {
          where: { userId: "user-1" },
          select: { id: true },
          take: 1,
        },
      },
    });
    expect(productCount).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        OR: [
          { title: { contains: "教材", mode: "insensitive" } },
          { description: { contains: "教材", mode: "insensitive" } },
          { locationText: { contains: "教材", mode: "insensitive" } },
        ],
        categoryId: "category-1",
        status: "ACTIVE",
        price: {
          gte: expect.anything(),
          lte: expect.anything(),
        },
      },
    });
    expect(result).toEqual({
      items: [{ id: "product-1" }],
      total: 25,
      page: 2,
      pageSize: 12,
      totalPages: 3,
    });
  });

  it("returns the seller's latest products bounded to the most recent 100", async () => {
    productFindMany.mockResolvedValue([{ id: "product-1" }]);

    await getMyProducts("user-1");

    expect(productFindMany).toHaveBeenCalledWith({
      where: {
        sellerId: "user-1",
        deletedAt: null,
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        category: true,
        images: {
          orderBy: { sortOrder: "asc" },
          take: 1,
        },
      },
    });
  });

  it("returns the user's latest favorite products bounded to the most recent 100", async () => {
    favoriteFindMany.mockResolvedValue([{ id: "favorite-1" }]);

    await getMyFavoriteProducts("user-1");

    expect(favoriteFindMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        product: {
          include: {
            category: true,
            seller: {
              select: {
                name: true,
              },
            },
            images: {
              orderBy: { sortOrder: "asc" },
              take: 1,
            },
          },
        },
      },
    });
  });
});
