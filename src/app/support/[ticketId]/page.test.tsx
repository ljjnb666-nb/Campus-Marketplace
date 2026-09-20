import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, loadOwnSupportTicket } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  loadOwnSupportTicket: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({ requireUser }));
vi.mock("@/lib/support/support-service", () => ({ loadOwnSupportTicket }));

import SupportTicketDetailPage from "@/app/support/[ticketId]/page";

const notFound = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ notFound }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function ownTicketFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    category: "ACCOUNT",
    status: "RESOLVED",
    subject: "无法登录",
    description: "登录一直失败的完整描述。",
    campusName: "甲校区",
    createdAt: new Date("2026-09-19T00:00:00.000Z"),
    dueAt: new Date("2026-09-22T00:00:00.000Z"),
    overdue: false,
    resolution: {
      code: "ANSWERED",
      message: "已为你重置密码入口",
      resolvedAt: new Date("2026-09-19T12:00:00.000Z"),
    },
    ...overrides,
  };
}

describe("SupportTicketDetailPage（requester 读模型）", () => {
  it("非本人 / 不存在 → notFound", async () => {
    requireUser.mockResolvedValue({ id: "u1" });
    loadOwnSupportTicket.mockResolvedValue(null);
    notFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });

    await expect(
      SupportTicketDetailPage({ params: Promise.resolve({ ticketId: "t1" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("渲染描述与 USER_VISIBLE resolutionMessage", async () => {
    requireUser.mockResolvedValue({ id: "u1" });
    loadOwnSupportTicket.mockResolvedValue(ownTicketFixture());

    render(await SupportTicketDetailPage({ params: Promise.resolve({ ticketId: "t1" }) }));

    expect(screen.getByText("主题：无法登录")).toBeVisible();
    expect(screen.getByText("登录一直失败的完整描述。")).toBeVisible();
    expect(screen.getByText(/已为你重置密码入口/)).toBeVisible();
    expect(screen.getByText("已解决")).toBeVisible();
  });

  it("未终局工单不渲染处理结果区", async () => {
    requireUser.mockResolvedValue({ id: "u1" });
    loadOwnSupportTicket.mockResolvedValue(
      ownTicketFixture({ status: "OPEN", resolution: null }),
    );

    render(await SupportTicketDetailPage({ params: Promise.resolve({ ticketId: "t1" }) }));

    expect(screen.queryByText("处理结果")).toBeNull();
    expect(screen.getByText("待处理")).toBeVisible();
  });
});
