import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, getRentalOrderDetail, RentalExtensionForm, notFound } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getRentalOrderDetail: vi.fn(),
  RentalExtensionForm: vi.fn(() => <div data-testid="extension-form" />),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/lib/server-auth", () => ({ requireUser }));
vi.mock("@/repositories/rental-order-repository", () => ({ getRentalOrderDetail }));
vi.mock("./extension-form", () => ({ RentalExtensionForm }));
vi.mock("next/navigation", () => ({
  notFound,
  redirect: vi.fn((location: string) => {
    throw new Error(`REDIRECT:${location}`);
  }),
}));

import ExtendRentalOrderPage from "@/app/rental-orders/[id]/extend/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function buildOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    renterId: "user-1",
    status: "IN_RENTAL",
    endTime: new Date("2026-08-21T10:00:00.000Z"),
    rentalListing: { price: 30, pricingUnit: "PER_DAY" },
    ...overrides,
  };
}

describe("ExtendRentalOrderPage", () => {
  it("renders the extension form for the in-rental renter", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder());

    render(await ExtendRentalOrderPage({ params: Promise.resolve({ id: "order-1" }) }));

    expect(screen.getByText("申请续租")).toBeInTheDocument();
    expect(RentalExtensionForm).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order-1",
        price: 30,
        pricingUnit: "PER_DAY",
        currentEndTime: "2026-08-21T10:00:00.000Z",
      }),
      undefined,
    );
  });

  it("renders notFound for missing orders or non-renter visitors", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getRentalOrderDetail.mockResolvedValue(null);

    await expect(
      ExtendRentalOrderPage({ params: Promise.resolve({ id: "order-1" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    getRentalOrderDetail.mockResolvedValue(buildOrder({ renterId: "user-2" }));
    await expect(
      ExtendRentalOrderPage({ params: Promise.resolve({ id: "order-1" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("redirects when the order is not currently in rental", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getRentalOrderDetail.mockResolvedValue(buildOrder({ status: "COMPLETED" }));

    await expect(
      ExtendRentalOrderPage({ params: Promise.resolve({ id: "order-1" }) }),
    ).rejects.toThrow("REDIRECT:/rental-orders/order-1");
  });
});
