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
  it("renders hidden orderId only（Phase 8E：targetUserId 不再是客户端 authority）", () => {
    render(
      <ReviewForm action={async () => ({ success: false, message: "" })} orderId="order-1" />,
    );

    expect(screen.getByDisplayValue("order-1")).toHaveAttribute("type", "hidden");
    expect(screen.queryByDisplayValue("user-2")).toBeNull();
    expect(screen.getByLabelText("评分")).toHaveValue("5");
    expect(screen.getByPlaceholderText("例如：回复及时, 守时, 沟通顺畅")).toBeTruthy();
    expect(screen.getByPlaceholderText("补充评价内容")).toBeTruthy();
  });

  it("shows the action error message from server state", () => {
    mockUseActionState.mockReturnValue([{ success: false, message: "该订单已评价过" }, vi.fn()]);

    render(
      <ReviewForm action={async () => ({ success: false, message: "" })} orderId="order-1" />,
    );

    expect(screen.getByText("该订单已评价过")).toBeTruthy();
  });

  it("redirects after a successful action state", () => {
    mockUseActionState.mockReturnValue([
      { success: true, message: "评价成功", redirectTo: "/my/reviews" },
      vi.fn(),
    ]);

    render(
      <ReviewForm action={async () => ({ success: false, message: "" })} orderId="order-1" />,
    );

    expect(mockPush).toHaveBeenCalledWith("/my/reviews");
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
