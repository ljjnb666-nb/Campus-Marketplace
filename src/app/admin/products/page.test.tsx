import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAdmin, getAdminProductList, moderateListing } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getAdminProductList: vi.fn(),
  moderateListing: vi.fn(),
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
  requireAdmin,
}));

vi.mock("@/repositories/admin-repository", () => ({
  getAdminProductList,
}));

vi.mock("@/actions/admin", () => ({
  moderateListing,
}));

import AdminProductsPage from "@/app/admin/products/page";

afterEach(() => {
  cleanup();
});

describe("AdminProductsPage", () => {
  it("renders the empty state when there are no products", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getAdminProductList.mockResolvedValue([]);

    render(await AdminProductsPage());

    expect(screen.getByRole("heading", { name: "商品管理" })).toBeTruthy();
    expect(screen.getByText("暂无待管理商品。")).toBeTruthy();
  });

  it("renders products with moderation actions", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getAdminProductList.mockResolvedValue([
      {
        id: "product-1",
        title: "高数教材",
        description: "存在价格争议，需要管理员查看。",
        status: "ACTIVE",
        price: 35,
        category: { name: "教材资料" },
        seller: { name: "李同学" },
        images: [{ url: "/uploads/products/book.jpg" }],
      },
    ]);

    render(await AdminProductsPage());

    expect(screen.getByText("高数教材")).toBeTruthy();
    expect(screen.getByText("存在价格争议，需要管理员查看。")).toBeTruthy();
    expect(screen.getByText("分类：教材资料")).toBeTruthy();
    expect(screen.getByText("卖家：李同学")).toBeTruthy();
    expect(screen.getByText("价格：￥35")).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看详情" }).getAttribute("href")).toBe(
      "/products/product-1",
    );
    expect(screen.getByDisplayValue("PRODUCT")).toBeTruthy();
    expect(screen.getByDisplayValue("product-1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "强制下架" })).toBeTruthy();
  });
});
