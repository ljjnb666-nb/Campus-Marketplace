import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getHomepageServices } = vi.hoisted(() => ({
  getHomepageServices: vi.fn(),
}));

vi.mock("@/repositories/home-repository", () => ({
  getHomepageServices,
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

import { HomeServiceListings } from "@/app/home-sections/service-listings";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HomeServiceListings", () => {
  it("renders the two service grids from repository data", async () => {
    getHomepageServices.mockResolvedValue({
      verifiedServices: [{ id: "service-1", title: "高数辅导" }],
      topServices: [{ id: "service-2", title: "PPT排版" }],
    });

    render(await HomeServiceListings({ campusId: "campus-1" }));

    expect(getHomepageServices).toHaveBeenCalledWith({ campusId: "campus-1" });
    expect(
      screen.getByRole("heading", { name: "认证服务精选" }),
    ).toBeTruthy();
    expect(
      screen.getByText("/services?verifiedOnly=true&sort=orders_desc"),
    ).toBeTruthy();
    expect(screen.getByText("高数辅导")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "高完成度服务" }),
    ).toBeTruthy();
    expect(screen.getByText("/services?sort=orders_desc")).toBeTruthy();
    expect(screen.getByText("PPT排版")).toBeTruthy();
  });
});
