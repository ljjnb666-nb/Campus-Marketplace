import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const {
  requireUser,
  getNotificationsForUser,
  getUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead,
} = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getNotificationsForUser: vi.fn(),
  getUnreadNotificationCount: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  markNotificationRead: vi.fn(),
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

vi.mock("@/repositories/notification-repository", () => ({
  getNotificationsForUser,
  getUnreadNotificationCount,
}));

vi.mock("@/actions/notification", () => ({
  markAllNotificationsRead,
  markNotificationRead,
}));

vi.mock("@/components/site/page-auto-refresh", () => ({
  PageAutoRefresh: ({ intervalMs }: { intervalMs: number }) => (
    <div>自动刷新 {intervalMs}</div>
  ),
}));

import NotificationsPage from "@/app/notifications/page";

describe("NotificationsPage", () => {
  it("renders the empty state when there are no notifications", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getNotificationsForUser.mockResolvedValue([]);
    getUnreadNotificationCount.mockResolvedValue(0);

    render(await NotificationsPage());

    expect(screen.getByText("系统与通知中心")).toBeTruthy();
    expect(screen.getByText("暂无任何通知")).toBeTruthy();
  });

  it("renders unread and read notifications", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getUnreadNotificationCount.mockResolvedValue(1);
    getNotificationsForUser.mockResolvedValue([
      {
        id: "notification-1",
        title: "订单状态更新",
        content: "你的教材订单已完成，请及时评价。",
        createdAt: new Date("2026-07-18T08:30:00.000Z"),
        isRead: false,
      },
      {
        id: "notification-2",
        title: "认证审核结果",
        content: "你的校园认证已通过。",
        createdAt: new Date("2026-07-18T09:00:00.000Z"),
        isRead: true,
      },
    ]);

    render(await NotificationsPage());

    expect(screen.getByText("订单状态更新")).toBeTruthy();
    expect(screen.getByText("你的教材订单已完成，请及时评价。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "标记已读" })).toBeTruthy();
    expect(screen.getByDisplayValue("notification-1")).toBeTruthy();
    expect(screen.getByText("认证审核结果")).toBeTruthy();
    expect(screen.getByText("你的校园认证已通过。")).toBeTruthy();
  });
});
