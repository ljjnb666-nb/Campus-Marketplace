import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { auth, getServiceList } = vi.hoisted(() => ({
  auth: vi.fn(),
  getServiceList: vi.fn(),
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

vi.mock("@/lib/auth", () => ({
  auth,
}));

vi.mock("@/repositories/service-repository", () => ({
  getServiceList,
}));

vi.mock("@/components/service/service-card", () => ({
  ServiceCard: ({ title, price }: { title: string; price: string }) => (
    <div>
      <p>{title}</p>
      <p>{price}</p>
    </div>
  ),
}));

vi.mock("@/components/site/pagination", () => ({
  Pagination: ({ page, totalPages }: { page: number; totalPages: number }) => (
    <p>
      分页 {page}/{totalPages}
    </p>
  ),
}));

import ServicesPage from "@/app/services/page";

afterEach(() => {
  cleanup();
});

describe("ServicesPage", () => {
  it("renders public browsing and login call-to-action for guests", async () => {
    auth.mockResolvedValue(null);
    getServiceList.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      totalPages: 1,
      pageSize: 12,
      categories: [],
    });

    render(
      await ServicesPage({
        searchParams: Promise.resolve({}),
      }),
    );

    expect(screen.getByRole("heading", { name: "技能服务广场" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "发布技能服务" }).getAttribute("href")).toBe(
      "/services/new",
    );
    expect(screen.getByText("没有找到符合条件的技能服务")).toBeTruthy();
  });

  it("renders active filters, category shortcuts, and results", async () => {
    auth.mockResolvedValue({ user: { id: "user-1" } });
    getServiceList.mockResolvedValue({
      items: [
        {
          id: "service-1",
          title: "PPT 美化",
          description: "答辩排版",
          price: 80,
          pricingUnit: "PER_ORDER",
          status: "ACTIVE",
          provider: { name: "李同学" },
          locationText: "线上",
          category: { name: "设计", slug: "design" },
          coverImageUrl: null,
          completedOrderCount: 8,
        },
      ],
      total: 1,
      page: 1,
      totalPages: 2,
      pageSize: 12,
      categories: [{ id: "service-category-1", name: "设计", slug: "design" }],
    });

    render(
      await ServicesPage({
        searchParams: Promise.resolve({
          q: "PPT",
          category: "design",
          status: "ACTIVE",
          pricingUnit: "PER_ORDER",
          verifiedOnly: "true",
        }),
      }),
    );

    expect(screen.getByRole("link", { name: "发布技能服务" }).getAttribute("href")).toBe(
      "/services/new",
    );
    expect(screen.getAllByText("PPT 美化")[0]).toBeTruthy();
    expect(screen.getByRole("option", { name: "设计" })).toBeTruthy();
    expect(screen.getAllByText(/80/)[0]).toBeTruthy();
    expect(screen.getByText("分页 1/2")).toBeTruthy();
  });
});
