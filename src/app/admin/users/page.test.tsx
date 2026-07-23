import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAdmin, getAdminUserList, toggleUserStatus } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getAdminUserList: vi.fn(),
  toggleUserStatus: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  requireAdmin,
}));

vi.mock("@/repositories/admin-repository", () => ({
  getAdminUserList,
}));

vi.mock("@/actions/admin", () => ({
  toggleUserStatus,
}));

import AdminUsersPage from "@/app/admin/users/page";

afterEach(() => {
  cleanup();
});

describe("AdminUsersPage", () => {
  it("renders the empty state when there are no users", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getAdminUserList.mockResolvedValue([]);

    render(await AdminUsersPage());

    expect(screen.getByRole("heading", { name: "用户管理" })).toBeTruthy();
    expect(screen.getByText("当前还没有可管理的用户数据。")).toBeTruthy();
  });

  it("renders user details and status actions", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getAdminUserList.mockResolvedValue([
      {
        id: "user-1",
        name: "张同学",
        email: "student@example.com",
        schoolName: "示例大学",
        status: "ACTIVE",
        verificationStatus: "VERIFIED",
        role: "STUDENT",
        creditScore: 98,
        completedOrdersCount: 12,
        createdAt: new Date("2026-07-10T08:00:00.000Z"),
        lastLoginAt: null,
        campus: { name: "主校区" },
        _count: {
          products: 4,
          createdErrandTasks: 2,
          serviceListings: 3,
          buyerOrders: 5,
        },
      },
    ]);

    render(await AdminUsersPage());

    expect(screen.getByText("张同学")).toBeTruthy();
    expect(screen.getByText("student@example.com")).toBeTruthy();
    expect(screen.getByText("账号状态：正常")).toBeTruthy();
    expect(screen.getByText("认证状态：已认证")).toBeTruthy();
    expect(screen.getByText("信用分：98")).toBeTruthy();
    expect(screen.getByText("完成订单：12")).toBeTruthy();
    expect(screen.getByText("商品 4")).toBeTruthy();
    expect(screen.getByText("最近登录：暂无记录")).toBeTruthy();
    expect(screen.getByDisplayValue("user-1")).toBeTruthy();
    expect(screen.getByDisplayValue("SUSPENDED")).toBeTruthy();
    expect(screen.getByRole("button", { name: "停用账号" })).toBeTruthy();
  });
});
