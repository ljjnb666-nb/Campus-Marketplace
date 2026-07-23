import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAdmin, getAdminErrandList, moderateListing } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getAdminErrandList: vi.fn(),
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
  getAdminErrandList,
}));

vi.mock("@/actions/admin", () => ({
  moderateListing,
}));

import AdminErrandsPage from "@/app/admin/errands/page";

afterEach(() => {
  cleanup();
});

describe("AdminErrandsPage", () => {
  it("renders the empty state when there are no errands", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getAdminErrandList.mockResolvedValue([]);

    render(await AdminErrandsPage());

    expect(screen.getByRole("heading", { name: "任务管理" })).toBeTruthy();
    expect(screen.getByText("暂无待管理任务。")).toBeTruthy();
  });

  it("renders errands with moderation actions", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getAdminErrandList.mockResolvedValue([
      {
        id: "errand-1",
        title: "代取快递",
        description: "需要核查是否存在刷单风险。",
        status: "OPEN",
        reward: 12,
        category: { name: "校园跑腿" },
        publisher: { name: "张同学" },
        accepter: null,
      },
    ]);

    render(await AdminErrandsPage());

    expect(screen.getByText("代取快递")).toBeTruthy();
    expect(screen.getByText("需要核查是否存在刷单风险。")).toBeTruthy();
    expect(screen.getByText("分类：校园跑腿")).toBeTruthy();
    expect(screen.getByText("发布人：张同学")).toBeTruthy();
    expect(screen.getByText("接单人：暂无")).toBeTruthy();
    expect(screen.getByText("赏金：￥12")).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看详情" }).getAttribute("href")).toBe(
      "/errands/errand-1",
    );
    expect(screen.getByDisplayValue("ERRAND")).toBeTruthy();
    expect(screen.getByDisplayValue("errand-1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消任务" })).toBeTruthy();
  });
});
