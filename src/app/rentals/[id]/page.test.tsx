import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { auth, getRentalListingDetail, RentalDetailConsole, notFound } = vi.hoisted(() => ({
  auth: vi.fn(),
  getRentalListingDetail: vi.fn(),
  RentalDetailConsole: vi.fn(() => <div data-testid="rental-detail-console" />),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/lib/auth", () => ({
  auth,
}));

vi.mock("@/repositories/rental-listing-repository", () => ({
  getRentalListingDetail,
}));

vi.mock("@/components/rental/rental-detail-console", () => ({
  RentalDetailConsole,
}));

vi.mock("next/navigation", () => ({
  notFound,
  redirect: vi.fn(),
}));

import RentalDetailPage, { generateMetadata } from "@/app/rentals/[id]/page";

function buildRentalListingDetail(overrides: Record<string, unknown> = {}) {
  return {
    listing: {
      id: "rental-1",
      ownerId: "owner-1",
      title: "折叠自行车短租",
      description: "周末短租，车况良好。",
      price: { toString: () => "15" },
      depositAmount: { toString: () => "100" },
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
      ...overrides,
    },
    reviews: [],
    isFavorited: false,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RentalDetailPage generateMetadata", () => {
  it("returns SEO metadata from the rental listing detail", async () => {
    getRentalListingDetail.mockResolvedValue(buildRentalListingDetail());

    const metadata = await generateMetadata({
      params: Promise.resolve({ id: "rental-1" }),
    });

    expect(metadata.title).toBe("折叠自行车短租 - 校园集市");
    expect(metadata.description).toBe("周末短租，车况良好。");
    expect(metadata.openGraph?.title).toBe("折叠自行车短租 - 校园集市");
    expect(getRentalListingDetail).toHaveBeenCalledWith(
      "rental-1",
      undefined,
      { countView: false },
    );
  });

  it("falls back to generic metadata when the listing is missing", async () => {
    getRentalListingDetail.mockRejectedValue(new Error("notFound"));

    const metadata = await generateMetadata({
      params: Promise.resolve({ id: "missing-rental" }),
    });

    expect(metadata.title).toBe("租赁物品详情 - 校园集市");
  });
});

describe("RentalDetailPage 渲染", () => {
  it("renders condition, locations, policies and reviews", async () => {
    auth.mockResolvedValue({ user: { id: "user-1" } });
    getRentalListingDetail.mockResolvedValue(
      buildRentalListingDetail({
        brand: "捷安特",
        referenceValue: 800,
        usageRules: "仅限校内骑行",
        damagePolicy: "车架损坏赔偿 200",
        overduePolicy: "逾期每日加收 5 元",
      }),
    );

    render(await RentalDetailPage({ params: Promise.resolve({ id: "rental-1" }) }));

    expect(screen.getByText("成色：9成新")).toBeInTheDocument();
    expect(screen.getByText("品牌：捷安特")).toBeInTheDocument();
    expect(screen.getByText("参考原价：¥800.00")).toBeInTheDocument();
    expect(screen.getByText("取货：北门车棚")).toBeInTheDocument();
    expect(screen.getByText("归还：北门车棚")).toBeInTheDocument();
    expect(screen.getByText("仅限校内骑行")).toBeInTheDocument();
    expect(screen.getByText("车架损坏赔偿 200")).toBeInTheDocument();
    expect(screen.getByText("逾期每日加收 5 元")).toBeInTheDocument();
    expect(screen.getByTestId("rental-detail-console")).toBeInTheDocument();
    expect(RentalDetailConsole).toHaveBeenCalledWith(
      expect.objectContaining({ isOwner: false, isLoggedIn: true }),
      undefined,
    );
  });

  it("falls back to default usage rules and hides optional blocks", async () => {
    auth.mockResolvedValue(null);
    getRentalListingDetail.mockResolvedValue(buildRentalListingDetail());

    render(await RentalDetailPage({ params: Promise.resolve({ id: "rental-1" }) }));

    expect(screen.queryByText(/品牌：/)).not.toBeInTheDocument();
    expect(screen.queryByText(/损坏赔偿政策/)).not.toBeInTheDocument();
    expect(screen.queryByText(/租客评价/)).not.toBeInTheDocument();
    expect(screen.getByText("请爱惜同校同学物品，按约定用途合规使用。")).toBeInTheDocument();
    expect(RentalDetailConsole).toHaveBeenCalledWith(
      expect.objectContaining({ isOwner: false, isLoggedIn: false }),
      undefined,
    );
  });

  it("marks the owner view and forwards favorite state", async () => {
    auth.mockResolvedValue({ user: { id: "owner-1" } });
    getRentalListingDetail.mockResolvedValue({
      ...buildRentalListingDetail(),
      isFavorited: true,
    });

    render(await RentalDetailPage({ params: Promise.resolve({ id: "rental-1" }) }));

    expect(RentalDetailConsole).toHaveBeenCalledWith(
      expect.objectContaining({ isOwner: true, isFavorited: true }),
      undefined,
    );
  });

  it("renders notFound when the listing is missing", async () => {
    auth.mockResolvedValue(null);
    getRentalListingDetail.mockResolvedValue(null);

    await expect(
      RentalDetailPage({ params: Promise.resolve({ id: "missing" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("lists reviews with author and rating", async () => {
    auth.mockResolvedValue(null);
    getRentalListingDetail.mockResolvedValue({
      ...buildRentalListingDetail(),
      reviews: [
        { id: "rev-1", author: { name: "钱同学" }, overallRating: 4, content: "骑起来很顺" },
      ],
    });

    render(await RentalDetailPage({ params: Promise.resolve({ id: "rental-1" }) }));

    expect(screen.getByText("租客评价 (1)")).toBeInTheDocument();
    expect(screen.getByText("钱同学")).toBeInTheDocument();
    expect(screen.getByText("★ 4 分")).toBeInTheDocument();
    expect(screen.getByText("骑起来很顺")).toBeInTheDocument();
  });
});
