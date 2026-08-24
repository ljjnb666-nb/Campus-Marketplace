import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { blockUser, unblockUser } = vi.hoisted(() => ({
  blockUser: vi.fn(async () => ({ success: true, message: "" })),
  unblockUser: vi.fn(async () => ({ success: true, message: "" })),
}));

vi.mock("@/actions/trust", () => ({
  blockUser,
  unblockUser,
}));

import { BlockDialog } from "@/components/conversation/block-dialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BlockDialog", () => {
  it("renders nothing when closed", () => {
    render(
      <BlockDialog
        open={false}
        onOpenChange={vi.fn()}
        targetUserId="user-2"
        targetUserName="对方"
        isBlockedByMe={false}
      />,
    );

    expect(screen.queryByText(/拉黑用户/)).not.toBeInTheDocument();
  });

  it("shows block copy with a reason selector", () => {
    render(
      <BlockDialog
        open
        onOpenChange={vi.fn()}
        targetUserId="user-2"
        targetUserName="赵同学"
        isBlockedByMe={false}
      />,
    );

    expect(screen.getByText("拉黑用户 赵同学")).toBeInTheDocument();
    expect(screen.getByText("拉黑原因说明")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认拉黑" })).toBeInTheDocument();
    expect(screen.queryByText(/正在履约中的订单/)).not.toBeInTheDocument();
  });

  it("warns about in-flight orders before blocking", () => {
    render(
      <BlockDialog
        open
        onOpenChange={vi.fn()}
        targetUserId="user-2"
        targetUserName="赵同学"
        isBlockedByMe={false}
        hasActiveOrder
      />,
    );

    expect(screen.getByText(/正在履约中的订单/)).toBeInTheDocument();
  });

  it("shows unblock copy without a reason selector", () => {
    render(
      <BlockDialog
        open
        onOpenChange={vi.fn()}
        targetUserId="user-2"
        targetUserName="赵同学"
        isBlockedByMe
      />,
    );

    expect(screen.getByText("解除拉黑 赵同学")).toBeInTheDocument();
    expect(screen.queryByText("拉黑原因说明")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认解除拉黑" })).toBeInTheDocument();
  });

  it("submits the target user through the block form", () => {
    render(
      <BlockDialog
        open
        onOpenChange={vi.fn()}
        targetUserId="user-2"
        targetUserName="赵同学"
        isBlockedByMe={false}
      />,
    );

    const input = document.querySelector('input[name="targetUserId"]') as HTMLInputElement;
    expect(input).toHaveValue("user-2");
    expect(blockUser).toBeDefined();
  });
});
