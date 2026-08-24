import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  notFound,
  rentalListingFindMany,
  rentalListingCount,
  rentalListingFindFirst,
  rentalListingUpdate,
  rentalReviewFindMany,
  rentalFavoriteFindUnique,
  rentalCategoryFindMany,
  campusFindMany,
} = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  rentalListingFindMany: vi.fn(),
  rentalListingCount: vi.fn(),
  rentalListingFindFirst: vi.fn(),
  rentalListingUpdate: vi.fn(),
  rentalReviewFindMany: vi.fn(),
  rentalFavoriteFindUnique: vi.fn(),
  rentalCategoryFindMany: vi.fn(),
  campusFindMany: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    rentalListing: {
      findMany: rentalListingFindMany,
      count: rentalListingCount,
      findFirst: rentalListingFindFirst,
      update: rentalListingUpdate,
    },
    rentalReview: { findMany: rentalReviewFindMany },
    rentalFavorite: { findUnique: rentalFavoriteFindUnique },
    rentalCategory: { findMany: rentalCategoryFindMany },
    campus: { findMany: campusFindMany },
  },
}));

import {
  getRentalFormMeta,
  getRentalListingDetail,
  getRentalListingForEdit,
  getRentalListings,
  getMyRentalListings,
} from "@/repositories/rental-listing-repository";

const sampleListing = {
  id: "listing-1",
  title: "相机",
  ownerId: "owner-1",
  images: [{ url: "/uploads/a.webp" }],
};

describe("getRentalListings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rentalListingFindMany.mockResolvedValue([sampleListing]);
    rentalListingCount.mockResolvedValue(0);
  });

  it("queries only available non-deleted listings with default sorting", async () => {
    await getRentalListings();

    const args = rentalListingFindMany.mock.calls[0][0];
    expect(args.where).toEqual({ deletedAt: null, status: "AVAILABLE" });
    expect(args.orderBy).toEqual({ createdAt: "desc" });
    expect(args.take).toBe(12);
    expect(args.skip).toBe(0);
  });

  it("applies search, category, campus and pricing unit filters", async () => {
    await getRentalListings({
      q: "相机",
      categoryId: "cat-1",
      campusId: "campus-1",
      pricingUnit: "PER_DAY",
    });

    const { where } = rentalListingFindMany.mock.calls[0][0];
    expect(where.categoryId).toBe("cat-1");
    expect(where.campusId).toBe("campus-1");
    expect(where.pricingUnit).toBe("PER_DAY");
    expect(where.OR).toHaveLength(2);
  });

  it("applies price range and deposit filters", async () => {
    await getRentalListings({ minPrice: "10", maxPrice: "99", noDeposit: true });

    const { where } = rentalListingFindMany.mock.calls[0][0];
    expect(where.price.gte.toString()).toBe("10");
    expect(where.price.lte.toString()).toBe("99");
    expect(where.depositAmount).toEqual({ equals: expect.objectContaining({}) });
  });

  it("filters to verified owners when requested", async () => {
    await getRentalListings({ verifiedOwnerOnly: true });

    const { where } = rentalListingFindMany.mock.calls[0][0];
    expect(where.owner).toEqual({ verificationStatus: "VERIFIED" });
  });

  it("sorts by price ascending when requested", async () => {
    await getRentalListings({ sort: "price_asc" });

    expect(rentalListingFindMany.mock.calls[0][0].orderBy).toEqual([
      { price: "asc" },
      { createdAt: "desc" },
    ]);
  });

  it("paginates and computes totalPages", async () => {
    rentalListingCount.mockResolvedValue(25);

    const result = await getRentalListings({ page: 2 });

    expect(rentalListingFindMany.mock.calls[0][0].skip).toBe(12);
    expect(result.total).toBe(25);
    expect(result.totalPages).toBe(3);
    expect(result.page).toBe(2);
  });

  it("clamps page to 1 minimum", async () => {
    await getRentalListings({ page: 0 });

    expect(rentalListingFindMany.mock.calls[0][0].skip).toBe(0);
  });

  it("reports at least one page even with zero results", async () => {
    rentalListingCount.mockResolvedValue(0);

    const result = await getRentalListings();

    expect(result.totalPages).toBe(1);
  });
});

describe("getRentalListingDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rentalListingFindFirst.mockResolvedValue(sampleListing);
    rentalReviewFindMany.mockResolvedValue([]);
    rentalFavoriteFindUnique.mockResolvedValue({ id: "fav-1" });
    rentalListingUpdate.mockResolvedValue({});
  });

  it("increments view count by default", async () => {
    await getRentalListingDetail("listing-1");

    expect(rentalListingUpdate).toHaveBeenCalledWith({
      where: { id: "listing-1" },
      data: { viewCount: { increment: 1 } },
    });
  });

  it("skips view increment for read-only callers", async () => {
    await getRentalListingDetail("listing-1", undefined, { countView: false });

    expect(rentalListingUpdate).not.toHaveBeenCalled();
  });

  it("returns isFavorited=false for anonymous users", async () => {
    const result = await getRentalListingDetail("listing-1");

    expect(result.isFavorited).toBe(false);
    expect(rentalFavoriteFindUnique).not.toHaveBeenCalled();
  });

  it("checks favorite status for signed-in users and loads reviews", async () => {
    const result = await getRentalListingDetail("listing-1", "user-1");

    expect(rentalFavoriteFindUnique).toHaveBeenCalledWith({
      where: {
        userId_rentalListingId: { userId: "user-1", rentalListingId: "listing-1" },
      },
      select: { id: true },
    });
    expect(result.isFavorited).toBe(true);
    expect(rentalReviewFindMany).toHaveBeenCalledTimes(1);
  });

  it("throws notFound for missing or deleted listings", async () => {
    rentalListingFindFirst.mockResolvedValue(null);

    await expect(getRentalListingDetail("missing")).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("getRentalListingForEdit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the listing scoped to its owner", async () => {
    rentalListingFindFirst.mockResolvedValue(sampleListing);

    const listing = await getRentalListingForEdit("listing-1", "owner-1");

    expect(listing).toEqual(sampleListing);
    expect(rentalListingFindFirst.mock.calls[0][0].where).toEqual({
      id: "listing-1",
      ownerId: "owner-1",
      deletedAt: null,
    });
  });

  it("throws notFound for listings owned by someone else", async () => {
    rentalListingFindFirst.mockResolvedValue(null);

    await expect(getRentalListingForEdit("listing-1", "owner-2")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });
});

describe("getMyRentalListings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists non-deleted listings owned by the user", async () => {
    rentalListingFindMany.mockResolvedValue([sampleListing]);

    const items = await getMyRentalListings("owner-1");

    expect(items).toEqual([sampleListing]);
    const args = rentalListingFindMany.mock.calls[0][0];
    expect(args.where).toEqual({ ownerId: "owner-1", deletedAt: null });
    expect(args.orderBy).toEqual({ createdAt: "desc" });
  });
});

describe("getRentalFormMeta", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads active categories and campuses in parallel", async () => {
    rentalCategoryFindMany.mockResolvedValue([{ id: "cat-1" }]);
    campusFindMany.mockResolvedValue([{ id: "campus-1" }]);

    const meta = await getRentalFormMeta();

    expect(meta).toEqual({
      categories: [{ id: "cat-1" }],
      campuses: [{ id: "campus-1" }],
    });
    expect(rentalCategoryFindMany.mock.calls[0][0].where).toEqual({ isActive: true });
    expect(campusFindMany.mock.calls[0][0].where).toEqual({ isActive: true });
  });
});
