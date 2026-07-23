import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductForm } from "@/components/product/product-form";

const { mockPush, mockRefresh, mockUseActionState } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
  mockUseActionState: vi.fn(),
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");

  return {
    ...actual,
    useActionState: mockUseActionState,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: mockRefresh,
  }),
}));

beforeEach(() => {
  mockPush.mockReset();
  mockRefresh.mockReset();
  mockUseActionState.mockReset();
  mockUseActionState.mockReturnValue([{ success: false, message: "" }, vi.fn()]);
});

afterEach(() => {
  cleanup();
});

describe("ProductForm", () => {
  it("renders upload input and category choices", () => {
    const { container } = render(
      <ProductForm
        action={async () => ({ success: false, message: "" })}
        categories={[{ id: "cat-1", name: "教材资料" }]}
        submitLabel="发布商品"
      />,
    );

    expect(screen.getByRole("option", { name: "请选择所属分类" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "教材资料" })).toBeTruthy();
    expect(container.querySelector('input[type="file"]')).toBeInTheDocument();
  });

  it("renders editing defaults and hidden values", () => {
    render(
      <ProductForm
        action={async () => ({ success: false, message: "" })}
        categories={[{ id: "cat-1", name: "教材资料" }]}
        submitLabel="保存商品"
        productId="product-1"
        defaultValues={{
          title: "二手高数教材",
          description: "九成新，含课堂笔记",
          price: "25",
          originalPrice: "58",
          categoryId: "cat-1",
          condition: "LIGHTLY_USED",
          locationText: "图书馆门口",
          images: [{ url: "/uploads/products/book.jpg" }],
        }}
      />,
    );

    expect(screen.getByDisplayValue("二手高数教材")).toBeTruthy();
    expect(screen.getByDisplayValue("九成新，含课堂笔记")).toBeTruthy();
    expect(screen.getByDisplayValue("25")).toBeTruthy();
    expect(screen.getByDisplayValue("58")).toBeTruthy();
    expect(screen.getByDisplayValue("图书馆门口")).toBeTruthy();
    expect(screen.getByRole("option", { name: "教材资料" })).toBeTruthy();
  });

  it("shows the action error message from server state", () => {
    mockUseActionState.mockReturnValue([{ success: false, message: "商品标题已存在" }, vi.fn()]);

    render(
      <ProductForm
        action={async () => ({ success: false, message: "" })}
        categories={[{ id: "cat-1", name: "教材资料" }]}
        submitLabel="发布商品"
      />,
    );

    expect(screen.getByText("商品标题已存在")).toBeTruthy();
  });

  it("redirects after a successful action state", () => {
    mockUseActionState.mockReturnValue([
      { success: true, message: "发布成功", redirectTo: "/products/product-1" },
      vi.fn(),
    ]);

    render(
      <ProductForm
        action={async () => ({ success: false, message: "" })}
        categories={[{ id: "cat-1", name: "教材资料" }]}
        submitLabel="发布商品"
      />,
    );

    expect(mockPush).toHaveBeenCalledWith("/products/product-1");
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
