import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { requireUser, getConversationListItems } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getConversationListItems: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/repositories/conversation-repository", () => ({
  getConversationListItems,
}));

import MessagesPage from "@/app/messages/page";

describe("MessagesPage", () => {
  it("renders the conversation page and passes items to the client list", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getConversationListItems.mockResolvedValue([
      {
        id: "conversation-1",
        counterpartName: "张同学",
        bizTitle: "高数教材",
        lastMessageContent: "请问还在吗",
        lastMessageAt: new Date(),
        unreadCount: 1,
        bizType: "PRODUCT",
      },
      {
        id: "conversation-2",
        counterpartName: "李同学",
        bizTitle: "PPT 美化",
        lastMessageContent: "可以接单",
        lastMessageAt: new Date(),
        unreadCount: 0,
        bizType: "SERVICE",
      },
    ]);

    render(await MessagesPage());

    expect(screen.getByText("校园安全私聊与沟通")).toBeTruthy();
    expect(screen.getByText("张同学")).toBeTruthy();
    expect(screen.getByText("李同学")).toBeTruthy();
    expect(screen.getByText("高数教材")).toBeTruthy();
    expect(screen.getByText("PPT 美化")).toBeTruthy();
  });
});
