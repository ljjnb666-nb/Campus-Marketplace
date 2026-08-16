import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, getRentalOrderDetail, RentalOrderActions } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getRentalOrderDetail: vi.fn(),
  RentalOrderActions: vi.fn(() => <div data-testid="rental-order-actions" />),
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

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/repositories/rental-order-repository", () => ({
  getRentalOrderDetail,
}));

vi.mock("@/components/rental/rental-order-actions", () => ({
  RentalOrderActions,
}));

import RentalOrderDetailPage from "@/app/rental-orders/[id]/page";

function buildOrder(overrides: Record<string, unknown> = {}) {
  const userSummary = {
    id: "user-1",
    name: "赵同学",
    avatarUrl: null,
    schoolName: "示例大学",
    completedOrdersCount: 3,
    positiveReviewRate: 1,
    verificationStatus: "VERIFIED",
    createdAt: new Date("2026-01-05T08:00:00.000Z"),
  };

  return {
    id: "order-1",
    orderNumber: "RT202608170001",
    ownerId: "owner-1",
    renterId: "renter-1",
    status: "PENDING_INSPECTION",
    createdAt: new Date("2026-08-10T08:00:00.000Z"),
    startTime: new Date("2026-08-12T08:00:00.000Z"),
    endTime: new Date("2026-08-16T08:00:00.000Z"),
    completedAt: null,
    depositAmount: "500.00",
    depositStatus: "PENDING_REFUND",
    overdueFee: "0",
    depositDeduction: "0",
    rentalAmount: "120.00",
    finalAmount: "620.00",
    unitPriceSnapshot: "30.00",
    pricingUnitSnapshot: "PER_DAY",
    rentalListingId: "rental-1",
    rentalListing: {
      title: "索尼单反相机",
      pickupLocation: "实验楼二楼",
      returnLocation: "实验楼二楼",
      images: [{ url: "/camera.jpg" }],
    },
    owner: { ...userSummary, id: "owner-1" },
    renter: { ...userSummary, id: "renter-1" },
    handoverRecord: null,
    returnRecord: null,
    damageClaims: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RentalOrderDetailPage", () => {
  it("将未决损坏索赔与租客角色透传给订单操作台", async () => {
    requireUser.mockResolvedValue({ id: "renter-1" });
    getRentalOrderDetail.mockResolvedValue(
      buildOrder({
        damageClaims: [
          {
            id: "claim-resolved",
            resolvedAt: new Date("2026-08-15T08:00:00.000Z"),
            damageDescription: "已处理的旧索赔",
            requestedDeduction: "50",
          },
          {
            id: "claim-pending",
            resolvedAt: null,
            damageDescription: "屏幕碎裂，需要维修",
            requestedDeduction: "200.5",
          },
        ],
      }),
    );

    render(await RentalOrderDetailPage({ params: Promise.resolve({ id: "order-1" }) }));

    expect(screen.getByText("租赁订单详情")).toBeTruthy();
    expect(RentalOrderActions).toHaveBeenCalledTimes(1);
    expect(RentalOrderActions).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order-1",
        status: "PENDING_INSPECTION",
        userRole: "renter",
        pendingClaim: {
          id: "claim-pending",
          damageDescription: "屏幕碎裂，需要维修",
          requestedDeduction: 200.5,
        },
      }),
      undefined,
    );
  });

  it("所有索赔均已决时透传 pendingClaim 为 null", async () => {
    requireUser.mockResolvedValue({ id: "renter-1" });
    getRentalOrderDetail.mockResolvedValue(
      buildOrder({
        damageClaims: [
          {
            id: "claim-resolved",
            resolvedAt: new Date("2026-08-15T08:00:00.000Z"),
            damageDescription: "已处理的旧索赔",
            requestedDeduction: "50",
          },
        ],
      }),
    );

    render(await RentalOrderDetailPage({ params: Promise.resolve({ id: "order-1" }) }));

    expect(RentalOrderActions).toHaveBeenCalledWith(
      expect.objectContaining({
        userRole: "renter",
        pendingClaim: null,
      }),
      undefined,
    );
  });

  it("出租者访问时透传 owner 角色", async () => {
    requireUser.mockResolvedValue({ id: "owner-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder());

    render(await RentalOrderDetailPage({ params: Promise.resolve({ id: "order-1" }) }));

    expect(RentalOrderActions).toHaveBeenCalledWith(
      expect.objectContaining({
        userRole: "owner",
        pendingClaim: null,
      }),
      undefined,
    );
  });
});
