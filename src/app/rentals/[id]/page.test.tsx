import { describe, expect, it, vi } from "vitest";

const { auth, getRentalListingDetail } = vi.hoisted(() => ({
  auth: vi.fn(),
  getRentalListingDetail: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth,
}));

vi.mock("@/repositories/rental-listing-repository", () => ({
  getRentalListingDetail,
}));

import { generateMetadata } from "@/app/rentals/[id]/page";

function buildRentalListingDetail() {
  return {
    listing: {
      id: "rental-1",
      ownerId: "owner-1",
      title: "折叠自行车短租",
      description: "周末短租，车况良好。",
      price: 15,
      depositAmount: 100,
      referenceValue: null,
      condition: "NORMAL_USED",
      brand: null,
      model: null,
      pickupLocation: "北门车棚",
      returnLocation: "北门车棚",
      usageRules: null,
      damagePolicy: null,
      overduePolicy: null,
      status: "AVAILABLE",
      categoryId: "category-1",
      category: { name: "交通工具" },
      campusId: "campus-1",
      campus: { schoolName: "示例大学", name: "主校区" },
      images: [],
      owner: {
        id: "owner-1",
        name: "赵同学",
        verificationStatus: "VERIFIED",
        rentalOwnerCount: 3,
        rentalPositiveRate: 1,
        createdAt: new Date("2026-01-05T08:00:00.000Z"),
      },
    },
    reviews: [],
    isFavorited: false,
  };
}

describe("RentalDetailPage generateMetadata", () => {
  it("returns SEO metadata from the rental listing detail", async () => {
    getRentalListingDetail.mockResolvedValue(buildRentalListingDetail());

    const metadata = await generateMetadata({
      params: Promise.resolve({ id: "rental-1" }),
    });

    expect(metadata.title).toBe("折叠自行车短租 - 校园集市");
    expect(metadata.description).toBe("周末短租，车况良好。");
    expect(metadata.openGraph?.title).toBe("折叠自行车短租 - 校园集市");
  });

  it("falls back to generic metadata when the listing is missing", async () => {
    getRentalListingDetail.mockRejectedValue(new Error("notFound"));

    const metadata = await generateMetadata({
      params: Promise.resolve({ id: "missing-rental" }),
    });

    expect(metadata.title).toBe("租赁物品详情 - 校园集市");
  });
});
