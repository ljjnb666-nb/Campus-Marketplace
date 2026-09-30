import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { initiateDispute, cancelRentalOrder, submitRentalReview } = vi.hoisted(() => ({
  initiateDispute: vi.fn(),
  cancelRentalOrder: vi.fn(),
  submitRentalReview: vi.fn(),
}));

vi.mock("@/actions/conversation", () => ({
  createOrOpenOrderConversation: vi.fn(),
}));
vi.mock("@/actions/order", () => ({
  updateOrderStatus: vi.fn(),
}));
vi.mock("@/actions/trust", () => ({
  createReview: vi.fn(),
}));
vi.mock("@/actions/rental-order", () => ({
  cancelRentalOrder,
  submitRentalReview,
  initiateDispute,
}));

import { OrderCardUnified, type UnifiedOrderData } from "@/components/order/order-card-unified";

/**
 * Phase 8C-01 §83：General（PRODUCT/SERVICE/ERRAND）订单不得渲染 dispute
 * 按钮——曾错误路由到 rental 专属 initiateDispute（rental-order-machine /
 * 押金语义）。RENTAL 行为保持不变；general 入口 8C-02 开放。
 */

function buildOrder(overrides: Partial<UnifiedOrderData>): UnifiedOrderData {
  return {
    id: "order-1",
    orderNo: "PO202610010001",
    type: "PRODUCT",
    status: "ACCEPTED",
    amount: "10.00",
    title: "测试订单",
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    counterparty: { id: "user-2", name: "对方" },
    userRole: "buyer",
    detailHref: "/products/p-1",
    ...overrides,
  };
}

describe("OrderCardUnified dispute 路由安全（PHASE 8C-01 §83）", () => {
  it("general order（PRODUCT）不渲染 发起申诉 按钮——绝不路由到 rental initiateDispute", () => {
    for (const status of ["ACCEPTED", "IN_PROGRESS", "PENDING"] as const) {
      const { unmount } = render(
        <OrderCardUnified order={buildOrder({ type: "PRODUCT", status })} />,
      );
      expect(screen.queryByRole("button", { name: "发起申诉" })).toBeNull();
      unmount();
    }

    const service = render(
      <OrderCardUnified order={buildOrder({ type: "SERVICE", status: "ACCEPTED" })} />,
    );
    expect(service.queryByRole("button", { name: "发起申诉" })).toBeNull();
    service.unmount();

    const errand = render(
      <OrderCardUnified
        order={buildOrder({ type: "ERRAND", status: "IN_PROGRESS", userRole: "publisher" })}
      />,
    );
    expect(errand.queryByRole("button", { name: "发起申诉" })).toBeNull();
    errand.unmount();

    expect(initiateDispute).not.toHaveBeenCalled();
  });

  it("RENTAL dispute 按钮保持原行为（可以进入 dispute dialog 路径）", () => {
    const rental = render(
      <OrderCardUnified
        order={buildOrder({
          type: "RENTAL",
          status: "PENDING_PICKUP",
          userRole: "renter",
          detailHref: "/rental-orders/r-1",
          depositAmount: "0",
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "发起申诉" })).toBeTruthy();
    rental.unmount();
  });

  it("IN_DISPUTE 状态不渲染 dispute 按钮（RENTAL 亦同）", () => {
    render(
      <OrderCardUnified
        order={buildOrder({
          type: "RENTAL",
          status: "IN_DISPUTE",
          userRole: "renter",
          detailHref: "/rental-orders/r-1",
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "发起申诉" })).toBeNull();
  });
});

describe("OrderStatusBadgeUnified：IN_DISPUTE / CLOSED 展示（§82）", () => {
  it("general 三类均渲染 纠纷处理中 / 已关闭 文案，未知状态回退原样不崩溃", async () => {
    const { OrderStatusBadgeUnified } = await import("@/components/order/order-status-badge-unified");

    for (const type of ["PRODUCT", "SERVICE", "ERRAND"] as const) {
      const { container, unmount } = render(
        <OrderStatusBadgeUnified type={type} status="IN_DISPUTE" />,
      );
      expect(container.textContent).toContain("纠纷处理中");
      unmount();

      const closed = render(<OrderStatusBadgeUnified type={type} status="CLOSED" />);
      expect(closed.container.textContent).toContain(type === "PRODUCT" ? "订单已关闭" : type === "ERRAND" ? "任务已关闭" : "服务订单已关闭");
      closed.unmount();
    }

    // unknown status → 原样展示，不崩溃（§82）
    const unknown = render(<OrderStatusBadgeUnified type="PRODUCT" status="FUTURE_STATUS" />);
    expect(unknown.container.textContent).toContain("FUTURE_STATUS");
    unknown.unmount();
  });
});
