import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrderCancelDialog } from "@/components/order/order-cancel-dialog";
import { OrderConfirmDialog } from "@/components/order/order-confirm-dialog";

type DialogAction = (
  formData: FormData,
) => Promise<{ success?: boolean; message?: string } | void>;

function buildAction(
  result?: { success?: boolean; message?: string },
): ReturnType<typeof vi.fn<DialogAction>> {
  const action = vi.fn<DialogAction>();
  action.mockResolvedValue(result);
  return action;
}

function buildDialogHarness(Dialog: typeof OrderConfirmDialog) {
  const onOpenChange = vi.fn();
  const action = buildAction();
  const reload = vi.fn();
  vi.stubGlobal("location", { ...window.location, reload });
  render(
    <Dialog open onOpenChange={onOpenChange} action={action} orderId="order-1" />,
  );
  return { onOpenChange, action, reload };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("OrderConfirmDialog", () => {
  it("renders nothing when closed", () => {
    render(
      <OrderConfirmDialog open={false} onOpenChange={vi.fn()} action={vi.fn()} orderId="o1" />,
    );

    expect(screen.queryByText("确认完成交易履约？")).not.toBeInTheDocument();
  });

  it("submits orderId and status, then closes and reloads on success", async () => {
    const { onOpenChange, reload } = buildDialogHarness(OrderConfirmDialog);

    fireEvent.click(screen.getByRole("button", { name: "确认收货/完成" }));

    await vi.waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(reload).toHaveBeenCalled();
    });
  });

  it("passes the hidden status through the form payload", async () => {
    const action = buildAction();
    vi.stubGlobal("location", { ...window.location, reload: vi.fn() });
    render(
      <OrderConfirmDialog
        open
        onOpenChange={vi.fn()}
        action={action}
        orderId="order-1"
        nextStatus="ACCEPTED"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "确认收货/完成" }));

    await vi.waitFor(() => expect(action).toHaveBeenCalled());
    const formData = action.mock.calls[0][0] as FormData;
    expect(formData.get("orderId")).toBe("order-1");
    expect(formData.get("status")).toBe("ACCEPTED");
  });

  it("shows the failure message without closing", async () => {
    const { onOpenChange } = buildDialogHarnessWithResult(OrderConfirmDialog, {
      success: false,
      message: "订单状态已改变",
    });

    fireEvent.click(screen.getByRole("button", { name: "确认收货/完成" }));

    expect(await screen.findByText("订单状态已改变")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes when the cancel button or overlay is clicked", () => {
    const { onOpenChange } = buildDialogHarness(OrderConfirmDialog);

    fireEvent.click(screen.getByRole("button", { name: "未完成" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("OrderCancelDialog", () => {
  it("renders nothing when closed", () => {
    render(
      <OrderCancelDialog open={false} onOpenChange={vi.fn()} action={vi.fn()} orderId="o1" />,
    );

    expect(screen.queryByText("确认取消该订单？")).not.toBeInTheDocument();
  });

  it("submits CANCELLED with the optional reason", async () => {
    const action = buildAction();
    const onOpenChange = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload: vi.fn() });
    render(
      <OrderCancelDialog open onOpenChange={onOpenChange} action={action} orderId="order-1" />,
    );

    fireEvent.change(screen.getByPlaceholderText(/买家计划有变/), {
      target: { value: "时间冲突" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认取消" }));

    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const formData = action.mock.calls[0][0] as FormData;
    expect(formData.get("orderId")).toBe("order-1");
    expect(formData.get("status")).toBe("CANCELLED");
    expect(formData.get("reason")).toBe("时间冲突");
  });

  it("shows the error message when cancelling fails", async () => {
    const { onOpenChange } = buildDialogHarnessWithResult(OrderCancelDialog, {
      success: false,
      message: "无法取消已完成订单",
    });

    fireEvent.click(screen.getByRole("button", { name: "确认取消" }));

    expect(await screen.findByText("无法取消已完成订单")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes via the secondary button", () => {
    const { onOpenChange } = buildDialogHarness(OrderCancelDialog);

    fireEvent.click(screen.getByRole("button", { name: "再想想" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

function buildDialogHarnessWithResult(
  Dialog: typeof OrderConfirmDialog,
  result: { success: boolean; message: string },
) {
  const onOpenChange = vi.fn();
  const action = buildAction(result);
  const reload = vi.fn();
  vi.stubGlobal("location", { ...window.location, reload });
  render(
    <Dialog open onOpenChange={onOpenChange} action={action} orderId="order-1" />,
  );
  return { onOpenChange, action, reload };
}
