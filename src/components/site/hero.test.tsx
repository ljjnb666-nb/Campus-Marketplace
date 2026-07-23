import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HeroSection } from "@/components/site/hero";

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

describe("HeroSection", () => {
  it("renders homepage search, campus filter, and publish entry links", () => {
    const { container } = render(
      <HeroSection
        summary={{
          productCount: 12,
          errandCount: 4,
          serviceCount: 7,
          campuses: [
            { id: "campus-1", name: "主校区", schoolName: "示例大学" },
            { id: "campus-2", name: "东校区", schoolName: "示例大学" },
          ],
          selectedCampusId: null,
          userSummary: null,
        }}
      />,
    );

    expect(screen.getByPlaceholderText("输入商品名称、跑腿任务或技能项目")).toBeTruthy();
    expect(screen.getByRole("button", { name: "立即搜索" })).toBeTruthy();
    expect(screen.getByText("全部校区")).toBeTruthy();
    expect(container.querySelector('select[name="campus"]')).toBeTruthy();
    expect(screen.getByRole("link", { name: "卖闲置" }).getAttribute("href")).toBe("/products/new");
    expect(screen.getByRole("link", { name: "发跑腿" }).getAttribute("href")).toBe("/errands/new");
    expect(screen.getByRole("link", { name: "做服务" }).getAttribute("href")).toBe("/services/new");
    expect(screen.getByRole("link", { name: /教材资料/ }).getAttribute("href")).toBe("/search?q=教材");
  });

  it("shows selected-campus summary copy and reset link when a campus filter is active", () => {
    render(
      <HeroSection
        summary={{
          productCount: 8,
          errandCount: 2,
          serviceCount: 5,
          campuses: [{ id: "campus-1", name: "主校区", schoolName: "示例大学" }],
          selectedCampusId: "campus-1",
          userSummary: {
            unreadNotifications: 3,
            unreadConversations: 1,
            activeOrders: 2,
          },
        }}
      />,
    );

    expect(screen.getByText("当前所选校区二手商品数量")).toBeTruthy();
    expect(screen.getByText("当前所选校区开放中的跑腿任务数量")).toBeTruthy();
    expect(screen.getByText("当前所选校区可预约的技能服务数量")).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看全部" }).getAttribute("href")).toBe("/");
    expect(screen.getByText("欢迎回来，开始浏览今天的校园动态")).toBeTruthy();
  });
});
