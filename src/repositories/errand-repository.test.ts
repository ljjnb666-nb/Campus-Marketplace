import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  errandTaskFindMany,
  errandTaskCount,
  errandCategoryFindMany,
} = vi.hoisted(() => ({
  errandTaskFindMany: vi.fn(),
  errandTaskCount: vi.fn(),
  errandCategoryFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    errandTask: {
      findMany: errandTaskFindMany,
      count: errandTaskCount,
    },
    errandCategory: {
      findMany: errandCategoryFindMany,
    },
  },
}));

import { getErrandList } from "@/repositories/errand-repository";

describe("errand repository", () => {
  beforeEach(() => {
    errandTaskFindMany.mockReset();
    errandTaskCount.mockReset();
    errandCategoryFindMany.mockReset();
  });

  it("builds errand list filters, sorting, deadline window and categories", async () => {
    errandTaskFindMany.mockResolvedValue([{ id: "errand-1" }]);
    errandTaskCount.mockResolvedValue(13);
    errandCategoryFindMany.mockResolvedValue([{ id: "category-1", name: "代取快递" }]);

    const result = await getErrandList({
      q: "快递",
      category: "category-1",
      status: "OPEN",
      deadline: "3days",
      sort: "reward_desc",
      page: 2,
    });

    expect(errandTaskFindMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        OR: [
          { title: { contains: "快递", mode: "insensitive" } },
          { description: { contains: "快递", mode: "insensitive" } },
          { pickupLocation: { contains: "快递", mode: "insensitive" } },
          { deliveryLocation: { contains: "快递", mode: "insensitive" } },
        ],
        categoryId: "category-1",
        status: "OPEN",
        deadline: {
          gte: expect.any(Date),
          lte: expect.any(Date),
        },
      },
      orderBy: [
        { reward: "desc" },
        { createdAt: "desc" },
      ],
      skip: 12,
      take: 12,
      include: {
        category: true,
        publisher: {
          select: {
            id: true,
            name: true,
            schoolName: true,
            verificationStatus: true,
          },
        },
        accepter: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
    expect(errandCategoryFindMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true },
    });
    expect(result).toEqual({
      items: [{ id: "errand-1" }],
      total: 13,
      categories: [{ id: "category-1", name: "代取快递" }],
      page: 2,
      pageSize: 12,
      totalPages: 2,
    });
  });
});
