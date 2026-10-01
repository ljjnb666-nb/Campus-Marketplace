import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewDialog } from "@/components/order/review-dialog";

const { mockRefresh } = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: mockRefresh,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog(result?: { success: boolean; message: string }) {
  const onOpenChange = vi.fn();
  const action = vi.fn<
    (formData: FormData) => Promise<{ success?: boolean; message?: string } | void>
  >();
  action.mockResolvedValue(result);
  render(
    <ReviewDialog open onOpenChange={onOpenChange} action={action} orderId="order-1" />,
  );
  return { onOpenChange, action };
}

describe("ReviewDialog", () => {
  it("renders nothing when closed", () => {
    render(
      <ReviewDialog open={false} onOpenChange={vi.fn()} action={vi.fn()} orderId="o1" />,
    );

    expect(screen.queryByText("发表交易评价")).not.toBeInTheDocument();
  });

  it("exposes accessible dialog, star ratings with Chinese names, and labelled textarea（§50）", () => {
    renderDialog();

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-label", "发表交易评价");
    for (const star of [1, 2, 3, 4, 5]) {
      expect(screen.getByRole("radio", { name: `${star} 星` })).toBeTruthy();
    }
    expect(screen.getByLabelText("详细评价内容 (选填)")).toBeTruthy();
  });

  it("submits rating, tags and content then closes and refreshes server views（§51）", async () => {
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "守时高效" }));
    fireEvent.change(screen.getByLabelText("详细评价内容 (选填)"), {
      target: { value: "交易很顺利" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交评价" }));

    await vi.waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
      // 一致性权威 = 服务端事务 + revalidate；router.refresh 刷新 RSC 视图
      expect(mockRefresh).toHaveBeenCalled();
    });
  });

  it("passes the form payload with joined tags and rating（无 targetUserId authority）", async () => {
    const { action } = renderDialog();

    fireEvent.click(screen.getByRole("radio", { name: "4 星" }));
    fireEvent.click(screen.getByRole("button", { name: "守时高效" }));
    fireEvent.click(screen.getByRole("button", { name: "提交评价" }));

    await vi.waitFor(() => expect(action).toHaveBeenCalled());
    const formData = action.mock.calls[0][0] as FormData;
    expect(formData.get("orderId")).toBe("order-1");
    expect(formData.get("targetUserId")).toBeNull();
    expect(formData.get("tags")).toBe("守时高效");
    expect(formData.get("overallRating")).toBe("4");
  });

  it("shows the error message with role=alert when submitting fails", async () => {
    const { onOpenChange } = renderDialog({ success: false, message: "已经评价过" });

    fireEvent.click(screen.getByRole("button", { name: "提交评价" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("已经评价过");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes via the cancel button", () => {
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
