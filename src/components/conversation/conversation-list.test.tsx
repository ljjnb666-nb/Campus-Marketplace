import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

import { ConversationList } from "@/components/conversation/conversation-list";
import type { ConversationListItem } from "@/repositories/conversation-repository";

function item(overrides: Partial<ConversationListItem> = {}): ConversationListItem {
  return {
    id: "conversation-1",
    title: "会话",
    bizType: "PRODUCT",
    bizTitle: "高数教材",
    bizCoverUrl: null,
    bizTargetId: "product-1",
    counterpartId: "user-2",
    counterpartName: "赵同学",
    counterpartAvatarUrl: null,
    counterpartSchoolName: "示例大学",
    counterpartVerificationStatus: "UNVERIFIED",
    lastMessageSenderName: "赵同学",
    lastMessageContent: "还在的，可以面交",
    lastMessageAt: new Date("2026-08-21T09:00:00.000Z").toISOString(),
    updatedAt: new Date().toISOString(),
    hasUnread: false,
    hasActiveOrder: false,
    ...overrides,
  };
}

afterEach(cleanup);

describe("ConversationList", () => {
  it("renders items with biz labels and links to message pages", () => {
    render(<ConversationList items={[item()]} />);

    expect(screen.getByText("赵同学")).toBeInTheDocument();
    expect(screen.getByText("二手商品")).toBeInTheDocument();
    expect(screen.getByText("高数教材")).toBeInTheDocument();
    expect(screen.getByText("还在的，可以面交")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/messages/conversation-1");
  });

  it("shows unread dot, verified badge and active order hint", () => {
    render(
      <ConversationList
        items={[
          item({
            hasUnread: true,
            counterpartVerificationStatus: "VERIFIED",
            hasActiveOrder: true,
          }),
        ]}
      />,
    );

    expect(screen.getByText("有正在履约中的订单")).toBeInTheDocument();
    expect(document.querySelector(".bg-rose-500")).not.toBeNull();
  });

  it("renders avatar images when provided", () => {
    render(
      <ConversationList
        items={[item({ counterpartAvatarUrl: "/uploads/avatar.webp" })]}
      />,
    );

    expect(screen.getByRole("img", { name: "赵同学" })).toHaveAttribute(
      "src",
      "/uploads/avatar.webp",
    );
  });

  it("filters items by search keyword across name and message", () => {
    render(
      <ConversationList
        items={[
          item({ id: "c1", counterpartName: "赵同学" }),
          item({ id: "c2", counterpartName: "钱同学", lastMessageContent: "今晚发货" }),
        ]}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/搜索联系人、交易或消息/), {
      target: { value: "今晚" },
    });

    expect(screen.queryByText("赵同学")).not.toBeInTheDocument();
    expect(screen.getByText("钱同学")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/搜索联系人、交易或消息/), {
      target: { value: "赵同学" },
    });
    expect(screen.getByText("赵同学")).toBeInTheDocument();
  });

  it("filters items by biz type tab", () => {
    render(
      <ConversationList
        items={[
          item({ id: "c1", bizType: "PRODUCT" }),
          item({ id: "c2", bizType: "ERRAND", bizTitle: "帮我取快递" }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "跑腿" }));

    expect(screen.queryByText("高数教材")).not.toBeInTheDocument();
    expect(screen.getByText("帮我取快递")).toBeInTheDocument();
  });

  it("shows the empty state when no items match", () => {
    render(<ConversationList items={[]} />);

    expect(screen.getByText("未找到相关会话记录")).toBeInTheDocument();
  });

  it("delegates selection when an onSelect handler is provided", () => {
    const onSelect = vi.fn();
    render(<ConversationList items={[item()]} selectedId="conversation-1" onSelect={onSelect} />);

    fireEvent.click(screen.getByText("赵同学"));

    expect(onSelect).toHaveBeenCalledWith("conversation-1");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("falls back to a generic biz label for unknown types", () => {
    render(
      <ConversationList
        items={[item({ bizType: "RENTAL_ORDER" as ConversationListItem["bizType"], bizTitle: "租赁单 RT123" })]}
      />,
    );

    expect(screen.getByText("租赁订单")).toBeInTheDocument();
  });
});
