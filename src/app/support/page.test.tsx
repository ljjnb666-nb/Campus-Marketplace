import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, listOwnSupportTickets, listActiveMembershipCampuses } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  listOwnSupportTickets: vi.fn(),
  listActiveMembershipCampuses: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({ requireUser }));
vi.mock("@/lib/support/support-service", () => ({ listOwnSupportTickets }));
vi.mock("@/repositories/user-repository", () => ({ listActiveMembershipCampuses }));

import SupportPage from "@/app/support/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SupportPage（用户支持面）", () => {
  it("渲染创建表单 + 本人工单列表", async () => {
    requireUser.mockResolvedValue({ id: "u1" });
    listOwnSupportTickets.mockResolvedValue([
      {
        id: "t1",
        category: "ACCOUNT",
        status: "RESOLVED",
        subject: "无法登录",
        campusName: null,
        createdAt: new Date("2026-09-19T00:00:00.000Z"),
        dueAt: new Date("2026-09-22T00:00:00.000Z"),
        overdue: false,
      },
    ]);
    listActiveMembershipCampuses.mockResolvedValue([
      { campus: { id: "A", name: "甲校区" } },
    ]);

    render(await SupportPage());

    expect(screen.getByRole("form", { name: "提交支持工单" })).toBeVisible();
    expect(screen.getByText("主题：无法登录")).toBeVisible();
    expect(screen.getByText("已解决")).toBeVisible();
    expect(screen.getByRole("link", { name: "查看详情" })).toHaveAttribute("href", "/support/t1");
    // campus 下拉由 ACTIVE membership 派生
    expect(screen.getByRole("option", { name: "甲校区" })).toBeVisible();
  });

  it("空列表渲染空态", async () => {
    requireUser.mockResolvedValue({ id: "u1" });
    listOwnSupportTickets.mockResolvedValue([]);
    listActiveMembershipCampuses.mockResolvedValue([]);

    render(await SupportPage());
    expect(screen.getByText("你还没有提交过工单。")).toBeVisible();
  });
});
