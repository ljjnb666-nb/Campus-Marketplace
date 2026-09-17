import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  requireReportReviewer,
  loadAuthorizedReportDetail,
  claimGovernanceReportCase,
  releaseGovernanceReportCase,
  reviewGovernanceReport,
  notFound,
} = vi.hoisted(() => ({
  requireReportReviewer: vi.fn(),
  loadAuthorizedReportDetail: vi.fn(),
  claimGovernanceReportCase: vi.fn(),
  releaseGovernanceReportCase: vi.fn(),
  reviewGovernanceReport: vi.fn(),
  // Next.js notFound() 通过抛出中止渲染——mock 保持同形
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({
  notFound,
}));

vi.mock("@/lib/reports/report-access", () => ({
  requireReportReviewer,
}));

vi.mock("@/lib/reports/report-query", () => ({
  loadAuthorizedReportDetail,
}));

vi.mock("@/actions/governance-reports", () => ({
  claimGovernanceReportCase,
  releaseGovernanceReportCase,
  reviewGovernanceReport,
}));

import GovernanceReportDetailPage from "@/app/governance/reports/[reportId]/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockReviewer() {
  requireReportReviewer.mockResolvedValue({
    user: { id: "viewer-1", email: "r@x", name: "审核员", role: "STUDENT" },
    context: { userId: "viewer-1", accountActive: true, activeCampusIds: [], grants: [] },
    access: { global: false, campusIds: ["campus-1"] },
  });
}

function baseDetail(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    detail: {
      reportId: "report-1",
      caseId: "case-1",
      status: "OPEN",
      reason: "SCAM_RISK",
      targetType: "RENTAL_LISTING",
      detail: "举报详情文本",
      safeTargetLabel: "租赁：E2E 租赁物",
      scopeLabel: "校区：主校区",
      reporterName: "举报人甲",
      createdAt: new Date("2026-09-16T08:00:00.000Z").toISOString(),
      handledAt: null,
      handledNote: null,
      caseTiming: {
        openedAt: new Date("2026-09-16T08:00:00.000Z").toISOString(),
        dueAt: new Date("2026-09-18T08:00:00.000Z").toISOString(),
        lastActivityAt: new Date("2026-09-16T08:00:00.000Z").toISOString(),
        closedAt: null,
        overdue: false,
      },
      assignedReviewer: null,
      selfAssigned: false,
      scopeAuthorized: true,
      ...overrides,
    },
  };
}

async function renderDetail() {
  const view = render(
    await GovernanceReportDetailPage({ params: Promise.resolve({ reportId: "report-1" }) }),
  );
  return view;
}

describe("GovernanceReportDetailPage（举报详情）", () => {
  it("未授权（ok=false）→ notFound（统一反枚举）", async () => {
    mockReviewer();
    loadAuthorizedReportDetail.mockResolvedValue({ ok: false });

    await expect(renderDetail()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  it("渲染举报内容 + case 时钟 + 审核操作；未领用时渲染领用控件", async () => {
    mockReviewer();
    loadAuthorizedReportDetail.mockResolvedValue(baseDetail());

    await renderDetail();

    expect(screen.getByRole("heading", { name: "举报详情" })).toBeTruthy();
    expect(screen.getByText("举报详情文本")).toBeTruthy();
    expect(screen.getByText("举报人：举报人甲")).toBeTruthy();
    expect(screen.getByText("目标：租赁：E2E 租赁物")).toBeTruthy();
    expect(screen.getByText("ACTIVE")).toBeTruthy();
    expect(screen.getByRole("form", { name: "领用 case" })).toBeTruthy();
    // 审核表单存在且按钮可用（scopeAuthorized）
    expect(screen.getByRole("button", { name: "处理完成" }).hasAttribute("disabled")).toBe(false);
  });

  it("case ACTIVE + selfAssigned → 渲染释放控件（closed case 两者皆无）", async () => {
    mockReviewer();
    loadAuthorizedReportDetail.mockResolvedValue(
      baseDetail({
        assignedReviewer: { id: "viewer-1", displayName: "审核员" },
        selfAssigned: true,
      }),
    );

    await renderDetail();

    expect(screen.getByText("ACTIVE")).toBeTruthy();
    expect(screen.getByRole("form", { name: "释放 case" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "领用 case" })).toBeNull();
  });

  it("终局（CLOSED）case → 渲染关闭时钟与 reopen 提示，不渲染领用/释放控件", async () => {
    mockReviewer();
    loadAuthorizedReportDetail.mockResolvedValue(
      baseDetail({
        status: "RESOLVED",
        caseTiming: {
          openedAt: new Date("2026-09-16T08:00:00.000Z").toISOString(),
          dueAt: new Date("2026-09-18T08:00:00.000Z").toISOString(),
          lastActivityAt: new Date("2026-09-17T08:00:00.000Z").toISOString(),
          closedAt: new Date("2026-09-17T08:00:00.000Z").toISOString(),
          overdue: false,
        },
        assignedReviewer: { id: "viewer-1", displayName: "审核员" },
        selfAssigned: true,
      }),
    );

    const { container } = await renderDetail();

    expect(screen.getByText("CLOSED")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "释放 case" })).toBeNull();
    expect(screen.queryByRole("form", { name: "领用 case" })).toBeNull();
    expect(container.textContent).toContain("重新开案并重置办理时限");
  });

  it("overdue 详情呈现超时徽标", async () => {
    mockReviewer();
    loadAuthorizedReportDetail.mockResolvedValue(
      baseDetail({
        caseTiming: {
          openedAt: new Date("2026-09-14T08:00:00.000Z").toISOString(),
          dueAt: new Date("2026-09-16T08:00:00.000Z").toISOString(),
          lastActivityAt: new Date("2026-09-14T08:00:00.000Z").toISOString(),
          closedAt: null,
          overdue: true,
        },
      }),
    );

    await renderDetail();

    expect(screen.getByText("办理已超时")).toBeTruthy();
  });
});
