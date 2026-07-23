import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { auth, getErrandList } = vi.hoisted(() => ({
  auth: vi.fn(),
  getErrandList: vi.fn(),
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

vi.mock("@/repositories/errand-repository", () => ({
  getErrandList,
}));

vi.mock("@/components/errand/errand-card", () => ({
  ErrandCard: ({ title, reward }: { title: string; reward: string }) => (
    <div>
      <p>{title}</p>
      <p>{reward}</p>
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

import ErrandsPage from "@/app/errands/page";

afterEach(() => {
  cleanup();
});

describe("ErrandsPage", () => {
  it("renders public browsing and login call-to-action for guests", async () => {
    auth.mockResolvedValue(null);
    getErrandList.mockResolvedValue({
      items: [],
      total: 0,
      categories: [],
      page: 1,
      totalPages: 1,
      pageSize: 12,
    });

    render(
      await ErrandsPage({
        searchParams: Promise.resolve({}),
      }),
    );

    expect(screen.getByText("跑腿求助大厅")).toBeTruthy();
    expect(screen.getAllByText(/发布跑腿/)[0].closest("a")?.getAttribute("href")).toBe(
      "/errands/new",
    );
    expect(screen.getByText(/没有找到符合条件的跑腿任务/)).toBeTruthy();
  });

  it("renders personal actions for authenticated users", async () => {
    auth.mockResolvedValue({ user: { id: "user-1" } });
    getErrandList.mockResolvedValue({
      items: [],
      total: 0,
      categories: [],
      page: 1,
      totalPages: 1,
      pageSize: 12,
    });

    render(
      await ErrandsPage({
        searchParams: Promise.resolve({}),
      }),
    );

    expect(screen.getAllByText(/发布跑腿/)[0].closest("a")?.getAttribute("href")).toBe(
      "/errands/new",
    );
  });

  it("renders filters and errand results", async () => {
    auth.mockResolvedValue({ user: { id: "user-2" } });
    getErrandList.mockResolvedValue({
      items: [
        {
          id: "errand-1",
          title: "代取快递",
          reward: 6,
          pickupLocation: "快递站",
          deliveryLocation: "宿舍楼",
          publisher: { name: "王同学" },
          status: "OPEN",
          category: { name: "代取快递" },
        },
      ],
      total: 1,
      categories: [{ id: "category-1", name: "代取快递" }],
      page: 3,
      totalPages: 4,
      pageSize: 12,
    });

    render(
      await ErrandsPage({
        searchParams: Promise.resolve({
          q: "快递",
          category: "category-1",
          status: "OPEN",
          deadline: "today",
          sort: "deadline_asc",
          page: "3",
        }),
      }),
    );

    expect(screen.getByText(/1.*条跑腿任务/)).toBeTruthy();
    expect(screen.getByText("代取快递")).toBeTruthy();
    expect(screen.getByText("分页 3/4")).toBeTruthy();
  });
});
