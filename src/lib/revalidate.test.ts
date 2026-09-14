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
  revalidateListingModerationViews,
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

describe("revalidateListingModerationViews（Phase 7C）", () => {
  beforeEach(() => {
    revalidatePath.mockClear();
  });

  it("PRODUCT：域 helper 扇出 + search/sitemap/governance 面", () => {
    revalidateListingModerationViews("PRODUCT", "product-1");
    const called = paths();
    for (const expected of [
      "/search",
      "/sitemap.xml",
      "/governance/listings",
      "/governance/listings/product/product-1",
      "/",
      "/products",
      "/my/products",
      "/my/favorites",
      "/products/product-1",
      "/products/product-1/edit",
    ]) {
      expect(called).toContain(expected);
    }
  });

  it("SERVICE：域 helper 扇出", () => {
    revalidateListingModerationViews("SERVICE", "service-1");
    const called = paths();
    for (const expected of ["/services", "/my/services", "/services/service-1"]) {
      expect(called).toContain(expected);
    }
  });

  it("ERRAND：域 helper 扇出", () => {
    revalidateListingModerationViews("ERRAND", "errand-1");
    const called = paths();
    for (const expected of ["/errands", "/my/errands", "/errands/errand-1"]) {
      expect(called).toContain(expected);
    }
  });

  it("RENTAL：独立扇出形态（repo 既有惯例，不走域 helper）", () => {
    revalidateListingModerationViews("RENTAL", "rental-1");
    const called = paths();
    for (const expected of [
      "/rentals",
      "/my/rental-listings",
      "/rentals/rental-1",
      "/rentals/rental-1/edit",
    ]) {
      expect(called).toContain(expected);
    }
  });
});
