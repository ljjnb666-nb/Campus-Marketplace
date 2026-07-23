import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, getProductForEdit, getProductFormMeta, updateProduct } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getProductForEdit: vi.fn(),
  getProductFormMeta: vi.fn(),
  updateProduct: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/repositories/product-repository", () => ({
  getProductForEdit,
  getProductFormMeta,
}));

vi.mock("@/actions/product", () => ({
  updateProduct,
}));

vi.mock("@/components/product/product-form", () => ({
  ProductForm: ({
    action,
    categories,
    submitLabel,
    productId,
    defaultValues,
  }: {
    action: unknown;
    categories: Array<{ id: string; name: string }>;
    submitLabel: string;
    productId?: string;
    defaultValues?: { title?: string; price?: string };
  }) => (
    <div data-action={action === updateProduct ? "matched" : "unmatched"}>
      <p>分类数量 {categories.length}</p>
      <p>提交按钮 {submitLabel}</p>
      <p>编辑目标ID {productId}</p>
      <p>回显标题 {defaultValues?.title}</p>
      <p>回显价格 {defaultValues?.price}</p>
    </div>
  ),
}));

import EditProductPage from "@/app/products/[id]/edit/page";

afterEach(() => {
  cleanup();
});

describe("EditProductPage Test Suite", () => {
  it("renders header, breadcrumbs and product form with correct initial values", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getProductFormMeta.mockResolvedValue({
      categories: [{ id: "category-1", name: "教材资料" }],
    });
    getProductForEdit.mockResolvedValue({
      id: "product-1",
      title: "高数教材",
      description: "九成新。",
      price: "35.00",
      originalPrice: "60.00",
      categoryId: "category-1",
      condition: "LIKE_NEW",
      locationText: "图书馆门口",
      images: [{ url: "/uploads/products/book.jpg" }],
    });

    render(
      await EditProductPage({
        params: Promise.resolve({ id: "product-1" }),
      }),
    );

    // 验证大标题与导语
    expect(screen.getByRole("heading", { name: "编辑商品信息" })).toBeTruthy();
    expect(screen.getByText("修改商品价格、文字描述或重新调整实物图片")).toBeTruthy();

    // 验证表单绑定的精准初值与 Server Action 关系
    expect(screen.getByText("分类数量 1")).toBeTruthy();
    expect(screen.getByText("提交按钮 保存修改")).toBeTruthy();
    expect(screen.getByText("编辑目标ID product-1")).toBeTruthy();
    expect(screen.getByText("回显标题 高数教材")).toBeTruthy();
    expect(screen.getByText("回显价格 35.00")).toBeTruthy();
    expect(screen.getByText("分类数量 1").parentElement?.getAttribute("data-action")).toBe("matched");
  });
});
