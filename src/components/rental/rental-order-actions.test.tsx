import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { approveRentalOrder, rejectRentalOrder, cancelRentalOrder, respondDamageClaim } =
  vi.hoisted(() => ({
    approveRentalOrder: vi.fn(),
    rejectRentalOrder: vi.fn(),
    cancelRentalOrder: vi.fn(),
    respondDamageClaim: vi.fn(),
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

vi.mock("@/actions/rental-order", () => ({
  approveRentalOrder,
  rejectRentalOrder,
  cancelRentalOrder,
  respondDamageClaim,
}));

import { RentalOrderActions } from "@/components/rental/rental-order-actions";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RentalOrderActions 申请归还（requestReturn）入口", () => {
  it.each(["IN_RENTAL", "PICKED_UP", "OVERDUE"] as const)(
    "租客在 %s 状态可见申请归还入口",
    (status) => {
      render(<RentalOrderActions orderId="order-1" status={status} userRole="renter" />);

      const link = screen.getByRole("link", { name: "申请归还" });
      expect(link.getAttribute("href")).toBe("/rental-orders/order-1/return");
    },
  );

  it("OVERDUE 状态不展示续租入口（requestReturn 允许但 requestExtension 不允许）", () => {
    render(<RentalOrderActions orderId="order-1" status="OVERDUE" userRole="renter" />);

    expect(screen.queryByText("申请续租")).toBeNull();
    expect(screen.getByRole("link", { name: "申请归还" })).toBeTruthy();
  });

  it("IN_RENTAL 状态保留续租入口", () => {
    render(<RentalOrderActions orderId="order-1" status="IN_RENTAL" userRole="renter" />);

    expect(screen.getByRole("link", { name: "申请续租" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "申请归还" })).toBeTruthy();
  });

  it("出租者或非允许状态下不展示申请归还入口", () => {
    const { rerender } = render(
      <RentalOrderActions orderId="order-1" status="IN_RENTAL" userRole="owner" />,
    );
    expect(screen.queryByText("申请归还")).toBeNull();

    rerender(<RentalOrderActions orderId="order-1" status="PENDING_RETURN" userRole="renter" />);
    expect(screen.queryByText("申请归还")).toBeNull();

    rerender(<RentalOrderActions orderId="order-1" status="COMPLETED" userRole="renter" />);
    expect(screen.queryByText("申请归还")).toBeNull();

    rerender(<RentalOrderActions orderId="order-1" status="PENDING_APPROVAL" userRole="renter" />);
    expect(screen.queryByText("申请归还")).toBeNull();
  });
});

describe("RentalOrderActions 损坏索赔处理（respondDamageClaim）", () => {
  const pendingClaim = {
    id: "claim-1",
    damageDescription: "屏幕碎裂，需要维修",
    requestedDeduction: 200,
  };

  it("租客存在未决索赔时展示索赔卡片与同意/拒绝按钮", () => {
    const { container } = render(
      <RentalOrderActions
        orderId="order-1"
        status="PENDING_INSPECTION"
        userRole="renter"
        pendingClaim={pendingClaim}
      />,
    );

    expect(screen.getByText("出租者发起了损坏索赔，等待你处理")).toBeTruthy();
    expect(screen.getByText("屏幕碎裂，需要维修")).toBeTruthy();
    expect(screen.getByText("¥200.00")).toBeTruthy();
    expect(screen.getByRole("button", { name: "同意索赔" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "拒绝索赔" })).toBeTruthy();
    expect(container.querySelectorAll('input[name="claimId"][value="claim-1"]')).toHaveLength(2);
  });

  it("点击同意提交 claimId 与 agreed=true 的 FormData", async () => {
    respondDamageClaim.mockResolvedValue({ success: true, message: "已同意索赔" });

    render(
      <RentalOrderActions
        orderId="order-1"
        status="PENDING_INSPECTION"
        userRole="renter"
        pendingClaim={pendingClaim}
      />,
    );

    const form = screen.getByRole("button", { name: "同意索赔" }).closest("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(respondDamageClaim).toHaveBeenCalledTimes(1);
    });
    const formData = respondDamageClaim.mock.calls[0][0] as FormData;
    expect(formData.get("claimId")).toBe("claim-1");
    expect(formData.get("agreed")).toBe("true");
  });

  it("点击拒绝提交 claimId 与 agreed=false 的 FormData", async () => {
    respondDamageClaim.mockResolvedValue({ success: true, message: "已拒绝索赔" });

    render(
      <RentalOrderActions
        orderId="order-1"
        status="PENDING_INSPECTION"
        userRole="renter"
        pendingClaim={pendingClaim}
      />,
    );

    const form = screen.getByRole("button", { name: "拒绝索赔" }).closest("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(respondDamageClaim).toHaveBeenCalledTimes(1);
    });
    const formData = respondDamageClaim.mock.calls[0][0] as FormData;
    expect(formData.get("claimId")).toBe("claim-1");
    expect(formData.get("agreed")).toBe("false");
  });

  it("出租者或无未决索赔时不展示索赔按钮", () => {
    const { rerender } = render(
      <RentalOrderActions
        orderId="order-1"
        status="PENDING_INSPECTION"
        userRole="owner"
        pendingClaim={pendingClaim}
      />,
    );
    expect(screen.queryByRole("button", { name: "同意索赔" })).toBeNull();
    expect(screen.queryByRole("button", { name: "拒绝索赔" })).toBeNull();

    rerender(
      <RentalOrderActions
        orderId="order-1"
        status="PENDING_INSPECTION"
        userRole="renter"
        pendingClaim={null}
      />,
    );
    expect(screen.queryByRole("button", { name: "同意索赔" })).toBeNull();
    expect(screen.queryByRole("button", { name: "拒绝索赔" })).toBeNull();
    expect(screen.queryByText("出租者发起了损坏索赔，等待你处理")).toBeNull();
  });

  it("action 返回失败时内联展示错误信息", async () => {
    respondDamageClaim.mockResolvedValue({ success: false, message: "无效请求" });

    render(
      <RentalOrderActions
        orderId="order-1"
        status="PENDING_INSPECTION"
        userRole="renter"
        pendingClaim={pendingClaim}
      />,
    );

    fireEvent.submit(screen.getByRole("button", { name: "同意索赔" }).closest("form")!);

    await waitFor(() => {
      expect(screen.getByText("无效请求")).toBeTruthy();
    });
  });
});
