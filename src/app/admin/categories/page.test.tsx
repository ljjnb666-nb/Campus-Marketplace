import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  requireAdmin,
  getAdminCategoryList,
  getAdminErrandCategoryList,
  getAdminServiceCategoryList,
  upsertProductCategory,
  upsertErrandCategory,
  upsertServiceCategory,
  toggleProductCategoryStatus,
  toggleErrandCategoryStatus,
  toggleServiceCategoryStatus,
} = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getAdminCategoryList: vi.fn(),
  getAdminErrandCategoryList: vi.fn(),
  getAdminServiceCategoryList: vi.fn(),
  upsertProductCategory: vi.fn(),
  upsertErrandCategory: vi.fn(),
  upsertServiceCategory: vi.fn(),
  toggleProductCategoryStatus: vi.fn(),
  toggleErrandCategoryStatus: vi.fn(),
  toggleServiceCategoryStatus: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  requireAdmin,
}));

vi.mock("@/repositories/admin-repository", () => ({
  getAdminCategoryList,
  getAdminErrandCategoryList,
  getAdminServiceCategoryList,
}));

vi.mock("@/actions/admin", () => ({
  upsertProductCategory,
  upsertErrandCategory,
  upsertServiceCategory,
  toggleProductCategoryStatus,
  toggleErrandCategoryStatus,
  toggleServiceCategoryStatus,
}));

import AdminCategoriesPage from "@/app/admin/categories/page";

afterEach(() => {
  cleanup();
});

describe("AdminCategoriesPage", () => {
  it("renders empty states for all category sections", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getAdminCategoryList.mockResolvedValue([]);
    getAdminErrandCategoryList.mockResolvedValue([]);
    getAdminServiceCategoryList.mockResolvedValue([]);

    render(await AdminCategoriesPage());

    expect(screen.getByRole("heading", { name: "分类管理" })).toBeTruthy();
    expect(screen.getAllByText("当前还没有分类数据。")).toHaveLength(3);
  });

  it("renders category forms and toggle actions", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getAdminCategoryList.mockResolvedValue([
      {
        id: "product-category-1",
        name: "教材资料",
        slug: "books",
        description: "教材和笔记",
        sortOrder: 1,
        isActive: true,
        _count: { products: 8 },
      },
    ]);
    getAdminErrandCategoryList.mockResolvedValue([]);
    getAdminServiceCategoryList.mockResolvedValue([]);

    render(await AdminCategoriesPage());

    expect(screen.getByDisplayValue("教材资料")).toBeTruthy();
    expect(screen.getByDisplayValue("books")).toBeTruthy();
    expect(screen.getByDisplayValue("教材和笔记")).toBeTruthy();
    expect(screen.getByText("商品数：8")).toBeTruthy();
    expect(screen.getByRole("button", { name: "停用" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "创建分类" })).toHaveLength(3);
  });
});
