import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatMessageList } from "@/components/conversation/chat-message-list";
import type { ConversationMessageItem } from "@/repositories/conversation-repository";

function message(overrides: Partial<ConversationMessageItem> = {}): ConversationMessageItem {
  return {
    id: `message-${Math.random().toString(36).slice(2)}`,
    senderId: "other-1",
    senderName: "对方同学",
    senderAvatarUrl: null,
    type: "DIRECT",
    content: "你好",
    isRead: false,
    createdAt: new Date("2026-08-21T10:00:00.000Z").toISOString(),
    ...overrides,
  };
}

afterEach(cleanup);

describe("ChatMessageList", () => {
  it("shows the empty state before any message", () => {
    render(<ChatMessageList currentUserId="user-1" messages={[]} />);

    expect(screen.getByText("你们还没有开始聊天")).toBeInTheDocument();
  });

  it("renders counterpart bubbles with avatar initials", () => {
    render(
      <ChatMessageList
        currentUserId="user-1"
        messages={[message({ content: "同学你好，还在吗？" })]}
      />,
    );

    expect(screen.getByText("同学你好，还在吗？")).toBeInTheDocument();
    expect(screen.getByText("对")).toBeInTheDocument();
    expect(screen.queryByText("· 未读")).not.toBeInTheDocument();
  });

  it("renders own bubbles with read state", () => {
    render(
      <ChatMessageList
        currentUserId="user-1"
        messages={[
          message({ senderId: "user-1", content: "在的，今晚面交", isRead: true }),
        ]}
      />,
    );

    expect(screen.getByText("在的，今晚面交")).toBeInTheDocument();
    expect(screen.getByText("· 已读")).toBeInTheDocument();
    expect(screen.getByText("我")).toBeInTheDocument();
  });

  it("renders system and order status messages centered", () => {
    render(
      <ChatMessageList
        currentUserId="user-1"
        messages={[
          message({ senderId: null, senderName: "系统通知", type: "SYSTEM", content: "订单已创建" }),
          message({ type: "ORDER_STATUS", content: "订单状态更新为已完成" }),
        ]}
      />,
    );

    expect(screen.getByText("订单已创建")).toBeInTheDocument();
    expect(screen.getByText("订单状态更新为已完成")).toBeInTheDocument();
  });

  it("shows a date divider only when the day changes", () => {
    render(
      <ChatMessageList
        currentUserId="user-1"
        messages={[
          message({ createdAt: new Date("2026-08-20T10:00:00.000Z").toISOString() }),
          message({ createdAt: new Date("2026-08-20T11:00:00.000Z").toISOString() }),
          message({ createdAt: new Date("2026-08-21T09:00:00.000Z").toISOString() }),
        ]}
      />,
    );

    const dividers = screen
      .getAllByText(/今天|月/)
      .map((el) => el.textContent)
      .filter((text): text is string => Boolean(text));
    expect(dividers.length).toBeLessThanOrEqual(3);
    expect(dividers.length).toBeGreaterThanOrEqual(2);
  });

  it("loads more history when the pagination button is clicked", () => {
    const onLoadMore = vi.fn();
    render(
      <ChatMessageList
        currentUserId="user-1"
        messages={[message()]}
        nextCursor="cursor-1"
        onLoadMore={onLoadMore}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "查看更多历史消息" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("shows the loading state on the pagination button", () => {
    render(
      <ChatMessageList
        currentUserId="user-1"
        messages={[message()]}
        nextCursor="cursor-1"
        onLoadMore={vi.fn()}
        isLoadingMore
      />,
    );

    const button = screen.getByRole("button", { name: "历史消息加载中..." });
    expect(button).toBeDisabled();
  });
});
