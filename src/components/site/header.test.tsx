import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { auth } = vi.hoisted(() => ({
  auth: vi.fn(),
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

vi.mock("@/lib/auth", () => ({
  auth,
}));

vi.mock("@/components/auth/sign-out-button", () => ({
  SignOutButton: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => (
    <button type="button" className={className}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/site/header-live-status", () => ({
  HeaderLiveStatus: ({
    initialMessageCount,
    initialNotificationCount,
  }: {
    initialMessageCount: number;
    initialNotificationCount: number;
  }) => (
    <div>
      会话 {initialMessageCount} / 通知 {initialNotificationCount}
    </div>
  ),
}));

vi.mock("@/components/site/user-menu", () => ({
  UserMenu: ({
    user,
    adminNavItems,
    accountNavItems,
  }: {
    user: { id: string; name: string; role: string };
    adminNavItems: Array<{ href: string; label: string }>;
    accountNavItems: Array<{ href: string; label: string }>;
  }) => (
    <div>
      <span>{user.name} · {user.role === "ADMIN" ? "管理员" : "学生"}</span>
      <button type="button">退出</button>
      {adminNavItems.map((item) => (
        <a key={item.href} href={item.href}>{item.label}</a>
      ))}
      {accountNavItems.map((item) => (
        <a key={item.href} href={item.href}>{item.label}</a>
      ))}
    </div>
  ),
}));

import { SiteHeader } from "@/components/site/header";

describe("SiteHeader", () => {
  it("renders guest navigation when the user is not logged in", async () => {
    auth.mockResolvedValue(null);

    render(await SiteHeader({}));

    expect(screen.getByRole("link", { name: "登录" }).getAttribute("href")).toBe("/login");
    expect(screen.getByRole("link", { name: "注册" }).getAttribute("href")).toBe("/register");
    expect(screen.getAllByRole("link", { name: "二手商品" })[0].getAttribute("href")).toBe("/products");
    expect(screen.queryByRole("link", { name: "我的商品" })).toBeNull();
    expect(screen.queryByRole("link", { name: "我的任务" })).toBeNull();
    expect(screen.queryByRole("link", { name: "我的订单" })).toBeNull();
    expect(screen.queryByRole("link", { name: "个人中心" })).toBeNull();
    expect(screen.queryByText(/会话/)).toBeNull();
  });

  it("renders admin navigation and live counts for an authenticated admin", async () => {
    auth.mockResolvedValue({
      user: {
        id: "admin-1",
        name: "平台管理员",
        role: "ADMIN",
      },
    });
    render(
      await SiteHeader({
        unreadNotificationCount: 6,
        unreadConversationCount: 4,
      }),
    );

    expect(screen.getByText("平台管理员 · 管理员")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "后台总览" })[0]?.getAttribute("href")).toBe(
      "/admin",
    );
    expect(screen.getAllByRole("link", { name: "认证审核" })[0]?.getAttribute("href")).toBe(
      "/admin/verifications",
    );
    expect(screen.getByRole("link", { name: "我的商品" }).getAttribute("href")).toBe(
      "/my/products",
    );
    expect(screen.getByRole("link", { name: "我的任务" }).getAttribute("href")).toBe(
      "/my/errands",
    );
    expect(screen.getByRole("link", { name: "我的订单" }).getAttribute("href")).toBe(
      "/my/orders",
    );
    expect(screen.getByRole("link", { name: "个人中心" }).getAttribute("href")).toBe(
      "/profile",
    );
    expect(screen.getByText("会话 4 / 通知 6")).toBeTruthy();
    expect(screen.getByRole("button", { name: "退出" })).toBeTruthy();
  });
});
