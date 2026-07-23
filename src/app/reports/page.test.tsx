import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, getMyReports } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getMyReports: vi.fn(),
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

vi.mock("@/repositories/trust-repository", () => ({
  getMyReports,
}));

import ReportsPage from "@/app/reports/page";

afterEach(() => {
  cleanup();
});

describe("ReportsPage", () => {
  it("renders the empty state when there are no reports", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getMyReports.mockResolvedValue([]);

    render(await ReportsPage());

    expect(screen.getByRole("heading", { name: "举报中心" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /从商品页举报/ }).getAttribute("href")).toBe("/products");
    expect(screen.getByRole("link", { name: /从任务页举报/ }).getAttribute("href")).toBe("/errands");
    expect(screen.getByRole("link", { name: /从服务页举报/ }).getAttribute("href")).toBe("/services");
    expect(screen.getByRole("link", { name: /从会话页举报/ }).getAttribute("href")).toBe("/messages");
    expect(screen.getByText("你还没有提交过举报。")).toBeTruthy();
  });

  it("renders submitted reports with target, status, and note", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getMyReports.mockResolvedValue([
      {
        id: "report-1",
        status: "IN_REVIEW",
        reason: "SCAM_RISK",
        detail: "对方要求先转账再发货。",
        createdAt: new Date("2026-07-18T07:30:00.000Z"),
        handledNote: "已进入人工核查队列",
        product: {
          title: "高数教材",
        },
        errandTask: null,
        serviceListing: null,
        targetUser: null,
        message: null,
      },
    ]);

    render(await ReportsPage());

    expect(screen.getByRole("heading", { name: "商品：高数教材" })).toBeTruthy();
    expect(screen.getByText("状态：处理中")).toBeTruthy();
    expect(screen.getByText("原因：诈骗风险")).toBeTruthy();
    expect(screen.getByText("说明：对方要求先转账再发货。")).toBeTruthy();
    expect(screen.getByText("处理备注：已进入人工核查队列")).toBeTruthy();
  });
});
