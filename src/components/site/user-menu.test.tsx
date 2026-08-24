import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock("next-auth/react", () => ({
  signOut,
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

import { UserMenu } from "@/components/site/user-menu";

const accountNavItems = [
  { href: "/my/products", label: "我的商品" },
  { href: "/my/orders", label: "我的订单" },
  { href: "/my/favorites", label: "我的收藏" },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderMenu(
  overrides: {
    user?: Record<string, unknown>;
    adminNavItems?: { href: string; label: string }[];
  } = {},
) {
  return render(
    <UserMenu
      user={{ id: "user-1", name: "李同学", role: "STUDENT", ...overrides.user }}
      adminNavItems={overrides.adminNavItems ?? []}
      accountNavItems={accountNavItems}
    />,
  );
}

describe("UserMenu", () => {
  it("shows the display name and avatar initial when no image", () => {
    renderMenu();

    expect(screen.getByText("李同学")).toBeInTheDocument();
    expect(screen.getByText("李")).toBeInTheDocument();
    // 下拉未打开
    expect(screen.queryByText("退出登录")).not.toBeInTheDocument();
  });

  it("opens the dropdown and lists account entries", () => {
    renderMenu();

    fireEvent.click(screen.getByRole("button", { name: /李同学/ }));

    expect(screen.getByText("个人服务中心")).toBeInTheDocument();
    expect(screen.getByText("我的商品")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /我的收藏/ })).toHaveAttribute(
      "href",
      "/my/favorites",
    );
    expect(screen.getByText("已认证学生")).toBeInTheDocument();
  });

  it("shows the admin section only for admins", () => {
    renderMenu({
      user: { role: "ADMIN" },
      adminNavItems: [{ href: "/admin", label: "后台总览" }],
    });

    fireEvent.click(screen.getByRole("button", { name: /李同学/ }));

    expect(screen.getByText("系统管理员")).toBeInTheDocument();
    expect(screen.getByText("系统管理后台")).toBeInTheDocument();
    expect(screen.getByText("后台总览")).toBeInTheDocument();
  });

  it("signs out with the login callback when clicked", () => {
    renderMenu();

    fireEvent.click(screen.getByRole("button", { name: /李同学/ }));
    fireEvent.click(screen.getByRole("button", { name: /退出登录/ }));

    expect(signOut).toHaveBeenCalledWith({ callbackUrl: "/login" });
  });

  it("falls back to a generic name for anonymous users", () => {
    renderMenu({ user: { name: null } });

    expect(screen.getAllByText("校园用户").length).toBeGreaterThan(0);
  });

  it("closes the dropdown when clicking outside", () => {
    renderMenu();

    fireEvent.click(screen.getByRole("button", { name: /李同学/ }));
    expect(screen.getByText("退出登录")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByText("退出登录")).not.toBeInTheDocument();
  });
});
