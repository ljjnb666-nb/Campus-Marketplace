import { beforeEach, describe, expect, it, vi } from "vitest";

const { revalidatePath } = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath }));

import {
  revalidateErrandViews,
  revalidateOrderViews,
  revalidateProductViews,
  revalidateRentalOrderCreationViews,
  revalidateRentalOrderListViews,
  revalidateRentalOrderViews,
  revalidateServiceViews,
} from "@/lib/revalidate";

function paths() {
  return revalidatePath.mock.calls.map((call) => call[0]);
}

describe("revalidateOrderViews", () => {
  beforeEach(() => revalidatePath.mockReset());

  it("revalidates common order pages plus detail pages", () => {
    revalidateOrderViews({ productId: "p1", serviceId: "s1", errandId: "e1" });

    expect(paths()).toEqual([
      "/my/orders",
      "/products",
      "/services",
      "/errands",
      "/notifications",
      "/products/p1",
      "/services/s1",
      "/errands/e1",
    ]);
  });

  it("skips detail pages when ids are absent", () => {
    revalidateOrderViews({});

    expect(paths()).toEqual([
      "/my/orders",
      "/products",
      "/services",
      "/errands",
      "/notifications",
    ]);
  });
});

describe("revalidateErrandViews", () => {
  beforeEach(() => revalidatePath.mockReset());

  it("includes errand detail and edit pages when id provided", () => {
    revalidateErrandViews("e1");

    expect(paths()).toEqual([
      "/",
      "/errands",
      "/my/errands",
      "/my/orders",
      "/notifications",
      "/errands/e1",
      "/errands/e1/edit",
    ]);
  });

  it("only revalidates list pages without an id", () => {
    revalidateErrandViews();

    expect(paths()).toEqual(["/", "/errands", "/my/errands", "/my/orders", "/notifications"]);
  });
});

describe("revalidateProductViews", () => {
  beforeEach(() => revalidatePath.mockReset());

  it("revalidates product pages including favorites", () => {
    revalidateProductViews("p1");

    expect(paths()).toEqual([
      "/",
      "/products",
      "/my/products",
      "/my/favorites",
      "/products/p1",
      "/products/p1/edit",
    ]);
  });
});

describe("revalidateServiceViews", () => {
  beforeEach(() => revalidatePath.mockReset());

  it("revalidates service pages", () => {
    revalidateServiceViews("s1");

    expect(paths()).toEqual([
      "/",
      "/services",
      "/my/services",
      "/services/s1",
      "/services/s1/edit",
    ]);
  });
});

describe("rental order revalidation helpers", () => {
  beforeEach(() => revalidatePath.mockReset());

  it("revalidateRentalOrderViews targets the order detail page", () => {
    revalidateRentalOrderViews("o1");

    expect(paths()).toEqual(["/rental-orders/o1"]);
  });

  it("revalidateRentalOrderListViews targets the order list page", () => {
    revalidateRentalOrderListViews();

    expect(paths()).toEqual(["/rental-orders"]);
  });

  it("revalidateRentalOrderCreationViews refreshes market and role lists", () => {
    revalidateRentalOrderCreationViews();

    expect(paths()).toEqual(["/rentals", "/my/owner-orders", "/my/rental-orders"]);
  });
});
