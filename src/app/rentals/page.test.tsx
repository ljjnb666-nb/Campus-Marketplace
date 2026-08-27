import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { auth, getRentalListings, getRentalFormMeta, RentalCard, Pagination } = vi.hoisted(() => ({
  auth: vi.fn(),
  getRentalListings: vi.fn(),
  getRentalFormMeta: vi.fn(),
  RentalCard: vi.fn(() => <div data-testid="rental-card" />),
  Pagination: vi.fn(() => <nav data-testid="pagination" />),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/repositories/rental-listing-repository", () => ({
  getRentalListings,
  getRentalFormMeta,
}));
vi.mock("@/components/rental/rental-card", () => ({ RentalCard }));
vi.mock("@/components/site/pagination", () => ({ Pagination }));

import RentalsPage from "@/app/rentals/page";

function buildItem(id: string) {
  return {
    id,
    title: `物品 ${id}`,
    price: { toString: () => "50" },
    pricingUnit: "PER_DAY",
    depositAmount: { toString: () => "100" },
    pickupLocation: "东门",
    status: "AVAILABLE",
    images: [{ url: "/uploads/a.webp" }],
    owner: { name: "出租者", verificationStatus: "VERIFIED" },
    favoriteCount: 3,
    category: { name: "数码" },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RentalsPage", () => {
  it("renders listings with filters and passes query params to the repository", async () => {
    auth.mockResolvedValue({ user: { id: "user-1" } });
    getRentalListings.mockResolvedValue({
      items: [buildItem("r1"), buildItem("r2")],
      total: 2,
      page: 1,
      pageSize: 12,
      totalPages: 1,
    });
    getRentalFormMeta.mockResolvedValue({
      categories: [{ id: "cat-1", name: "数码设备" }],
      campuses: [],
    });

    const page = await RentalsPage({
      searchParams: Promise.resolve({
        q: "相机",
        pricingUnit: "PER_DAY",
        noDeposit: "true",
        sort: "price_asc",
      }),
    });
    render(page);

    expect(getRentalListings).toHaveBeenCalledWith({
      q: "相机",
      categoryId: undefined,
      pricingUnit: "PER_DAY",
      minPrice: undefined,
      maxPrice: undefined,
      noDeposit: true,
      sort: "price_asc",
      page: 1,
    });
    expect(screen.getAllByTestId("rental-card")).toHaveLength(2);
    expect(screen.getByText("共 2 件可租物品")).toBeInTheDocument();
    expect(screen.getByText("发布出租")).toBeInTheDocument();
    expect(screen.getByText("数码设备")).toBeInTheDocument();
    expect(screen.getByText("按天")).toBeInTheDocument();
  });

  it("shows the login prompt for anonymous visitors", async () => {
    auth.mockResolvedValue(null);
    getRentalListings.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 12,
      totalPages: 1,
    });
    getRentalFormMeta.mockResolvedValue({ categories: [], campuses: [] });

    const page = await RentalsPage({ searchParams: Promise.resolve({}) });
    render(page);

    expect(screen.getByText("登录后发布")).toBeInTheDocument();
  });

  it("shows the empty state when no listings match", async () => {
    auth.mockResolvedValue(null);
    getRentalListings.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 12,
      totalPages: 1,
    });
    getRentalFormMeta.mockResolvedValue({ categories: [], campuses: [] });

    const page = await RentalsPage({ searchParams: Promise.resolve({}) });
    render(page);

    expect(screen.getByText("没有找到符合条件的租赁物品")).toBeInTheDocument();
    expect(RentalCard).not.toHaveBeenCalled();
  });

  it("falls back to an empty result when the repository query fails", async () => {
    auth.mockResolvedValue(null);
    getRentalListings.mockRejectedValue(new Error("db down"));
    getRentalFormMeta.mockResolvedValue({ categories: [], campuses: [] });

    const page = await RentalsPage({ searchParams: Promise.resolve({}) });
    render(page);

    expect(screen.getByText("没有找到符合条件的租赁物品")).toBeInTheDocument();
  });
});
