import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  requireUser,
  getOrdersInvolvingUser,
  getMyRenterOrdersDetailed,
  getMyOwnerOrdersDetailed,
} = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getOrdersInvolvingUser: vi.fn(),
  getMyRenterOrdersDetailed: vi.fn(),
  getMyOwnerOrdersDetailed: vi.fn(),
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

vi.mock("@/repositories/order-repository", () => ({
  getOrdersInvolvingUser,
}));

vi.mock("@/repositories/rental-order-repository", () => ({
  getMyRenterOrdersDetailed,
  getMyOwnerOrdersDetailed,
}));

import MyOrdersPage from "@/app/my/orders/page";

afterEach(() => {
  cleanup();
});

describe("MyOrdersPage Unified Order Center Test Suite", () => {
  it("renders header, tab bar and empty state when user has no orders", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getOrdersInvolvingUser.mockResolvedValue({ orders: [], serverNow: Date.now() });
    getMyRenterOrdersDetailed.mockResolvedValue([]);
    getMyOwnerOrdersDetailed.mockResolvedValue([]);

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
    // PHASE 8B-01：{ orders, serverNow } 形状
    getOrdersInvolvingUser.mockResolvedValue({
      serverNow: Date.now(),
      orders: [
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
      ],
    });

    getMyRenterOrdersDetailed.mockResolvedValue([
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
    ]);
    getMyOwnerOrdersDetailed.mockResolvedValue([]);

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

  it("PHASE 8B-01：Product PENDING 显示确认截止；到期未 materialize 显示等待系统释放；CANCELLED+EXPIRED 显示预留超时释放", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });

    const serverNow = Date.parse("2026-10-01T00:00:00.000Z");
    getOrdersInvolvingUser.mockResolvedValue({
      serverNow,
      orders: [
        {
          id: "order-pending-live",
          orderNo: "PO202610010001",
          type: "PRODUCT",
          status: "PENDING",
          amount: "10.00",
          createdAt: new Date("2026-09-30T20:00:00.000Z"),
          buyerId: "user-1",
          sellerId: "user-2",
          buyer: { id: "user-1", name: "我自己", avatarUrl: null, schoolName: "示例大学" },
          seller: { id: "user-2", name: "未来卖家", avatarUrl: null, schoolName: "示例大学" },
          product: { id: "prod-live", title: "进行中预留商品", images: [] },
          errandTask: null,
          serviceListing: null,
          reviews: [],
          productReservationExpiresAt: new Date("2026-10-01T12:00:00.000Z"),
          productReservationResolution: null,
        },
        {
          id: "order-pending-overdue",
          orderNo: "PO202610010002",
          type: "PRODUCT",
          status: "PENDING",
          amount: "10.00",
          createdAt: new Date("2026-09-29T20:00:00.000Z"),
          buyerId: "user-1",
          sellerId: "user-2",
          buyer: { id: "user-1", name: "我自己", avatarUrl: null, schoolName: "示例大学" },
          seller: { id: "user-2", name: "未来卖家", avatarUrl: null, schoolName: "示例大学" },
          product: { id: "prod-overdue", title: "到期未释放商品", images: [] },
          errandTask: null,
          serviceListing: null,
          reviews: [],
          productReservationExpiresAt: new Date("2026-09-30T12:00:00.000Z"),
          productReservationResolution: null,
        },
        {
          id: "order-cancelled-expired",
          orderNo: "PO202610010003",
          type: "PRODUCT",
          status: "CANCELLED",
          amount: "10.00",
          createdAt: new Date("2026-09-28T20:00:00.000Z"),
          buyerId: "user-1",
          sellerId: "user-2",
          buyer: { id: "user-1", name: "我自己", avatarUrl: null, schoolName: "示例大学" },
          seller: { id: "user-2", name: "未来卖家", avatarUrl: null, schoolName: "示例大学" },
          product: { id: "prod-expired", title: "已超时释放商品", images: [] },
          errandTask: null,
          serviceListing: null,
          reviews: [],
          productReservationExpiresAt: new Date("2026-09-29T12:00:00.000Z"),
          productReservationResolution: "EXPIRED",
        },
      ],
    });
    getMyRenterOrdersDetailed.mockResolvedValue([]);
    getMyOwnerOrdersDetailed.mockResolvedValue([]);

    render(await MyOrdersPage({ searchParams: Promise.resolve({ type: "all" }) }));

    // 期限内：显示 seller 确认截止（§58）
    expect(screen.getByText(/卖家确认截止：/)).toBeTruthy();

    // 到期未 materialize：仅到期卡片显示"等待系统释放"（§59）
    expect(screen.getAllByText("预留已到期，等待系统释放")).toHaveLength(1);

    // CANCELLED + EXPIRED：显示"预留超时释放"（§60，不引入新 OrderStatus）
    expect(screen.getByText("预留超时释放")).toBeTruthy();
  });
});
