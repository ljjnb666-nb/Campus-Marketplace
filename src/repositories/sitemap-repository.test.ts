import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  productFindMany,
  errandTaskFindMany,
  serviceListingFindMany,
  rentalListingFindMany,
} = vi.hoisted(() => ({
  productFindMany: vi.fn(),
  errandTaskFindMany: vi.fn(),
  serviceListingFindMany: vi.fn(),
  rentalListingFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: {
      findMany: productFindMany,
    },
    errandTask: {
      findMany: errandTaskFindMany,
    },
    serviceListing: {
      findMany: serviceListingFindMany,
    },
    rentalListing: {
      findMany: rentalListingFindMany,
    },
  },
}));

import { getSitemapListings } from "@/repositories/sitemap-repository";

describe("sitemap repository", () => {
  beforeEach(() => {
    productFindMany.mockReset();
    errandTaskFindMany.mockReset();
    serviceListingFindMany.mockReset();
    rentalListingFindMany.mockReset();
  });

  it("returns id and updatedAt entries grouped by listing type", async () => {
    const updatedAt = new Date("2026-08-01T00:00:00.000Z");
    productFindMany.mockResolvedValue([{ id: "product-1", updatedAt }]);
    errandTaskFindMany.mockResolvedValue([{ id: "errand-1", updatedAt }]);
    serviceListingFindMany.mockResolvedValue([{ id: "service-1", updatedAt }]);
    rentalListingFindMany.mockResolvedValue([{ id: "rental-1", updatedAt }]);

    const result = await getSitemapListings();

    expect(result).toEqual({
      products: [{ id: "product-1", updatedAt }],
      errands: [{ id: "errand-1", updatedAt }],
      services: [{ id: "service-1", updatedAt }],
      rentals: [{ id: "rental-1", updatedAt }],
    });
  });

  it("only queries visible listings with a bounded take", async () => {
    productFindMany.mockResolvedValue([]);
    errandTaskFindMany.mockResolvedValue([]);
    serviceListingFindMany.mockResolvedValue([]);
    rentalListingFindMany.mockResolvedValue([]);

    await getSitemapListings();

    expect(productFindMany).toHaveBeenCalledWith({
      where: { deletedAt: null, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
      select: { id: true, updatedAt: true },
      take: 500,
    });
    expect(errandTaskFindMany).toHaveBeenCalledWith({
      where: { deletedAt: null, status: "OPEN" },
      orderBy: { updatedAt: "desc" },
      select: { id: true, updatedAt: true },
      take: 500,
    });
    expect(serviceListingFindMany).toHaveBeenCalledWith({
      where: { deletedAt: null, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
      select: { id: true, updatedAt: true },
      take: 500,
    });
    expect(rentalListingFindMany).toHaveBeenCalledWith({
      where: { deletedAt: null, status: "AVAILABLE" },
      orderBy: { updatedAt: "desc" },
      select: { id: true, updatedAt: true },
      take: 500,
    });
  });
});
