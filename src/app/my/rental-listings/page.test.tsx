import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, getMyRentalListings, RentalListingStatusBadge } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getMyRentalListings: vi.fn(),
  RentalListingStatusBadge: vi.fn(({ status }: { status: string }) => (
    <span data-testid="status-badge">{status}</span>
  )),
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

vi.mock("next/image", () => ({
  default: (props: { src: string; alt: string }) => (
    <img data-testid="listing-image" alt={props.alt} src={props.src} />
  ),
}));

vi.mock("@/lib/server-auth", () => ({ requireUser }));
vi.mock("@/repositories/rental-listing-repository", () => ({ getMyRentalListings }));
vi.mock("@/components/rental/rental-status-badge", () => ({
  RentalListingStatusBadge,
}));
vi.mock("@/actions/rental-listing", () => ({
  updateRentalListingStatus: vi.fn(),
}));

import MyRentalListingsPage from "@/app/my/rental-listings/page";

function buildListing(overrides: Record<string, unknown> = {}) {
  return {
    id: "listing-1",
    title: "佳能相机",
    price: { toString: () => "50" },
    status: "AVAILABLE",
    depositAmount: { toString: () => "100" },
    images: [{ url: "/uploads/camera.webp" }],
    pricingUnit: "PER_DAY",
    availableQuantity: 1,
    totalQuantity: 2,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MyRentalListingsPage", () => {
  it("lists the owner's listings with quantity and management actions", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getMyRentalListings.mockResolvedValue([buildListing()]);

    render(await MyRentalListingsPage());

    expect(requireUser).toHaveBeenCalledWith();
    expect(screen.getByText("佳能相机")).toBeInTheDocument();
    expect(screen.getByText("库存: 1/2")).toBeInTheDocument();
    expect(screen.getByText("¥50.00")).toBeInTheDocument();
    expect(screen.getByText("暂停")).toBeInTheDocument();
    expect(screen.getByText("下架")).toBeInTheDocument();
    expect(screen.getByText("编辑")).toBeInTheDocument();
  });

  it("shows the resume action for paused listings", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getMyRentalListings.mockResolvedValue([buildListing({ status: "PAUSED" })]);

    render(await MyRentalListingsPage());

    expect(screen.getByText("恢复")).toBeInTheDocument();
    expect(screen.queryByText("暂停")).not.toBeInTheDocument();
  });

  it("shows the relist action for offline listings", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getMyRentalListings.mockResolvedValue([buildListing({ status: "OFFLINE" })]);

    render(await MyRentalListingsPage());

    expect(screen.getByText("重新上架")).toBeInTheDocument();
  });

  it("renders an image placeholder when a listing has no cover", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getMyRentalListings.mockResolvedValue([buildListing({ images: [] })]);

    render(await MyRentalListingsPage());

    expect(screen.queryByTestId("listing-image")).not.toBeInTheDocument();
    expect(screen.getByText("无图")).toBeInTheDocument();
  });

  it("shows an empty hint when the owner has no listings", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getMyRentalListings.mockResolvedValue([]);

    render(await MyRentalListingsPage());

    expect(
      screen.getByText("您还没有发布过租赁物品，赶快发布一个试试吧。"),
    ).toBeInTheDocument();
  });
});
