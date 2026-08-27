import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { createReport, ReportDialog, BlockDialog } = vi.hoisted(() => ({
  createReport: vi.fn(),
  ReportDialog: vi.fn(({ open }: { open: boolean }) =>
    open ? <div data-testid="report-dialog" /> : null,
  ),
  BlockDialog: vi.fn(({ open }: { open: boolean }) =>
    open ? <div data-testid="block-dialog" /> : null,
  ),
}));

vi.mock("@/actions/trust", () => ({
  createReport,
}));

vi.mock("@/components/ui/report-dialog", () => ({
  ReportDialog,
}));

vi.mock("@/components/conversation/block-dialog", () => ({
  BlockDialog,
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

import { ChatHeader } from "@/components/conversation/chat-header";

const counterpart = {
  id: "user-2",
  name: "赵同学",
  avatarUrl: null,
  schoolName: "示例大学",
  verificationStatus: "VERIFIED",
  isBlockedByMe: false,
  hasBlockedMe: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ChatHeader", () => {
  it("renders counterpart identity with verified badge and biz card", () => {
    render(
      <ChatHeader
        counterpart={counterpart}
        relatedBiz={{
          type: "PRODUCT",
          id: "p1",
          title: "高数教材",
          priceText: "¥25.00",
          coverUrl: "/uploads/book.webp",
          detailUrl: "/products/p1",
        }}
      />,
    );

    expect(screen.getByText("赵同学")).toBeInTheDocument();
    expect(screen.getByText("已认证")).toBeInTheDocument();
    expect(screen.getByText("示例大学")).toBeInTheDocument();
    expect(screen.getByText("高数教材")).toBeInTheDocument();
    expect(screen.getByText("¥25.00")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /查看详情/ })).toHaveAttribute(
      "href",
      "/products/p1",
    );
  });

  it("shows the avatar image when provided", () => {
    render(
      <ChatHeader
        counterpart={{ ...counterpart, avatarUrl: "/uploads/avatar.webp" }}
      />,
    );

    expect(screen.getByRole("img", { name: "赵同学" })).toHaveAttribute(
      "src",
      "/uploads/avatar.webp",
    );
  });

  it("marks blocked counterparts in the subtitle", () => {
    render(<ChatHeader counterpart={{ ...counterpart, isBlockedByMe: true }} />);

    expect(screen.getByText("(已拉黑)")).toBeInTheDocument();
  });

  it("opens the report dialog from the action menu", () => {
    render(<ChatHeader counterpart={counterpart} />);

    const menuButton = screen
      .getAllByRole("button")
      .find((b) => !b.getAttribute("aria-label"));
    fireEvent.click(menuButton!);

    fireEvent.click(screen.getByText("举报违规用户/消息"));

    expect(screen.getByTestId("report-dialog")).toBeInTheDocument();
  });

  it("opens the block dialog from the action menu", () => {
    render(<ChatHeader counterpart={counterpart} />);

    const menuButton = screen
      .getAllByRole("button")
      .find((b) => !b.getAttribute("aria-label"));
    fireEvent.click(menuButton!);
    fireEvent.click(screen.getByText("拉黑该同学"));

    expect(screen.getByTestId("block-dialog")).toBeInTheDocument();
    expect(BlockDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUserId: "user-2",
        targetUserName: "赵同学",
        isBlockedByMe: false,
      }),
      undefined,
    );
  });

  it("offers unblock in the menu for blocked counterparts", () => {
    render(<ChatHeader counterpart={{ ...counterpart, isBlockedByMe: true }} />);

    const menuButton = screen
      .getAllByRole("button")
      .find((b) => !b.getAttribute("aria-label"));
    fireEvent.click(menuButton!);

    expect(screen.getByText("解除拉黑")).toBeInTheDocument();
  });

  it("triggers the back handler when provided", () => {
    const onBack = vi.fn();
    render(<ChatHeader counterpart={counterpart} onBack={onBack} />);

    fireEvent.click(screen.getByLabelText("返回会话列表"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
