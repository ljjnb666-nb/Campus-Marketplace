import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireAdmin, getAdminServiceList, moderateListing } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getAdminServiceList: vi.fn(),
  moderateListing: vi.fn(),
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
  requireAdmin,
}));

vi.mock("@/repositories/admin-repository", () => ({
  getAdminServiceList,
}));

vi.mock("@/actions/admin", () => ({
  moderateListing,
}));

import AdminServicesPage from "@/app/admin/services/page";

afterEach(() => {
  cleanup();
});

describe("AdminServicesPage", () => {
  it("renders the empty state when there are no services", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getAdminServiceList.mockResolvedValue([]);

    render(await AdminServicesPage());

    expect(screen.getByRole("heading", { name: "服务管理" })).toBeTruthy();
    expect(screen.getByText("暂无待管理服务。")).toBeTruthy();
  });

  it("renders services with moderation actions", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getAdminServiceList.mockResolvedValue([
      {
        id: "service-1",
        title: "PPT 美化",
        description: "疑似重复发布，需要排查。",
        status: "ACTIVE",
        price: 88,
        pricingUnit: "PER_ORDER",
        category: { name: "设计制作" },
        provider: { name: "王同学" },
      },
    ]);

    render(await AdminServicesPage());

    expect(screen.getByText("PPT 美化")).toBeTruthy();
    expect(screen.getByText("疑似重复发布，需要排查。")).toBeTruthy();
    expect(screen.getByText("服务者：王同学")).toBeTruthy();
    expect(screen.getByText("分类：设计制作")).toBeTruthy();
    expect(screen.getByText("价格：￥88 / 每单")).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看详情" }).getAttribute("href")).toBe(
      "/services/service-1",
    );
    expect(screen.getByDisplayValue("SERVICE")).toBeTruthy();
    expect(screen.getByDisplayValue("service-1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "强制下架" })).toBeTruthy();
  });
});
