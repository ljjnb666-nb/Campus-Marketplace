import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireUser, prisma } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  prisma: {
    order: {
      findMany: vi.fn(),
    },
    rentalOrder: {
      findMany: vi.fn(),
    },
  },
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

vi.mock("@/lib/prisma", () => ({
  prisma,
}));

import MyOrdersPage from "@/app/my/orders/page";

afterEach(() => {
  cleanup();
});

describe("MyOrdersPage Unified Order Center Test Suite", () => {
  it("renders header, tab bar and empty state when user has no orders", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    prisma.order.findMany.mockResolvedValue([]);
    prisma.rentalOrder.findMany.mockResolvedValue([]);

    render(await MyOrdersPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole("heading", { name: "统一订单中心" })).toBeTruthy();
    expect(screen.getByText("一站式管理二手买卖、跑腿代办、技能服务与物品租赁订单")).toBeTruthy();
    expect(screen.getByText("全部订单")).toBeTruthy();
    expect(screen.getByText("二手商品")).toBeTruthy();
    expect(screen.getByText("跑腿求助")).toBeTruthy();
    expect(screen.getByText("技能服务")).toBeTruthy();
    expect(screen.getByText("我的租用")).toBeTruthy();
    expect(screen.getByText("我的出租")).toBeTruthy();
    expect(screen.getByText("暂无相关订单记录")).toBeTruthy();
  });

  it("renders product, errand, service and rental orders with price snapshot, counterparty and correct detail links", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });

    // Mock 综合订单数据
    prisma.order.findMany.mockResolvedValue([
      {
        id: "order-product-1",
        orderNo: "PO202607190001",
        type: "PRODUCT",
        status: "ACCEPTED",
        paymentStatus: "PAID",
        amount: "199.00",
        meetingLocation: "图书馆门口",
        note: "请附带说明书",
        createdAt: new Date("2026-07-19T08:00:00.000Z"),
        buyerId: "user-1",
        sellerId: "user-2",
        buyer: { id: "user-1", name: "我自己", avatarUrl: null, schoolName: "示例大学" },
        seller: { id: "user-2", name: "张同学", avatarUrl: null, schoolName: "示例大学" },
        product: { id: "prod-1", title: "二手降噪耳机", images: [{ url: "/headphones.jpg" }] },
        errandTask: null,
        serviceListing: null,
        reviews: [],
      },
      {
        id: "order-errand-1",
        orderNo: "EO202607190002",
        type: "ERRAND",
        status: "PENDING_CONFIRMATION",
        paymentStatus: "UNPAID",
        amount: "15.00",
        meetingLocation: "北区宿舍楼下",
        note: "帮取加重快递",
        createdAt: new Date("2026-07-19T09:00:00.000Z"),
        buyerId: "user-1",
        sellerId: "user-3",
        buyer: { id: "user-1", name: "我自己", avatarUrl: null, schoolName: "示例大学" },
        seller: { id: "user-3", name: "李同学", avatarUrl: null, schoolName: "示例大学" },
        product: null,
        errandTask: { id: "errand-1", title: "代取加重快递" },
        serviceListing: null,
        reviews: [],
      },
    ]);

    prisma.rentalOrder.findMany
      .mockResolvedValueOnce([
        {
          id: "rental-order-1",
          orderNumber: "RT202607190003",
          status: "IN_RENTAL",
          finalAmount: "120.00",
          depositAmount: "500.00",
          rentalListingId: "rental-1",
          rentalListing: { title: "索尼单反相机", images: [{ url: "/camera.jpg" }] },
          pickupLocationSnapshot: "实验楼二楼",
          createdAt: new Date("2026-07-19T10:00:00.000Z"),
          owner: { id: "user-4", name: "王出租者", avatarUrl: null, schoolName: "示例大学" },
          reviews: [],
        },
      ])
      .mockResolvedValueOnce([]);

    render(await MyOrdersPage({ searchParams: Promise.resolve({ type: "all" }) }));

    // 验证订单标题渲染
    expect(screen.getByText("二手降噪耳机")).toBeTruthy();
    expect(screen.getByText("代取加重快递")).toBeTruthy();
    expect(screen.getByText("索尼单反相机")).toBeTruthy();

    // 验证交易对方
    expect(screen.getByText("张同学")).toBeTruthy();
    expect(screen.getByText("李同学")).toBeTruthy();
    expect(screen.getByText("王出租者")).toBeTruthy();

    // 验证金额快照与押金展示
    expect(screen.getAllByText(/199\.00/)[0]).toBeTruthy();
    expect(screen.getAllByText(/15\.00/)[0]).toBeTruthy();
    expect(screen.getAllByText(/120\.00/)[0]).toBeTruthy();
    expect(screen.getByText((content) => content.includes("500"))).toBeTruthy();

    // 验证导航链接
    const links = screen.getAllByRole("link", { name: /查看详情/ });
    expect(links[0].getAttribute("href")).toBe("/rental-orders/rental-order-1");
    expect(links[1].getAttribute("href")).toBe("/errands/errand-1");
    expect(links[2].getAttribute("href")).toBe("/products/prod-1");
  });
});
