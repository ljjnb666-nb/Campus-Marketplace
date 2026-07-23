import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

import NotFound from "@/app/not-found";

describe("NotFound", () => {
  it("renders recovery links for stale or deleted content", () => {
    render(<NotFound />);

    expect(screen.getByRole("heading", { name: "页面不存在" })).toBeTruthy();
    expect(screen.getByText(/链接可能已经失效/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "回到首页" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "浏览二手商品" }).getAttribute("href")).toBe(
      "/products",
    );
    expect(screen.getByRole("link", { name: "进入个人中心" }).getAttribute("href")).toBe(
      "/profile",
    );
  });
});
