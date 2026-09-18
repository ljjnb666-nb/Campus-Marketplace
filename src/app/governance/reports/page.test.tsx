import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  requireReportReviewer,
  loadAuthorizedReportQueue,
  listReportQueueCampuses,
} = vi.hoisted(() => ({
  requireReportReviewer: vi.fn(),
  loadAuthorizedReportQueue: vi.fn(),
  listReportQueueCampuses: vi.fn(),
}));

vi.mock("@/lib/reports/report-access", () => ({
  requireReportReviewer,
}));

vi.mock("@/lib/reports/report-query", () => ({
  loadAuthorizedReportQueue,
  listReportQueueCampuses,
  REPORT_QUEUE_DEFAULT_PAGE_SIZE: 25,
  REPORT_QUEUE_MAX_PAGE_SIZE: 50,
  decodeReportCursor: (raw: string) =>
    raw === "good-cursor"
      ? { dueAt: new Date("2026-09-18T00:00:00.000Z"), createdAt: new Date("2026-09-16T00:00:00.000Z"), id: "case-1" }
      : null,
}));

import GovernanceReportsPage from "@/app/governance/reports/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockReviewer(access: { global: boolean; campusIds: string[] } = { global: false, campusIds: ["campus-1"] }) {
  requireReportReviewer.mockResolvedValue({
    user: { id: "viewer-1", email: "r@x", name: "审核员", role: "STUDENT" },
    context: { userId: "viewer-1", accountActive: true, activeCampusIds: [], grants: [] },
    access,
  });
}

function baseItem(overrides: Record<string, unknown> = {}) {
  return {
    reportId: "report-1",
    caseId: "case-1",
    reason: "SCAM_RISK",
    status: "OPEN",
    targetType: "RENTAL_LISTING",
    safeTargetLabel: "租赁：E2E 租赁物",
    scopeLabel: "校区：主校区",
    createdAt: new Date("2026-09-16T08:00:00.000Z").toISOString(),
    dueAt: new Date("2026-09-18T08:00:00.000Z").toISOString(),
    overdue: false,
    assignedReviewer: null,
    ...overrides,
  };
}

describe("GovernanceReportsPage（举报运营队列）", () => {
  it("空队列渲染空态；campus 选项来自授权派生", async () => {
    mockReviewer();
    loadAuthorizedReportQueue.mockResolvedValue({ items: [], nextCursor: null });
    listReportQueueCampuses.mockResolvedValue([{ id: "campus-1", name: "主校区" }]);

    render(await GovernanceReportsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("heading", { name: "举报处理" })).toBeTruthy();
    expect(screen.getByText("当前没有符合条件的举报。")).toBeTruthy();
    expect(screen.getByRole("form", { name: "队列过滤" })).toBeTruthy();
    expect(listReportQueueCampuses).toHaveBeenCalledWith({ global: false, campusIds: ["campus-1"] });
  });

  it("渲染队列行（状态/类型/scope/时限/领用人），不渲染 detail/handledNote/message content", async () => {
    mockReviewer();
    loadAuthorizedReportQueue.mockResolvedValue({
      items: [
        baseItem({
          status: "IN_REVIEW",
          overdue: true,
          assignedReviewer: "审核员甲",
        }),
      ],
      nextCursor: null,
    });
    listReportQueueCampuses.mockResolvedValue([]);

    const { container } = render(await GovernanceReportsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getAllByText("处理中").length).toBeGreaterThan(0);
    expect(screen.getAllByText("租赁").length).toBeGreaterThan(0);
    expect(screen.getByText("校区：主校区")).toBeTruthy();
    expect(screen.getByText("已超时")).toBeTruthy();
    expect(screen.getByText("领用人：审核员甲")).toBeTruthy();
    // 原因标签（filter 下拉 option 与行内 <p> 各一份）
    expect(screen.getAllByText("诈骗风险").length).toBe(2);
    expect(screen.getByText("目标：租赁：E2E 租赁物")).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看详情" }).getAttribute("href")).toBe(
      "/governance/reports/report-1",
    );
    // P01-P03 结构性最小面：队列绝不渲染 detail / handledNote / 消息内容
    expect(container.textContent).not.toContain("处理备注");
    expect(container.textContent).not.toContain("消息内容");
  });

  it("nextCursor 渲染翻页链接并保留 filter", async () => {
    mockReviewer({ global: true, campusIds: [] });
    loadAuthorizedReportQueue.mockResolvedValue({
      items: [baseItem()],
      nextCursor: "good-cursor",
    });
    listReportQueueCampuses.mockResolvedValue([{ id: "campus-1", name: "主校区" }]);

    render(
      await GovernanceReportsPage({
        searchParams: Promise.resolve({ status: "OPEN", targetType: "RENTAL_LISTING" }),
      }),
    );

    const next = screen.getByRole("link", { name: "下一页" });
    expect(next.getAttribute("href")).toContain("cursor=good-cursor");
    expect(next.getAttribute("href")).toContain("status=OPEN");
    expect(next.getAttribute("href")).toContain("targetType=RENTAL_LISTING");
  });

  it("畸形 cursor → 安全失败态（不渲染任何队列行）", async () => {
    mockReviewer();
    loadAuthorizedReportQueue.mockResolvedValue({ items: [], nextCursor: null });
    listReportQueueCampuses.mockResolvedValue([]);

    render(await GovernanceReportsPage({ searchParams: Promise.resolve({ cursor: "!!bad!!" }) }));

    expect(screen.getByText(/分页链接无效/)).toBeTruthy();
    expect(loadAuthorizedReportQueue).not.toHaveBeenCalled();
  });

  it("空串参数视同未提供（7D 教训：GET 空串不挂严格校验）", async () => {
    mockReviewer();
    loadAuthorizedReportQueue.mockResolvedValue({ items: [], nextCursor: null });
    listReportQueueCampuses.mockResolvedValue([]);

    render(
      await GovernanceReportsPage({
        searchParams: Promise.resolve({ campus: "", status: "", cursor: "" }),
      }),
    );

    expect(loadAuthorizedReportQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ campusId: undefined, status: undefined }),
      }),
    );
  });
});
