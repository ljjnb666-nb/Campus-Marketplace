import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewForm } from "@/components/trust/review-form";

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

describe("ReviewForm", () => {
  it("renders hidden ids, default rating, and placeholders", () => {
    render(
      <ReviewForm
        action={async () => ({ success: false, message: "" })}
        orderId="order-1"
        targetUserId="user-2"
      />,
    );

    expect(screen.getByDisplayValue("order-1")).toHaveAttribute("type", "hidden");
    expect(screen.getByDisplayValue("user-2")).toHaveAttribute("type", "hidden");
    expect(screen.getByLabelText("评分")).toHaveValue("5");
    expect(screen.getByPlaceholderText("例如：回复及时, 守时, 沟通顺畅")).toBeTruthy();
    expect(screen.getByPlaceholderText("补充评价内容")).toBeTruthy();
  });

  it("shows the action error message from server state", () => {
    mockUseActionState.mockReturnValue([{ success: false, message: "该订单已评价过" }, vi.fn()]);

    render(
      <ReviewForm
        action={async () => ({ success: false, message: "" })}
        orderId="order-1"
        targetUserId="user-2"
      />,
    );

    expect(screen.getByText("该订单已评价过")).toBeTruthy();
  });

  it("redirects after a successful action state", () => {
    mockUseActionState.mockReturnValue([
      { success: true, message: "评价成功", redirectTo: "/my/reviews" },
      vi.fn(),
    ]);

    render(
      <ReviewForm
        action={async () => ({ success: false, message: "" })}
        orderId="order-1"
        targetUserId="user-2"
      />,
    );

    expect(mockPush).toHaveBeenCalledWith("/my/reviews");
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
