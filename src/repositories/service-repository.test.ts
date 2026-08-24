import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  notFound,
  serviceListingFindMany,
  serviceListingCount,
  serviceListingFindFirst,
  serviceCategoryFindMany,
} = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  serviceListingFindMany: vi.fn(),
  serviceListingCount: vi.fn(),
  serviceListingFindFirst: vi.fn(),
  serviceCategoryFindMany: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    serviceListing: {
      findMany: serviceListingFindMany,
      count: serviceListingCount,
      findFirst: serviceListingFindFirst,
    },
    serviceCategory: {
      findMany: serviceCategoryFindMany,
    },
  },
}));

import {
  getMyServices,
  getServiceDetail,
  getServiceForEdit,
  getServiceFormMeta,
  getServiceList,
} from "@/repositories/service-repository";

describe("service repository", () => {
  beforeEach(() => {
    serviceListingFindMany.mockReset();
    serviceListingCount.mockReset();
    serviceListingFindFirst.mockReset();
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

  it("defaults to first page, latest sorting and no filters", async () => {
    serviceListingFindMany.mockResolvedValue([]);
    serviceListingCount.mockResolvedValue(0);
    serviceCategoryFindMany.mockResolvedValue([]);

    await getServiceList();

    const args = serviceListingFindMany.mock.calls[0][0];
    expect(args.where).toEqual({ deletedAt: null });
    expect(args.orderBy).toEqual([{ createdAt: "desc" }]);
    expect(args.skip).toBe(0);
  });

  it("ignores ALL shorthands for status and pricing unit", async () => {
    serviceListingFindMany.mockResolvedValue([]);
    serviceListingCount.mockResolvedValue(0);
    serviceCategoryFindMany.mockResolvedValue([]);

    await getServiceList({ status: "ALL", pricingUnit: "ALL" });

    expect(serviceListingFindMany.mock.calls[0][0].where).toEqual({ deletedAt: null });
  });

  it("loads form meta with active categories", async () => {
    serviceCategoryFindMany.mockResolvedValue([{ id: "service-category-1", name: "编程辅导", slug: "coding" }]);

    const result = await getServiceFormMeta();

    expect(result).toEqual({
      categories: [{ id: "service-category-1", name: "编程辅导", slug: "coding" }],
    });
    expect(serviceCategoryFindMany.mock.calls[0][0].where).toEqual({ isActive: true });
  });

  it("returns service detail with ranked related services", async () => {
    const target = {
      id: "service-1",
      campusId: "campus-1",
      categoryId: "category-1",
      pricingUnit: "PER_HOUR",
    };
    serviceListingFindFirst.mockResolvedValue(target);
    serviceListingFindMany.mockResolvedValue([
      { id: "same-all", campusId: "campus-1", categoryId: "category-1", pricingUnit: "PER_HOUR", completedOrderCount: 1, provider: { verificationStatus: "VERIFIED" }, createdAt: new Date() },
      { id: "weak-match", campusId: "campus-2", categoryId: "category-2", pricingUnit: "PER_ORDER", completedOrderCount: 0, provider: { verificationStatus: "UNVERIFIED" }, createdAt: new Date() },
    ]);

    const result = await getServiceDetail("service-1");

    expect(result.service.id).toBe("service-1");
    const poolArgs = serviceListingFindMany.mock.calls[0][0];
    expect(poolArgs.where.status).toBe("ACTIVE");
    expect(poolArgs.where.id).toEqual({ not: "service-1" });
    expect(result.relatedServices).toHaveLength(2);
    expect(result.relatedServices[0].reason).toBe("同校区同分类");
  });

  it("throws notFound for missing service detail", async () => {
    serviceListingFindFirst.mockResolvedValue(null);

    await expect(getServiceDetail("missing")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("loads service with categories for the owner to edit", async () => {
    serviceListingFindFirst.mockResolvedValue({ id: "service-1" });
    serviceCategoryFindMany.mockResolvedValue([{ id: "service-category-1", name: "编程辅导", slug: "coding" }]);

    const result = await getServiceForEdit("service-1", "user-1");

    expect(result.service).toEqual({ id: "service-1" });
    expect(result.categories).toHaveLength(1);
    expect(serviceListingFindFirst.mock.calls[0][0].where).toEqual({
      id: "service-1",
      providerId: "user-1",
      deletedAt: null,
    });
  });

  it("throws notFound when editing another user's service", async () => {
    serviceListingFindFirst.mockResolvedValue(null);
    serviceCategoryFindMany.mockResolvedValue([]);

    await expect(getServiceForEdit("service-1", "user-2")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("lists services owned by the user", async () => {
    serviceListingFindMany.mockResolvedValue([{ id: "service-1" }]);

    const items = await getMyServices("user-1");

    expect(items).toEqual([{ id: "service-1" }]);
    const args = serviceListingFindMany.mock.calls[0][0];
    expect(args.where).toEqual({ providerId: "user-1", deletedAt: null });
    expect(args.orderBy).toEqual({ createdAt: "desc" });
    expect(args.include).toEqual({ campus: true, category: true });
  });
});
