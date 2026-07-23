import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  serviceListingFindMany,
  serviceListingCount,
  serviceCategoryFindMany,
} = vi.hoisted(() => ({
  serviceListingFindMany: vi.fn(),
  serviceListingCount: vi.fn(),
  serviceCategoryFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    serviceListing: {
      findMany: serviceListingFindMany,
      count: serviceListingCount,
    },
    serviceCategory: {
      findMany: serviceCategoryFindMany,
    },
  },
}));

import { getServiceList } from "@/repositories/service-repository";

describe("service repository", () => {
  beforeEach(() => {
    serviceListingFindMany.mockReset();
    serviceListingCount.mockReset();
    serviceCategoryFindMany.mockReset();
  });

  it("builds service list filters, category filter, verified-only condition and order sorting", async () => {
    serviceListingFindMany.mockResolvedValue([{ id: "service-1" }]);
    serviceListingCount.mockResolvedValue(14);
    serviceCategoryFindMany.mockResolvedValue([{ id: "service-category-1", name: "编程辅导", slug: "coding" }]);

    const result = await getServiceList({
      q: "辅导",
      status: "ACTIVE",
      pricingUnit: "PER_HOUR",
      categorySlug: "coding",
      verifiedOnly: true,
      sort: "orders_desc",
      page: 2,
    });

    expect(serviceListingFindMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        OR: [
          { title: { contains: "辅导", mode: "insensitive" } },
          { description: { contains: "辅导", mode: "insensitive" } },
          { locationText: { contains: "辅导", mode: "insensitive" } },
        ],
        status: "ACTIVE",
        pricingUnit: "PER_HOUR",
        category: { slug: "coding" },
        provider: { verificationStatus: "VERIFIED" },
      },
      orderBy: [{ completedOrderCount: "desc" }, { createdAt: "desc" }],
      skip: 12,
      take: 12,
      include: {
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        provider: {
          select: {
            id: true,
            name: true,
            schoolName: true,
            verificationStatus: true,
          },
        },
      },
    });
    expect(serviceListingCount).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        OR: [
          { title: { contains: "辅导", mode: "insensitive" } },
          { description: { contains: "辅导", mode: "insensitive" } },
          { locationText: { contains: "辅导", mode: "insensitive" } },
        ],
        status: "ACTIVE",
        pricingUnit: "PER_HOUR",
        category: { slug: "coding" },
        provider: { verificationStatus: "VERIFIED" },
      },
    });
    expect(result).toEqual({
      items: [{ id: "service-1" }],
      total: 14,
      page: 2,
      pageSize: 12,
      totalPages: 2,
      categories: [{ id: "service-category-1", name: "编程辅导", slug: "coding" }],
    });
  });
});
