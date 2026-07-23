import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAdmin, getAdminDashboardData } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getAdminDashboardData: vi.fn(),
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
  getAdminDashboardData,
}));

import AdminPage from "@/app/admin/page";

afterEach(() => {
  cleanup();
});

describe("AdminPage", () => {
  it("renders dashboard empty states and quick links", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getAdminDashboardData.mockResolvedValue({
      latestVerifications: 0,
      latestReports: 0,
      todayNewVerifications: 0,
      todayNewReports: 0,
      totalUsers: 120,
      todayNewUsers: 3,
      totalProducts: 88,
      activeProducts: 70,
      todayNewProducts: 5,
      totalErrands: 44,
      completedErrands: 28,
      totalReports: 9,
      pendingVerifications: [],
      openReports: [],
    });

    render(await AdminPage());

    expect(screen.getByRole("heading", { name: "管理后台" })).toBeTruthy();
    expect(screen.getByText("集中处理认证审核、举报工单和平台内容巡检。")).toBeTruthy();
    expect(screen.getByText("暂无待审核认证。")).toBeTruthy();
    expect(screen.getByText("暂无待处理举报。")).toBeTruthy();
    expect(screen.getByRole("link", { name: "认证审核" }).getAttribute("href")).toBe("/admin/verifications");
    expect(screen.getByRole("link", { name: "举报处理" }).getAttribute("href")).toBe("/admin/reports");
    expect(screen.getByText("用户总数")).toBeTruthy();
    expect(screen.getByText("120")).toBeTruthy();
  });

  it("renders pending verifications and report summaries", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getAdminDashboardData.mockResolvedValue({
      latestVerifications: 1,
      latestReports: 1,
      todayNewVerifications: 1,
      todayNewReports: 2,
      totalUsers: 121,
      todayNewUsers: 1,
      totalProducts: 90,
      activeProducts: 71,
      todayNewProducts: 2,
      totalErrands: 48,
      completedErrands: 31,
      totalReports: 10,
      pendingVerifications: [
        {
          id: "verification-1",
          schoolName: "示例大学",
          campusName: "主校区",
          submittedAt: new Date("2026-07-18T08:00:00.000Z"),
          user: { name: "张同学" },
        },
      ],
      openReports: [
        {
          id: "report-1",
          reason: "SCAM_RISK",
          createdAt: new Date("2026-07-18T09:00:00.000Z"),
          reporter: { name: "李同学" },
          product: { title: "高数教材" },
          errandTask: null,
          serviceListing: null,
          targetUser: null,
          message: null,
        },
      ],
    });

    render(await AdminPage());

    expect(screen.getByText("张同学")).toBeTruthy();
    expect(screen.getByText("示例大学 · 主校区")).toBeTruthy();
    expect(screen.getByText("诈骗风险")).toBeTruthy();
    expect(screen.getByText("举报人：李同学")).toBeTruthy();
    expect(screen.getByText("目标：商品：高数教材")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "查看全部" })).toHaveLength(2);
  });
});
