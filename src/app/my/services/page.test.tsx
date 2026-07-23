import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, getMyServices, deleteService } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getMyServices: vi.fn(),
  deleteService: vi.fn(),
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

vi.mock("@/repositories/service-repository", () => ({
  getMyServices,
}));

vi.mock("@/actions/service", () => ({
  deleteService,
}));

vi.mock("@/components/service/service-status-actions", () => ({
  ServiceStatusActions: ({
    serviceId,
    currentStatus,
  }: {
    serviceId: string;
    currentStatus: string;
  }) => (
    <div>
      <p>服务操作 {serviceId}</p>
      <p>当前状态 {currentStatus}</p>
    </div>
  ),
}));

import MyServicesPage from "@/app/my/services/page";

afterEach(() => {
  cleanup();
});

describe("MyServicesPage", () => {
  it("renders the empty state when there are no services", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getMyServices.mockResolvedValue([]);

    render(await MyServicesPage());

    expect(screen.getByRole("heading", { name: "我的服务" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "发布新服务" }).getAttribute("href")).toBe(
      "/services/new",
    );
    expect(screen.getByText("你还没有发布服务。")).toBeTruthy();
  });

  it("renders services with management actions", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getMyServices.mockResolvedValue([
      {
        id: "service-1",
        title: "PPT 美化",
        description: "支持答辩和课程汇报版式优化。",
        price: 88,
        pricingUnit: "PER_ORDER",
        completedOrderCount: 12,
        averageRating: 4.8,
        status: "ACTIVE",
        coverImageUrl: "/uploads/services/ppt.jpg",
        category: { name: "设计制作" },
        campus: { name: "主校区" },
      },
    ]);

    render(await MyServicesPage());

    expect(screen.getByText("PPT 美化")).toBeTruthy();
    expect(screen.getByText("支持答辩和课程汇报版式优化。")).toBeTruthy();
    expect(screen.getByText("价格：¥88 / 每单")).toBeTruthy();
    expect(screen.getByText("完成：12 单")).toBeTruthy();
    expect(screen.getByText("评分：4.8")).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看详情" }).getAttribute("href")).toBe(
      "/services/service-1",
    );
    expect(screen.getByRole("link", { name: "编辑" }).getAttribute("href")).toBe(
      "/services/service-1/edit",
    );
    expect(screen.getByDisplayValue("service-1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();
    expect(screen.getByText("服务操作 service-1")).toBeTruthy();
    expect(screen.getByText("当前状态 ACTIVE")).toBeTruthy();
  });
});
