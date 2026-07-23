import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getSearchResults } = vi.hoisted(() => ({
  getSearchResults: vi.fn(),
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

vi.mock("@/repositories/search-repository", () => ({
  getSearchResults,
}));

vi.mock("@/components/product/product-card", () => ({
  ProductCard: ({ title }: { title: string }) => <p>{title}</p>,
}));

vi.mock("@/components/errand/errand-card", () => ({
  ErrandCard: ({ title }: { title: string }) => <p>{title}</p>,
}));

vi.mock("@/components/service/service-card", () => ({
  ServiceCard: ({ title }: { title: string }) => <p>{title}</p>,
}));

import SearchPage from "@/app/search/page";

afterEach(() => {
  cleanup();
});

describe("SearchPage", () => {
  it("renders the idle state without a keyword", async () => {
    render(
      await SearchPage({
        searchParams: Promise.resolve({}),
      }),
    );

    expect(screen.getByRole("heading", { name: "全站搜索" })).toBeTruthy();
    expect(screen.getByText("先输入关键词，再查看搜索结果。")).toBeTruthy();
  });

  it("renders empty results for a keyword", async () => {
    getSearchResults.mockResolvedValue({
      products: [],
      errands: [],
      services: [],
      users: [],
    });

    render(
      await SearchPage({
        searchParams: Promise.resolve({ q: "考研" }),
      }),
    );

    expect(screen.getByText("关键词“考研”共找到 0 条结果。")).toBeTruthy();
    expect(screen.getByText("没有找到相关内容，可以换一个关键词再试。")).toBeTruthy();
  });

  it("renders all search sections when results exist", async () => {
    getSearchResults.mockResolvedValue({
      products: [
        {
          id: "product-1",
          title: "自行车",
          description: "九成新。",
          price: 200,
          status: "ACTIVE",
          category: { name: "交通工具" },
          seller: { name: "张同学" },
          images: [],
          favoriteCount: 2,
        },
      ],
      errands: [
        {
          id: "errand-1",
          title: "代取快递",
          reward: 5,
          pickupLocation: "快递站",
          deliveryLocation: "宿舍",
          publisher: { name: "李同学" },
          status: "OPEN",
        },
      ],
      services: [
        {
          id: "service-1",
          title: "PPT 美化",
          description: "答辩优化",
          price: 88,
          pricingUnit: "PER_ORDER",
          status: "ACTIVE",
          provider: { name: "王同学" },
          locationText: "线上",
          coverImageUrl: null,
          completedOrderCount: 3,
        },
      ],
      users: [
        {
          id: "user-1",
          name: "赵同学",
          schoolName: "示例大学",
          campus: { name: "主校区" },
          positiveReviewRate: 0.96,
          bio: null,
          visibleCounts: {
            products: 2,
            createdErrandTasks: 1,
            serviceListings: 4,
          },
        },
      ],
    });

    render(
      await SearchPage({
        searchParams: Promise.resolve({ q: "PPT" }),
      }),
    );

    expect(screen.getByText("关键词“PPT”共找到 4 条结果。")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "二手商品" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "校园跑腿" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "技能服务" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "校园用户" })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "查看更多" })).toHaveLength(3);
    expect(screen.getByText("赵同学")).toBeTruthy();
    expect(screen.getByText("这个同学还没有填写个人简介。")).toBeTruthy();
    expect(screen.getByText("96% 好评")).toBeTruthy();
  });
});
