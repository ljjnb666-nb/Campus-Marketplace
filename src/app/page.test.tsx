import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/home-sections/hero-summary", () => ({
  HomeHeroSummary: ({ campusId }: { campusId?: string }) => (
    <p>首页摘要区 {campusId ?? "全部校区"}</p>
  ),
}));

vi.mock("@/app/home-sections/product-listings", () => ({
  HomeProductListings: ({ campusId }: { campusId?: string }) => (
    <p>商品分区 {campusId ?? "全部校区"}</p>
  ),
}));

vi.mock("@/app/home-sections/errand-listings", () => ({
  HomeErrandListings: ({ campusId }: { campusId?: string }) => (
    <p>跑腿分区 {campusId ?? "全部校区"}</p>
  ),
}));

vi.mock("@/app/home-sections/service-listings", () => ({
  HomeServiceListings: ({ campusId }: { campusId?: string }) => (
    <p>服务分区 {campusId ?? "全部校区"}</p>
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
  it("renders the streamed sections in order with the selected campus", async () => {
    render(
      await Home({
        searchParams: Promise.resolve({ campus: "campus-1" }),
      }),
    );

    const sections = [
      "首页摘要区 campus-1",
      "商品分区 campus-1",
      "跑腿分区 campus-1",
      "服务分区 campus-1",
      "安全提示区",
    ];
    // 保持原有输出顺序:摘要 → 商品 → 跑腿 → 服务 → 安全提示。
    for (let i = 0; i < sections.length - 1; i++) {
      const current = screen.getByText(sections[i]);
      const next = screen.getByText(sections[i + 1]);
      expect(
        Boolean(current.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING),
      ).toBe(true);
    }
  });

  it("passes an empty campus through when no campus is selected", async () => {
    render(await Home({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("首页摘要区 全部校区")).toBeTruthy();
    expect(screen.getByText("商品分区 全部校区")).toBeTruthy();
    expect(screen.getByText("跑腿分区 全部校区")).toBeTruthy();
    expect(screen.getByText("服务分区 全部校区")).toBeTruthy();
  });
});
