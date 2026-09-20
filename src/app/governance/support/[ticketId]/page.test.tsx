import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireSupportAgent, loadAuthorizedSupportDetail } = vi.hoisted(() => ({
  requireSupportAgent: vi.fn(),
  loadAuthorizedSupportDetail: vi.fn(),
}));

vi.mock("@/lib/support/support-access", () => ({ requireSupportAgent }));
vi.mock("@/lib/support/support-query", () => ({
  loadAuthorizedSupportDetail,
  SUPPORT_QUEUE_DEFAULT_PAGE_SIZE: 25,
  SUPPORT_QUEUE_MAX_PAGE_SIZE: 50,
}));

import GovernanceSupportTicketDetailPage from "@/app/governance/support/[ticketId]/page";

const notFound = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ notFound }));

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

function detailFixture(overrides: Record<string, unknown> = {}) {
  return {
    ticketId: "t1",
    status: "OPEN",
    category: "ACCOUNT",
    campusName: null,
    requesterName: "提交者甲",
    subject: "无法登录",
    description: "登录一直失败的完整描述。",
    internalNote: "疑似钓鱼，需回访",
    createdAt: new Date("2026-09-19T00:00:00.000Z").toISOString(),
    dueAt: new Date("2026-09-22T00:00:00.000Z").toISOString(),
    overdue: false,
    assignedAgent: null,
    selfAssigned: false,
    resolution: { code: null, message: null, resolvedAt: null, resolvedByName: null },
    scopeAuthorized: true,
    ...overrides,
  };
}

describe("GovernanceSupportTicketDetailPage（两阶段详情）", () => {
  it("ok=false → notFound", async () => {
    mockAgent();
    loadAuthorizedSupportDetail.mockResolvedValue({ ok: false });
    notFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });

    await expect(
      GovernanceSupportTicketDetailPage({ params: Promise.resolve({ ticketId: "t1" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("active：渲染 description + internalNote（OPERATOR_ONLY）+ 处理控件", async () => {
    mockAgent();
    loadAuthorizedSupportDetail.mockResolvedValue({ ok: true, detail: detailFixture() });

    render(await GovernanceSupportTicketDetailPage({ params: Promise.resolve({ ticketId: "t1" }) }));

    expect(screen.getByText("登录一直失败的完整描述。")).toBeVisible();
    expect(screen.getByText("疑似钓鱼，需回访")).toBeVisible();
    expect(screen.getByRole("form", { name: "领用工单" })).toBeVisible();
    expect(screen.getByRole("form", { name: "解决工单" })).toBeVisible();
    expect(screen.getByRole("form", { name: "关闭工单" })).toBeVisible();
  });

  it("terminal：渲染处理结果（含 USER_VISIBLE message），零处理控件", async () => {
    mockAgent();
    loadAuthorizedSupportDetail.mockResolvedValue({
      ok: true,
      detail: detailFixture({
        status: "RESOLVED",
        resolution: {
          code: "ANSWERED",
          message: "已为你重置密码入口",
          resolvedAt: new Date("2026-09-19T12:00:00.000Z").toISOString(),
          resolvedByName: "专员",
        },
      }),
    });

    render(await GovernanceSupportTicketDetailPage({ params: Promise.resolve({ ticketId: "t1" }) }));

    expect(screen.getByText(/已为你重置密码入口/)).toBeVisible();
    expect(screen.queryByRole("form", { name: "解决工单" })).toBeNull();
    expect(screen.queryByRole("form", { name: "关闭工单" })).toBeNull();
  });
});
