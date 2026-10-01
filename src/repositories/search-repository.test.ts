import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  productFindMany,
  errandFindMany,
  serviceFindMany,
  userFindMany,
  productGroupBy,
  errandGroupBy,
  serviceGroupBy,
  reviewGroupBy,
} = vi.hoisted(() => ({
  productFindMany: vi.fn(),
  errandFindMany: vi.fn(),
  serviceFindMany: vi.fn(),
  userFindMany: vi.fn(),
  productGroupBy: vi.fn(),
  errandGroupBy: vi.fn(),
  serviceGroupBy: vi.fn(),
  // Phase 8E：用户好评率 = canonical visible Review 批量聚合
  reviewGroupBy: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: {
      findMany: productFindMany,
      groupBy: productGroupBy,
    },
    errandTask: {
      findMany: errandFindMany,
      groupBy: errandGroupBy,
    },
    serviceListing: {
      findMany: serviceFindMany,
      groupBy: serviceGroupBy,
    },
    user: {
      findMany: userFindMany,
    },
    review: {
      groupBy: reviewGroupBy,
    },
  },
}));

import { getSearchResults } from "@/repositories/search-repository";

describe("getSearchResults", () => {
  beforeEach(() => {
    productFindMany.mockReset();
    errandFindMany.mockReset();
    serviceFindMany.mockReset();
    userFindMany.mockReset();
    productGroupBy.mockReset();
    errandGroupBy.mockReset();
    serviceGroupBy.mockReset();
    reviewGroupBy.mockReset().mockResolvedValue([]);
  });

  it("returns empty results immediately for a blank keyword", async () => {
    await expect(getSearchResults("   ")).resolves.toEqual({
      products: [],
      errands: [],
      services: [],
      users: [],
    });

    expect(productFindMany).not.toHaveBeenCalled();
    expect(errandFindMany).not.toHaveBeenCalled();
    expect(serviceFindMany).not.toHaveBeenCalled();
    expect(userFindMany).not.toHaveBeenCalled();
  });

  it("trims the keyword and queries all search domains with visible user counts", async () => {
    productFindMany.mockResolvedValue([{ id: "product-1" }]);
    errandFindMany.mockResolvedValue([{ id: "errand-1" }]);
    serviceFindMany.mockResolvedValue([{ id: "service-1" }]);
    userFindMany.mockResolvedValue([
      {
        id: "user-1",
        name: "李同学",
        bio: "一起打球",
        schoolName: "示例大学",
        completedOrdersCount: 8,
        campus: { id: "campus-1", name: "主校区" },
      },
    ]);
    // Phase 8E：用户好评率 = canonical visible Review 批量聚合（avg 4.5/5、1 条）
    reviewGroupBy.mockResolvedValue([
      { targetUserId: "user-1", _avg: { rating: 4.5 }, _count: { rating: 1 } },
    ]);
    productGroupBy.mockResolvedValue([{ sellerId: "user-1", _count: { sellerId: 2 } }]);
    errandGroupBy.mockResolvedValue([{ publisherId: "user-1", _count: { publisherId: 1 } }]);
    serviceGroupBy.mockResolvedValue([{ providerId: "user-1", _count: { providerId: 3 } }]);

    const result = await getSearchResults("  羽毛球  ");

    expect(result).toEqual({
      products: [{ id: "product-1" }],
      errands: [{ id: "errand-1" }],
      services: [{ id: "service-1" }],
      users: [
        {
          id: "user-1",
          name: "李同学",
          bio: "一起打球",
          schoolName: "示例大学",
          positiveReviewRate: 0.9,
          publishedReviewCount: 1,
          completedOrdersCount: 8,
          campus: { id: "campus-1", name: "主校区" },
          visibleCounts: {
            products: 2,
            createdErrandTasks: 1,
            serviceListings: 3,
          },
        },
      ],
    });

    const contains = { contains: "羽毛球", mode: "insensitive" };

    expect(productFindMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        status: "ACTIVE",
        moderations: { none: { resolvedAt: null } },
        OR: [{ title: contains }, { description: contains }, { locationText: contains }],
      },
      include: {
        category: true,
        seller: { select: { id: true, name: true } },
        images: { orderBy: { sortOrder: "asc" }, take: 1 },
      },
      orderBy: { createdAt: "desc" },
      take: 12,
    });

    expect(errandFindMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        // Phase 8F（§56）：search 只暴露 OPEN（exposure state only）
        status: "OPEN",
        moderations: { none: { resolvedAt: null } },
        OR: [
          { title: contains },
          { description: contains },
          { pickupLocation: contains },
          { deliveryLocation: contains },
        ],
      },
      include: {
        publisher: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 12,
    });

    expect(serviceFindMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        status: "ACTIVE",
        moderations: { none: { resolvedAt: null } },
        OR: [{ title: contains }, { description: contains }, { locationText: contains }],
      },
      include: {
        provider: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 12,
    });

    expect(userFindMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        status: "ACTIVE",
        OR: [{ name: contains }, { schoolName: contains }, { college: contains }, { bio: contains }],
      },
      select: {
        id: true,
        name: true,
        bio: true,
        schoolName: true,
        completedOrdersCount: true,
        campus: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: { completedOrdersCount: "desc" },
      take: 12,
    });

    expect(productGroupBy).toHaveBeenCalledWith({
      by: ["sellerId"],
      where: {
        sellerId: { in: ["user-1"] },
        deletedAt: null,
        status: "ACTIVE",
        moderations: { none: { resolvedAt: null } },
      },
      _count: {
        sellerId: true,
      },
    });
    expect(errandGroupBy).toHaveBeenCalledWith({
      by: ["publisherId"],
      where: {
        publisherId: { in: ["user-1"] },
        deletedAt: null,
        status: "OPEN",
        moderations: { none: { resolvedAt: null } },
      },
      _count: {
        publisherId: true,
      },
    });
    expect(serviceGroupBy).toHaveBeenCalledWith({
      by: ["providerId"],
      where: {
        providerId: { in: ["user-1"] },
        deletedAt: null,
        status: "ACTIVE",
        moderations: { none: { resolvedAt: null } },
      },
      _count: {
        providerId: true,
      },
    });
  });
});
