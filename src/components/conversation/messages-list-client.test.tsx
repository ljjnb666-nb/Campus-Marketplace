import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesListClient } from "@/components/conversation/messages-list-client";
import type { ConversationListItem } from "@/repositories/conversation-repository";

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

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ items: [] }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MessagesListClient", () => {
  it("filters conversations by keyword and unread-only toggle", () => {
    const items: ConversationListItem[] = [
      {
        id: "conversation-1",
        title: "高数教材",
        bizType: "PRODUCT",
        bizTitle: "高数教材",
        counterpartId: "user-2",
        counterpartName: "卖家同学",
        counterpartSchoolName: "示例大学",
        counterpartVerificationStatus: "VERIFIED",
        lastMessageSenderName: "卖家同学",
        lastMessageContent: "今晚面交可以",
        lastMessageAt: "2026-07-17T09:30:00.000Z",
        updatedAt: "2026-07-17T09:30:00.000Z",
        hasUnread: true,
        hasActiveOrder: false,
      },
      {
        id: "conversation-2",
        title: "PPT美化",
        bizType: "SERVICE",
        bizTitle: "PPT美化",
        counterpartId: "user-3",
        counterpartName: "服务同学",
        counterpartSchoolName: "示例大学",
        counterpartVerificationStatus: "VERIFIED",
        lastMessageSenderName: "我",
        lastMessageContent: "收到，明天继续",
        lastMessageAt: "2026-07-17T10:00:00.000Z",
        updatedAt: "2026-07-17T10:00:00.000Z",
        hasUnread: false,
        hasActiveOrder: false,
      },
    ];

    render(<MessagesListClient initialItems={items} />);

    expect(screen.getByText("高数教材")).toBeTruthy();
    expect(screen.getByText("PPT美化")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("按标题、对方昵称或消息内容搜索"), {
      target: { value: "服务同学" },
    });

    expect(screen.queryByText("高数教材")).toBeNull();
    expect(screen.getByText("PPT美化")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("按标题、对方昵称或消息内容搜索"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByLabelText("只看未读"));

    expect(screen.getByText("高数教材")).toBeTruthy();
    expect(screen.queryByText("PPT美化")).toBeNull();
  });
});
