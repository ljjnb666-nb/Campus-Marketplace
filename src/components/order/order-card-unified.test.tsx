import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  initiateDispute,
  initiateGeneralOrderDispute,
  cancelRentalOrder,
  submitRentalReview,
} = vi.hoisted(() => ({
  initiateDispute: vi.fn(),
  initiateGeneralOrderDispute: vi.fn(),
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
vi.mock("@/actions/order-dispute", () => ({
  initiateGeneralOrderDispute,
}));

import { OrderCardUnified, type UnifiedOrderData } from "@/components/order/order-card-unified";

/**
 * Phase 8C-02：General（PRODUCT/SERVICE/ERRAND）dispute 用户入口重新开放，
 * 且必须显式路由到 canonical initiateGeneralOrderDispute；RENTAL 保持原
 * initiateDispute 行为不变（禁止 General 回落 Rental action）。
 *
 * 指令 §56 可见性矩阵 + §19 显式分发；UI predicate 只是展示便利，
 * canonical domain（initiateOrderDisputeTx 锁内 fresh check）恒为最终裁决。
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

const REASON = "商品与描述不符，要求平台处理";

async function openDisputeAndSubmit() {
  fireEvent.click(screen.getByRole("button", { name: "发起申诉" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: REASON } });
  fireEvent.click(screen.getByRole("button", { name: "提交申诉" }));
  await waitFor(() => {
    expect(
      initiateGeneralOrderDispute.mock.calls.length + initiateDispute.mock.calls.length,
    ).toBeGreaterThan(0);
  });
}

describe("OrderCardUnified：general dispute 可见性矩阵（§56）", () => {
  afterEach(() => {
    cleanup();
    initiateGeneralOrderDispute.mockReset();
    initiateDispute.mockReset();
  });

  it("PRODUCT ACCEPTED / COMPLETED → 可见；PENDING / IN_DISPUTE / CANCELLED / REFUNDED / CLOSED → 隐藏", () => {
    const visible: string[] = ["ACCEPTED", "COMPLETED"];
    const hidden: string[] = ["PENDING", "IN_DISPUTE", "CANCELLED", "REFUNDED", "CLOSED"];

    for (const status of visible) {
      const { unmount } = render(<OrderCardUnified order={buildOrder({ type: "PRODUCT", status })} />);
      expect(screen.getByRole("button", { name: "发起申诉" })).toBeTruthy();
      unmount();
    }
    for (const status of hidden) {
      const { unmount } = render(<OrderCardUnified order={buildOrder({ type: "PRODUCT", status })} />);
      expect(screen.queryByRole("button", { name: "发起申诉" })).toBeNull();
      unmount();
    }
  });

  it("SERVICE ACCEPTED / IN_PROGRESS / COMPLETED → 可见；PENDING / IN_DISPUTE / CLOSED → 隐藏", () => {
    for (const status of ["ACCEPTED", "IN_PROGRESS", "COMPLETED"] as const) {
      const { unmount } = render(<OrderCardUnified order={buildOrder({ type: "SERVICE", status })} />);
      expect(screen.getByRole("button", { name: "发起申诉" })).toBeTruthy();
      unmount();
    }
    for (const status of ["PENDING", "IN_DISPUTE", "CLOSED"] as const) {
      const { unmount } = render(<OrderCardUnified order={buildOrder({ type: "SERVICE", status })} />);
      expect(screen.queryByRole("button", { name: "发起申诉" })).toBeNull();
      unmount();
    }
  });

  it("ERRAND canonical pairs → 可见；malformed pair / 缺 errandStatus → 隐藏", () => {
    const canonicalPairs: Array<[string, string]> = [
      ["ACCEPTED", "CLAIMED"],
      ["IN_PROGRESS", "IN_PROGRESS"],
      ["IN_PROGRESS", "PENDING_CONFIRMATION"],
      ["COMPLETED", "COMPLETED"],
    ];
    for (const [orderStatus, errandStatus] of canonicalPairs) {
      const { unmount } = render(
        <OrderCardUnified
          order={buildOrder({ type: "ERRAND", status: orderStatus, errandStatus, userRole: "publisher" })}
        />,
      );
      expect(screen.getByRole("button", { name: "发起申诉" })).toBeTruthy();
      unmount();
    }

    // malformed pair：不能仅看 Order.status
    for (const [orderStatus, errandStatus] of [
      ["ACCEPTED", "COMPLETED"],
      ["IN_PROGRESS", "CLAIMED"],
      ["COMPLETED", "PENDING_CONFIRMATION"],
      ["PENDING", "CLAIMED"],
    ] as Array<[string, string]>) {
      const { unmount } = render(
        <OrderCardUnified
          order={buildOrder({ type: "ERRAND", status: orderStatus, errandStatus, userRole: "publisher" })}
        />,
      );
      expect(screen.queryByRole("button", { name: "发起申诉" })).toBeNull();
      unmount();
    }

    // 缺失 errandStatus → hidden（不能仅凭 Order.status 判定）
    const missing = render(
      <OrderCardUnified order={buildOrder({ type: "ERRAND", status: "ACCEPTED", errandStatus: null })} />,
    );
    expect(missing.queryByRole("button", { name: "发起申诉" })).toBeNull();
    missing.unmount();
  });

  it("RENTAL 原行为保持不变（8C-01 收窄前的 predicate）", () => {
    for (const status of ["PENDING_APPROVAL", "PENDING_PICKUP", "ACCEPTED", "IN_PROGRESS"] as const) {
      const { unmount } = render(
        <OrderCardUnified
          order={buildOrder({ type: "RENTAL", status, userRole: "renter", detailHref: "/rental-orders/r-1" })}
        />,
      );
      expect(screen.getByRole("button", { name: "发起申诉" })).toBeTruthy();
      unmount();
    }
    for (const status of ["IN_DISPUTE", "CANCELLED", "COMPLETED", "REJECTED"] as const) {
      const { unmount } = render(
        <OrderCardUnified
          order={buildOrder({ type: "RENTAL", status, userRole: "renter", detailHref: "/rental-orders/r-1" })}
        />,
      );
      expect(screen.queryByRole("button", { name: "发起申诉" })).toBeNull();
      unmount();
    }
  });
});

describe("OrderCardUnified：dispute action 显式分发（§19）", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    initiateGeneralOrderDispute.mockReset();
    initiateDispute.mockReset();
  });

  it("PRODUCT dispute → initiateGeneralOrderDispute（绝不回落 Rental action）", async () => {
    initiateGeneralOrderDispute.mockResolvedValue({ success: true, message: "ok" });
    vi.stubGlobal("location", { ...window.location, reload: vi.fn() });

    render(<OrderCardUnified order={buildOrder({ type: "PRODUCT", status: "ACCEPTED" })} />);
    await openDisputeAndSubmit();

    expect(initiateGeneralOrderDispute).toHaveBeenCalledTimes(1);
    const fd = initiateGeneralOrderDispute.mock.calls[0][0] as FormData;
    expect(fd.get("orderId")).toBe("order-1");
    expect(fd.get("reason")).toBe(REASON);
    expect(initiateDispute).not.toHaveBeenCalled();
  });

  it("ERRAND dispute → initiateGeneralOrderDispute", async () => {
    initiateGeneralOrderDispute.mockResolvedValue({ success: true, message: "ok" });
    vi.stubGlobal("location", { ...window.location, reload: vi.fn() });

    render(
      <OrderCardUnified
        order={buildOrder({
          type: "ERRAND",
          status: "IN_PROGRESS",
          errandStatus: "PENDING_CONFIRMATION",
          userRole: "publisher",
        })}
      />,
    );
    await openDisputeAndSubmit();

    expect(initiateGeneralOrderDispute).toHaveBeenCalledTimes(1);
    expect(initiateDispute).not.toHaveBeenCalled();
  });

  it("RENTAL dispute → 既有 rental initiateDispute（行为不变）", async () => {
    initiateDispute.mockResolvedValue({ success: true, message: "ok" });
    vi.stubGlobal("location", { ...window.location, reload: vi.fn() });

    render(
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
    await openDisputeAndSubmit();

    expect(initiateDispute).toHaveBeenCalledTimes(1);
    expect(initiateGeneralOrderDispute).not.toHaveBeenCalled();
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
