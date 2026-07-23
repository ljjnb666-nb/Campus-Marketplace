import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAdmin, getReportReviewQueue, reviewReport } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getReportReviewQueue: vi.fn(),
  reviewReport: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  requireAdmin,
}));

vi.mock("@/repositories/admin-repository", () => ({
  getReportReviewQueue,
}));

vi.mock("@/actions/admin", () => ({
  reviewReport,
}));

import AdminReportsPage from "@/app/admin/reports/page";

afterEach(() => {
  cleanup();
});

describe("AdminReportsPage", () => {
  it("renders the empty state when there are no reports", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getReportReviewQueue.mockResolvedValue([]);

    render(await AdminReportsPage());

    expect(screen.getByRole("heading", { name: "举报处理" })).toBeTruthy();
    expect(screen.getByText("当前没有待处理举报。")).toBeTruthy();
  });

  it("renders report details and moderation actions", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getReportReviewQueue.mockResolvedValue([
      {
        id: "report-1",
        reason: "SCAM_RISK",
        status: "IN_REVIEW",
        detail: "对方要求先转账再发货。",
        handledNote: "已转人工复核。",
        createdAt: new Date("2026-07-18T08:30:00.000Z"),
        reporter: { name: "王同学" },
        product: { title: "高数教材" },
        errandTask: null,
        serviceListing: null,
        targetUser: null,
        message: null,
      },
    ]);

    render(await AdminReportsPage());

    expect(screen.getByText("诈骗风险")).toBeTruthy();
    expect(screen.getByText("状态：处理中")).toBeTruthy();
    expect(screen.getByText("举报人：王同学")).toBeTruthy();
    expect(screen.getByText("目标：商品：高数教材")).toBeTruthy();
    expect(screen.getByText("说明：对方要求先转账再发货。")).toBeTruthy();
    expect(screen.getByText("上次处理备注：已转人工复核。")).toBeTruthy();
    expect(screen.getByDisplayValue("report-1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "标记处理中" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "处理完成" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "驳回举报" })).toBeTruthy();
  });
});
