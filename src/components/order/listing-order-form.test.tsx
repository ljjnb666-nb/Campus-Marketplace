import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ListingOrderForm } from "@/components/order/listing-order-form";

const { mockPush, mockRefresh, mockUseActionState } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
  mockUseActionState: vi.fn(),
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");

  return {
    ...actual,
    useActionState: mockUseActionState,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: mockRefresh,
  }),
}));

beforeEach(() => {
  mockPush.mockReset();
  mockRefresh.mockReset();
  mockUseActionState.mockReset();
  mockUseActionState.mockReturnValue([{ success: false, message: "" }, vi.fn()]);
});

afterEach(() => {
  cleanup();
});

describe("ListingOrderForm", () => {
  it("renders hidden target id, defaults, and placeholders", () => {
    render(
      <ListingOrderForm
        action={async () => ({ success: false, message: "" })}
        targetFieldName="productId"
        targetId="product-1"
        title="发起购买"
        description="确认见面地点和备注后即可下单。"
        submitLabel="确认购买"
        defaultMeetingLocation="图书馆一楼大厅"
        notePlaceholder="补充交易时间和联系方式"
      />,
    );

    expect(screen.getByDisplayValue("product-1")).toHaveAttribute("type", "hidden");
    expect(screen.getByText("发起购买")).toBeTruthy();
    expect(screen.getByText("确认见面地点和备注后即可下单。")).toBeTruthy();
    expect(screen.getByDisplayValue("图书馆一楼大厅")).toBeTruthy();
    expect(screen.getByPlaceholderText("补充交易时间和联系方式")).toBeTruthy();
    expect(screen.getByRole("button", { name: "确认购买" })).toBeTruthy();
  });

  it("shows the action error message from server state", () => {
    mockUseActionState.mockReturnValue([{ success: false, message: "该商品已被其他用户预订" }, vi.fn()]);

    render(
      <ListingOrderForm
        action={async () => ({ success: false, message: "" })}
        targetFieldName="productId"
        targetId="product-1"
        title="发起购买"
        description="确认见面地点和备注后即可下单。"
        submitLabel="确认购买"
        notePlaceholder="补充交易时间和联系方式"
      />,
    );

    expect(screen.getByText("该商品已被其他用户预订")).toBeTruthy();
  });

  it("redirects after a successful action state", () => {
    mockUseActionState.mockReturnValue([
      { success: true, message: "下单成功", redirectTo: "/my/orders" },
      vi.fn(),
    ]);

    render(
      <ListingOrderForm
        action={async () => ({ success: false, message: "" })}
        targetFieldName="serviceId"
        targetId="service-1"
        title="预约服务"
        description="填写地点和说明后即可提交预约。"
        submitLabel="提交预约"
        notePlaceholder="补充需求细节"
      />,
    );

    expect(mockPush).toHaveBeenCalledWith("/my/orders");
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
