import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  requireSupportAgent,
  loadAuthorizedSupportQueue,
  listSupportQueueCampuses,
  decodeSupportCursor,
} = vi.hoisted(() => ({
  requireSupportAgent: vi.fn(),
  loadAuthorizedSupportQueue: vi.fn(),
  listSupportQueueCampuses: vi.fn(),
  decodeSupportCursor: vi.fn(),
}));

vi.mock("@/lib/support/support-access", () => ({ requireSupportAgent }));
vi.mock("@/lib/support/support-query", () => ({
  loadAuthorizedSupportQueue,
  listSupportQueueCampuses,
  decodeSupportCursor,
  SUPPORT_QUEUE_DEFAULT_PAGE_SIZE: 25,
  SUPPORT_QUEUE_MAX_PAGE_SIZE: 50,
}));

import GovernanceSupportPage from "@/app/governance/support/page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockAgent() {
  requireSupportAgent.mockResolvedValue({
    user: { id: "agent-1", email: "a@x", name: "专员" },
    context: { userId: "agent-1", accountActive: true, activeCampusIds: [], grants: [] },
    access: { global: true, campusIds: [] },
  });
}

function baseItem(overrides: Record<string, unknown> = {}) {
  return {
    ticketId: "t1",
    status: "OPEN",
    category: "ACCOUNT",
    campusName: null,
    requesterName: "提交者甲",
    assignedAgent: null,
    subject: "无法登录",
    createdAt: new Date("2026-09-19T00:00:00.000Z").toISOString(),
    dueAt: new Date("2026-09-22T00:00:00.000Z").toISOString(),
    overdue: false,
    ...overrides,
  };
}

describe("GovernanceSupportPage（支持工单队列）", () => {
  it("渲染队列行（状态/类别/主题/时限 + 详情链接），UNSCOPED 显示无校区归属", async () => {
    mockAgent();
    loadAuthorizedSupportQueue.mockResolvedValue({ items: [baseItem()], nextCursor: null });
    listSupportQueueCampuses.mockResolvedValue([]);

    render(await GovernanceSupportPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("heading", { name: "支持工单" })).toBeVisible();
    expect(screen.getByText("主题：无法登录")).toBeVisible();
    expect(screen.getByText(/提交者甲/)).toBeVisible();
    expect(screen.getByText("无校区归属")).toBeVisible();
    expect(screen.getByRole("link", { name: "查看详情" })).toHaveAttribute(
      "href",
      "/governance/support/t1",
    );
    // queue privacy：description / internalNote 结构性不在队列
    expect(screen.queryByText(/internalNote/)).toBeNull();
  });

  it("overdue 徽标", async () => {
    mockAgent();
    loadAuthorizedSupportQueue.mockResolvedValue({
      items: [baseItem({ overdue: true })],
      nextCursor: null,
    });
    listSupportQueueCampuses.mockResolvedValue([]);
    render(await GovernanceSupportPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("已超时")).toBeVisible();
  });

  it("campus 工单行渲染校区名与领用人；GLOBAL 下拉含 active 校区", async () => {
    mockAgent();
    loadAuthorizedSupportQueue.mockResolvedValue({
      items: [
        baseItem({ campusName: "甲校区", assignedAgent: "专员乙", status: "IN_PROGRESS", category: "VERIFICATION" }),
      ],
      nextCursor: null,
    });
    listSupportQueueCampuses.mockResolvedValue([{ id: "A", name: "甲校区" }]);

    render(await GovernanceSupportPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("校区：甲校区")).toBeVisible();
    expect(screen.getByText("领用人：专员乙")).toBeVisible();
    expect(screen.getAllByText("处理中").length).toBeGreaterThan(0);
    expect(screen.getByRole("option", { name: "甲校区" })).toBeVisible();
  });

  it("nextCursor → 下一页链接保留过滤参数", async () => {
    mockAgent();
    loadAuthorizedSupportQueue.mockResolvedValue({ items: [baseItem()], nextCursor: "sup-1" });
    listSupportQueueCampuses.mockResolvedValue([]);

    render(
      await GovernanceSupportPage({
        searchParams: Promise.resolve({ status: "OPEN", overdue: "1", limit: "50" }),
      }),
    );

    const next = screen.getByRole("link", { name: "下一页" });
    expect(next.getAttribute("href")).toContain("cursor=sup-1");
    expect(next.getAttribute("href")).toContain("status=OPEN");
    expect(next.getAttribute("href")).toContain("overdue=1");
  });

  it("非法 limit 回退默认（查询继续执行）", async () => {
    mockAgent();
    loadAuthorizedSupportQueue.mockResolvedValue({ items: [], nextCursor: null });
    listSupportQueueCampuses.mockResolvedValue([]);

    render(await GovernanceSupportPage({ searchParams: Promise.resolve({ limit: "999" }) }));

    expect(screen.getByText("当前没有符合条件的工单。")).toBeVisible();
    expect(loadAuthorizedSupportQueue).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25 }),
    );
  });

  it("空队列渲染空态", async () => {
    mockAgent();
    loadAuthorizedSupportQueue.mockResolvedValue({ items: [], nextCursor: null });
    listSupportQueueCampuses.mockResolvedValue([]);
    render(await GovernanceSupportPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("当前没有符合条件的工单。")).toBeVisible();
  });

  it("畸形 cursor → 安全失败态（不渲染任何队列行）", async () => {
    mockAgent();
    decodeSupportCursor.mockReturnValue(null);
    render(await GovernanceSupportPage({
      searchParams: Promise.resolve({ cursor: "bad" }),
    }));
    expect(screen.getByText(/分页链接无效/)).toBeVisible();
    expect(loadAuthorizedSupportQueue).not.toHaveBeenCalled();
  });
});
