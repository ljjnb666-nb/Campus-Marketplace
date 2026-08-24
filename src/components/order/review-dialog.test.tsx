import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewDialog } from "@/components/order/review-dialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderDialog(result?: { success: boolean; message: string }) {
  const onOpenChange = vi.fn();
  const action = vi.fn<
    (formData: FormData) => Promise<{ success?: boolean; message?: string } | void>
  >();
  action.mockResolvedValue(result);
  const reload = vi.fn();
  vi.stubGlobal("location", { ...window.location, reload });
  render(
    <ReviewDialog
      open
      onOpenChange={onOpenChange}
      action={action}
      orderId="order-1"
      targetUserId="user-2"
    />,
  );
  return { onOpenChange, action, reload };
}

describe("ReviewDialog", () => {
  it("renders nothing when closed", () => {
    render(
      <ReviewDialog
        open={false}
        onOpenChange={vi.fn()}
        action={vi.fn()}
        orderId="o1"
        targetUserId="u1"
      />,
    );

    expect(screen.queryByText("发表交易评价")).not.toBeInTheDocument();
  });

  it("submits rating, tags and content then closes on success", async () => {
    const { onOpenChange, reload } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "守时高效" }));
    fireEvent.change(screen.getByPlaceholderText(/评价对方的沟通态度/), {
      target: { value: "交易很顺利" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交评价" }));

    await vi.waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(reload).toHaveBeenCalled();
    });
  });

  it("passes the form payload with joined tags and rating", async () => {
    const { action } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "守时高效" }));
    fireEvent.click(screen.getByRole("button", { name: "提交评价" }));

    await vi.waitFor(() => expect(action).toHaveBeenCalled());
    const formData = action.mock.calls[0][0] as FormData;
    expect(formData.get("orderId")).toBe("order-1");
    expect(formData.get("targetUserId")).toBe("user-2");
    expect(formData.get("tags")).toBe("守时高效");
    expect(formData.get("overallRating")).toBe("5");
  });

  it("shows the error message when submitting fails", async () => {
    const { onOpenChange } = renderDialog({ success: false, message: "已经评价过" });

    fireEvent.click(screen.getByRole("button", { name: "提交评价" }));

    expect(await screen.findByText("已经评价过")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes via the cancel button", () => {
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
