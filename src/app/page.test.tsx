import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { auth, getHomepageData } = vi.hoisted(() => ({
  auth: vi.fn(),
  getHomepageData: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth,
}));

vi.mock("@/repositories/home-repository", () => ({
  getHomepageData,
}));

vi.mock("@/components/site/hero", () => ({
  HeroSection: ({ summary }: { summary: { activeCampusName: string } }) => (
    <div>
      <p>首页摘要 {summary.activeCampusName}</p>
    </div>
  ),
}));

vi.mock("@/components/site/listing-grid", () => ({
  ListingGrid: ({
    title,
    description,
    moreHref,
  }: {
    title: string;
    description: string;
    moreHref: string;
  }) => (
    <section>
      <h2>{title}</h2>
      <p>{description}</p>
      <p>{moreHref}</p>
    </section>
  ),
}));

vi.mock("@/components/site/safety-section", () => ({
  SafetySection: () => <p>安全提示区</p>,
}));

import Home from "@/app/page";

afterEach(() => {
  cleanup();
});

describe("Home", () => {
  it("renders homepage sections using the selected campus", async () => {
    auth.mockResolvedValue({ user: { id: "user-1" } });
    getHomepageData.mockResolvedValue({
      summary: { activeCampusName: "主校区" },
      latestProducts: [],
      trendingProducts: [],
      budgetProducts: [],
      urgentErrands: [],
      highRewardErrands: [],
      verifiedServices: [],
      topServices: [],
    });

    render(
      await Home({
        searchParams: Promise.resolve({ campus: "campus-1" }),
      }),
    );

    expect(screen.getByText("首页摘要 主校区")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "最新二手商品" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "热门商品推荐" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "低价好物" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "紧急跑腿任务" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "高赏金任务" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "认证服务精选" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "高完成度服务" })).toBeTruthy();
    expect(screen.getByText("安全提示区")).toBeTruthy();
  });
});
