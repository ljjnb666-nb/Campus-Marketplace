import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  requireDisputeReviewer,
  loadAuthorizedDisputeQueue,
  listDisputeQueueCampuses,
  decodeDisputeCursor,
} = vi.hoisted(() => ({
  requireDisputeReviewer: vi.fn(),
  loadAuthorizedDisputeQueue: vi.fn(),
  listDisputeQueueCampuses: vi.fn(),
  decodeDisputeCursor: vi.fn(),
}));

vi.mock("@/lib/disputes/dispute-access", () => ({ requireDisputeReviewer }));
vi.mock("@/lib/disputes/dispute-query", () => ({
  loadAuthorizedDisputeQueue,
  listDisputeQueueCampuses,
  decodeDisputeCursor,
  DISPUTE_QUEUE_DEFAULT_PAGE_SIZE: 25,
  DISPUTE_QUEUE_MAX_PAGE_SIZE: 50,
}));

import GovernanceDisputesPage from "@/app/governance/disputes/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockReviewer() {
  requireDisputeReviewer.mockResolvedValue({
    user: { id: "viewer-1", email: "r@x", name: "审核员" },
    context: { userId: "viewer-1", accountActive: true, activeCampusIds: ["A"], grants: [] },
    access: { global: false, campusIds: ["A"] },
  });
}

function baseItem(overrides: Record<string, unknown> = {}) {
  return {
    disputeId: "dispute-1",
    status: "OPEN",
    campusId: "A",
    campusName: "甲校区",
    safeOrderLabel: "订单 RO-1 · 投影仪",
    initiatorName: "发起人甲",
    assignedReviewer: null,
    createdAt: new Date("2026-09-19T00:00:00.000Z").toISOString(),
    dueAt: new Date("2026-09-21T00:00:00.000Z").toISOString(),
    overdue: false,
    ...overrides,
  };
}

describe("GovernanceDisputesPage（纠纷运营队列）", () => {
  it("渲染队列行（状态/校区/订单摘要/时限 + 详情链接），不渲染机密面", async () => {
    mockReviewer();
    loadAuthorizedDisputeQueue.mockResolvedValue({ items: [baseItem()], nextCursor: null });
    listDisputeQueueCampuses.mockResolvedValue([{ id: "A", name: "甲校区" }]);

    render(await GovernanceDisputesPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("heading", { name: "纠纷处理" })).toBeVisible();
    expect(screen.getByText(/订单 RO-1 · 投影仪/)).toBeVisible();
    expect(screen.getByText(/发起人甲/)).toBeVisible();
    expect(screen.getAllByText("待处理").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "查看详情" })).toHaveAttribute(
      "href",
      "/governance/disputes/dispute-1",
    );
    // 机密面结构性不在队列 DTO（queue privacy 冻结）
    expect(screen.queryByText(/纠纷描述/)).toBeNull();
  });

  it("overdue 行渲染已超时徽标；领用人展示", async () => {
    mockReviewer();
    loadAuthorizedDisputeQueue.mockResolvedValue({
      items: [baseItem({ overdue: true, assignedReviewer: "审核员乙" })],
      nextCursor: null,
    });
    listDisputeQueueCampuses.mockResolvedValue([]);

    render(await GovernanceDisputesPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("已超时")).toBeVisible();
    expect(screen.getByText("领用人：审核员乙")).toBeVisible();
  });

  it("空队列渲染空态", async () => {
    mockReviewer();
    loadAuthorizedDisputeQueue.mockResolvedValue({ items: [], nextCursor: null });
    listDisputeQueueCampuses.mockResolvedValue([]);

    render(await GovernanceDisputesPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("当前没有符合条件的纠纷。")).toBeVisible();
  });

  it("campus 过滤下拉由授权派生；非法 limit 回退默认", async () => {
    mockReviewer();
    loadAuthorizedDisputeQueue.mockResolvedValue({ items: [], nextCursor: null });
    listDisputeQueueCampuses.mockResolvedValue([{ id: "A", name: "甲校区" }]);

    render(await GovernanceDisputesPage({ searchParams: Promise.resolve({ limit: "0" }) }));

    expect(screen.getByRole("option", { name: "甲校区" })).toBeVisible();
    expect(loadAuthorizedDisputeQueue).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25 }),
    );
  });

  it("畸形 cursor → 安全失败态（不渲染任何队列行）", async () => {
    mockReviewer();
    decodeDisputeCursor.mockReturnValue(null);

    render(
      await GovernanceDisputesPage({
        searchParams: Promise.resolve({ cursor: "broken-cursor" }),
      }),
    );

    expect(screen.getByText(/分页链接无效/)).toBeVisible();
    expect(loadAuthorizedDisputeQueue).not.toHaveBeenCalled();
  });

  it("有 nextCursor → 渲染下一页链接（保留过滤参数）", async () => {
    mockReviewer();
    loadAuthorizedDisputeQueue.mockResolvedValue({ items: [baseItem()], nextCursor: "cur-1" });
    listDisputeQueueCampuses.mockResolvedValue([]);

    render(
      await GovernanceDisputesPage({ searchParams: Promise.resolve({ status: "OPEN" }) }),
    );

    const next = screen.getByRole("link", { name: "下一页" });
    expect(next.getAttribute("href")).toContain("cursor=cur-1");
    expect(next.getAttribute("href")).toContain("status=OPEN");
  });
});
