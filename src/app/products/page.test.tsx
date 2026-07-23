import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { auth, getProductList, getProductFormMeta } = vi.hoisted(() => ({
  auth: vi.fn(),
  getProductList: vi.fn(),
  getProductFormMeta: vi.fn(),
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

vi.mock("@/repositories/product-repository", () => ({
  getProductList,
  getProductFormMeta,
}));

vi.mock("@/components/product/product-card", () => ({
  ProductCard: ({ title, price }: { title: string; price: string }) => (
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

import ProductsPage from "@/app/products/page";

afterEach(() => {
  cleanup();
});

describe("ProductsPage", () => {
  it("renders public browsing and login call-to-action for guests", async () => {
    auth.mockResolvedValue(null);
    getProductFormMeta.mockResolvedValue({
      categories: [],
    });
    getProductList.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      totalPages: 1,
      pageSize: 12,
    });

    render(
      await ProductsPage({
        searchParams: Promise.resolve({}),
      }),
    );

    expect(screen.getByText("二手商品广场")).toBeTruthy();
    expect(screen.getByText("登录后发布").closest("a")?.getAttribute("href")).toBe("/login");
    expect(screen.getByText(/没有找到符合条件的商品/)).toBeTruthy();
  });

  it("renders personal actions for authenticated users", async () => {
    auth.mockResolvedValue({ user: { id: "user-1" } });
    getProductFormMeta.mockResolvedValue({
      categories: [],
    });
    getProductList.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      totalPages: 1,
      pageSize: 12,
    });

    render(
      await ProductsPage({
        searchParams: Promise.resolve({}),
      }),
    );

    expect(screen.getByText(/发布商品/).closest("a")?.getAttribute("href")).toBe("/products/new");
  });

  it("renders filters, results summary, and cards", async () => {
    auth.mockResolvedValue({ user: { id: "user-2" } });
    getProductFormMeta.mockResolvedValue({
      categories: [{ id: "category-1", name: "教材资料" }],
    });
    getProductList.mockResolvedValue({
      items: [
        {
          id: "product-1",
          title: "高数教材",
          description: "九成新",
          price: 35,
          status: "ACTIVE",
          category: { name: "教材资料" },
          seller: { name: "张同学" },
          images: [],
          favoriteCount: 3,
        },
      ],
      total: 1,
      page: 2,
      totalPages: 3,
      pageSize: 12,
    });

    render(
      await ProductsPage({
        searchParams: Promise.resolve({
          q: "高数",
          category: "category-1",
          status: "ACTIVE",
          minPrice: "10",
          maxPrice: "50",
          sort: "popular",
          page: "2",
        }),
      }),
    );

    expect(screen.getByText(/1.*件在售商品/)).toBeTruthy();
    expect(screen.getByText("高数教材")).toBeTruthy();
    expect(screen.getByText("分页 2/3")).toBeTruthy();
  });
});
