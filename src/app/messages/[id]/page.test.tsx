import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { requireUser, getConversationDetail, getConversationDetailPayload, getConversationListItems, sendMessage, createReport, blockUser, unblockUser } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getConversationDetail: vi.fn(),
  getConversationDetailPayload: vi.fn(),
  getConversationListItems: vi.fn(),
  sendMessage: vi.fn(),
  createReport: vi.fn(),
  blockUser: vi.fn(),
  unblockUser: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  notFound: vi.fn(),
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

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/repositories/conversation-repository", () => ({
  getConversationDetail,
  getConversationDetailPayload,
  getConversationListItems,
}));

vi.mock("@/actions/conversation", () => ({
  sendMessage,
}));

vi.mock("@/actions/trust", () => ({
  createReport,
  blockUser,
  unblockUser,
}));

import MessageDetailPage from "@/app/messages/[id]/page";

describe("MessageDetailPage", () => {
  it("renders conversation details, thread messages, and the send form", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });
    getConversationListItems.mockResolvedValue([
      {
        id: "conversation-1",
        title: "高数教材咨询",
        counterpartId: "user-2",
        counterpartName: "李同学",
        counterpartAvatarUrl: null,
        counterpartVerificationStatus: "VERIFIED",
        bizType: "PRODUCT",
        bizTitle: "高数教材",
        lastMessageContent: "可以，几点方便？",
        lastMessageAt: "2026-07-18T08:05:00.000Z",
        hasUnread: false,
        hasActiveOrder: false,
        updatedAt: new Date("2026-07-18T08:05:00.000Z"),
      },
    ]);
    const convData = {
      id: "conversation-1",
      title: "高数教材咨询",
      product: null,
      serviceListing: null,
      participants: [
        {
          userId: "user-1",
          user: {
            id: "user-1",
            name: "我自己",
            schoolName: "示例大学",
          },
        },
        {
          userId: "user-2",
          user: {
            id: "user-2",
            name: "李同学",
            schoolName: "示例大学",
          },
        },
      ],
      messages: [
        {
          id: "message-1",
          senderId: "user-2",
          sender: { name: "李同学" },
          content: "教材还在，可以今晚面交。",
          createdAt: new Date("2026-07-18T08:00:00.000Z"),
        },
        {
          id: "message-2",
          senderId: "user-1",
          sender: { name: "我自己" },
          content: "可以，几点方便？",
          createdAt: new Date("2026-07-18T08:05:00.000Z"),
        },
      ],
    };
    getConversationDetail.mockResolvedValue(convData);
    getConversationDetailPayload.mockResolvedValue({
      conversation: {
        id: "conversation-1",
        title: "高数教材咨询",
        messages: [
          {
            id: "msg-1",
            senderId: "user-2",
            senderName: "李同学",
            senderAvatarUrl: null,
            type: "DIRECT",
            content: "教材还在，可以今晚面交。",
            isRead: true,
            createdAt: "2026-07-18T08:00:00.000Z",
          },
          {
            id: "msg-2",
            senderId: "user-1",
            senderName: "我自己",
            senderAvatarUrl: null,
            type: "DIRECT",
            content: "可以，几点方便？",
            isRead: true,
            createdAt: "2026-07-18T08:05:00.000Z",
          },
        ],
        nextCursor: null,
      },
      counterpart: {
        id: "user-2",
        name: "李同学",
        avatarUrl: null,
        schoolName: "示例大学",
        verificationStatus: "VERIFIED",
        isBlockedByMe: false,
        hasBlockedMe: false,
      },
      hasActiveOrder: false,
      relatedBiz: null,
    });

    render(
      await MessageDetailPage({
        params: Promise.resolve({ id: "conversation-1" }),
      }),
    );

    await waitFor(() => {
      expect(screen.getAllByText("李同学")[0]).toBeTruthy();
    });
  });
});
