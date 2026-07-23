import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, getProductFormMeta, createProduct } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getProductFormMeta: vi.fn(),
  createProduct: vi.fn(),
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
  getProductFormMeta,
}));

vi.mock("@/actions/product", () => ({
  createProduct,
}));

vi.mock("@/components/product/product-form", () => ({
  ProductForm: ({
    action,
    categories,
    submitLabel,
  }: {
    action: unknown;
    categories: Array<{ id: string; name: string }>;
    submitLabel: string;
  }) => (
    <div data-action={action === createProduct ? "matched" : "unmatched"}>
      <p>分类数量 {categories.length}</p>
      <p>{submitLabel}</p>
    </div>
  ),
}));

import NewProductPage from "@/app/products/new/page";

afterEach(() => {
  cleanup();
});

describe("NewProductPage", () => {
  it("renders the product publishing page", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getProductFormMeta.mockResolvedValue({
      categories: [{ id: "category-1", name: "教材资料" }],
    });

    render(await NewProductPage());

    expect(screen.getByRole("heading", { name: "发布二手闲置" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "我的发布历史" }).getAttribute("href")).toBe("/my/products");
    expect(screen.getByText("分类数量 1")).toBeTruthy();
    expect(screen.getByText("确认发布商品")).toBeTruthy();
    expect(screen.getByText("分类数量 1").parentElement?.getAttribute("data-action")).toBe("matched");
  });
});
