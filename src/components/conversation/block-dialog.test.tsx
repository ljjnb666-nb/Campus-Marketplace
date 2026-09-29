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

  it("shows block copy with a reason selector（8A-03 冻结文案：履约沟通不被阻断）", () => {
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
    // §31：新文案 = 新普通沟通被阻断，但履约沟通继续开放
    expect(
      screen.getByText(
        "拉黑后，你们将无法发起新的普通沟通；如双方仍有正在履行的订单或任务，必要的交易沟通将继续开放。",
      ),
    ).toBeInTheDocument();
    // 旧文案（"无法继续向你发送私发消息"）不再出现
    expect(screen.queryByText(/无法继续向你发送私发消息/)).not.toBeInTheDocument();
    expect(screen.queryByText(/可能导致必要交易沟通阻断/)).not.toBeInTheDocument();
  });

  it("warns that blocking neither cancels orders nor cuts fulfilment communication（§31）", () => {
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

    expect(
      screen.getByText(
        "提示：拉黑不会取消现有订单，也不会阻断当前履约所需的交易沟通；交易结束后，消息屏蔽将继续生效。",
      ),
    ).toBeInTheDocument();
    // §51：保证不会重新说"拉黑会阻断现有交易沟通"
    expect(screen.queryByText(/可能导致必要交易沟通阻断/)).not.toBeInTheDocument();
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
