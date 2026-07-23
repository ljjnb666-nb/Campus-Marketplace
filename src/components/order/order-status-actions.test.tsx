import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OrderStatusActions } from "@/components/order/order-status-actions";

vi.mock("@/actions/order", () => ({
  updateOrderStatus: vi.fn(),
}));

describe("OrderStatusActions", () => {
  it("renders one form per available status action with hidden payload fields", () => {
    const { container } = render(
      <OrderStatusActions
        orderId="order-1"
        actions={[
          { status: "ACCEPTED", label: "确认售出" },
          { status: "CANCELLED", label: "拒绝订单" },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "确认售出" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "拒绝订单" })).toBeTruthy();
    expect(container.querySelectorAll("form")).toHaveLength(2);
    expect(container.querySelectorAll('input[name="orderId"][value="order-1"]')).toHaveLength(2);
    expect(container.querySelector('input[name="status"][value="ACCEPTED"]')).toBeTruthy();
    expect(container.querySelector('input[name="status"][value="CANCELLED"]')).toBeTruthy();
  });
});
