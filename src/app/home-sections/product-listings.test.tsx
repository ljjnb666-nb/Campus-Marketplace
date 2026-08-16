import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getHomepageProducts } = vi.hoisted(() => ({
  getHomepageProducts: vi.fn(),
}));

vi.mock("@/repositories/home-repository", () => ({
  getHomepageProducts,
}));

vi.mock("@/components/site/listing-grid", () => ({
  ListingGrid: ({
    title,
    items,
    moreHref,
  }: {
    title: string;
    items: { id: string; title: string }[];
    moreHref?: string;
  }) => (
    <section>
      <h2>{title}</h2>
      <p>{moreHref}</p>
      <ul>
        {items.map((item) => (
          <li key={item.id}>{item.title}</li>
        ))}
      </ul>
    </section>
  ),
}));

import { HomeProductListings } from "@/app/home-sections/product-listings";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HomeProductListings", () => {
  it("renders the three product grids from repository data", async () => {
    getHomepageProducts.mockResolvedValue({
      latestProducts: [{ id: "product-1", title: "高数教材" }],
      trendingProducts: [{ id: "product-2", title: "宿舍小风扇" }],
      budgetProducts: [{ id: "product-3", title: "二手耳机" }],
    });

    render(await HomeProductListings({ campusId: "campus-1" }));

    expect(getHomepageProducts).toHaveBeenCalledWith({ campusId: "campus-1" });
    expect(
      screen.getByRole("heading", { name: "最新二手商品" }),
    ).toBeTruthy();
    expect(screen.getByText("/products?sort=latest")).toBeTruthy();
    expect(screen.getByText("高数教材")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "热门商品推荐" }),
    ).toBeTruthy();
    expect(screen.getByText("/products?sort=popular")).toBeTruthy();
    expect(screen.getByText("宿舍小风扇")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "低价好物" })).toBeTruthy();
    expect(screen.getByText("/products?sort=price_asc")).toBeTruthy();
    expect(screen.getByText("二手耳机")).toBeTruthy();
  });
});
