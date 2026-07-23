import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, getMyProducts, deleteProduct } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getMyProducts: vi.fn(),
  deleteProduct: vi.fn(),
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

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/repositories/product-repository", () => ({
  getMyProducts,
}));

vi.mock("@/actions/product", () => ({
  deleteProduct,
}));

vi.mock("@/components/product/product-status-actions", () => ({
  ProductStatusActions: ({
    productId,
    currentStatus,
  }: {
    productId: string;
    currentStatus: string;
  }) => (
    <div>
      <p>商品操作 {productId}</p>
      <p>当前状态 {currentStatus}</p>
    </div>
  ),
}));

import MyProductsPage from "@/app/my/products/page";

afterEach(() => {
  cleanup();
});

describe("MyProductsPage", () => {
  it("renders the empty state when there are no products", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getMyProducts.mockResolvedValue([]);

    render(await MyProductsPage());

    expect(screen.getByRole("heading", { name: "我的发布" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "发布新商品" }).getAttribute("href")).toBe(
      "/products/new",
    );
    expect(screen.getByText("你还没有发布商品。")).toBeTruthy();
  });

  it("renders products with management actions", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getMyProducts.mockResolvedValue([
      {
        id: "product-1",
        title: "高数教材",
        description: "九成新，带重点笔记。",
        price: 35,
        status: "ACTIVE",
        viewCount: 28,
        favoriteCount: 6,
        category: { name: "教材资料" },
        images: [{ url: "/uploads/products/book.jpg" }],
      },
    ]);

    render(await MyProductsPage());

    expect(screen.getByText("高数教材")).toBeTruthy();
    expect(screen.getByText("九成新，带重点笔记。")).toBeTruthy();
    expect(screen.getByText("价格：¥35")).toBeTruthy();
    expect(screen.getByText("浏览：28")).toBeTruthy();
    expect(screen.getByText("收藏：6")).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看详情" }).getAttribute("href")).toBe(
      "/products/product-1",
    );
    expect(screen.getByRole("link", { name: "编辑" }).getAttribute("href")).toBe(
      "/products/product-1/edit",
    );
    expect(screen.getByDisplayValue("product-1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();
    expect(screen.getByText("商品操作 product-1")).toBeTruthy();
    expect(screen.getByText("当前状态 ACTIVE")).toBeTruthy();
  });
});
