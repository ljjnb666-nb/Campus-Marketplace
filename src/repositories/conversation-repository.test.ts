import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  conversationParticipantFindMany,
  messageFindFirst,
  conversationFindMany,
  messageFindMany,
  productFindMany,
  serviceListingFindMany,
} = vi.hoisted(() => ({
  conversationParticipantFindMany: vi.fn(),
  messageFindFirst: vi.fn(),
  conversationFindMany: vi.fn(),
  messageFindMany: vi.fn(),
  productFindMany: vi.fn(),
  serviceListingFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversationParticipant: {
      findMany: conversationParticipantFindMany,
    },
    message: {
      findFirst: messageFindFirst,
      findMany: messageFindMany,
    },
    conversation: {
      findMany: conversationFindMany,
    },
    product: {
      findMany: productFindMany,
    },
    serviceListing: {
      findMany: serviceListingFindMany,
    },
  },
}));

import {
  getConversationListItems,
  getUnreadConversationCount,
} from "@/repositories/conversation-repository";

describe("conversation repository", () => {
  beforeEach(() => {
    conversationParticipantFindMany.mockReset();
    messageFindFirst.mockReset();
    conversationFindMany.mockReset();
    messageFindMany.mockReset();
    productFindMany.mockReset();
    serviceListingFindMany.mockReset();
  });

  it("counts only conversations with messages newer than the user's last read time", async () => {
    conversationParticipantFindMany.mockResolvedValue([
      {
        conversationId: "conversation-1",
        lastReadAt: new Date("2026-07-17T08:00:00.000Z"),
      },
      {
        conversationId: "conversation-2",
        lastReadAt: null,
      },
      {
        conversationId: "conversation-3",
        lastReadAt: new Date("2026-07-17T12:00:00.000Z"),
      },
    ]);

    messageFindFirst
      .mockResolvedValueOnce({
        createdAt: new Date("2026-07-17T09:00:00.000Z"),
      })
      .mockResolvedValueOnce({
        createdAt: new Date("2026-07-17T07:00:00.000Z"),
      })
      .mockResolvedValueOnce(null);

    const count = await getUnreadConversationCount("user-1");

    expect(count).toBe(2);
    expect(messageFindFirst).toHaveBeenNthCalledWith(1, {
      where: {
        conversationId: "conversation-1",
        senderId: { not: "user-1" },
      },
      orderBy: { createdAt: "desc" },
      select: {
        createdAt: true,
      },
    });
  });

  it("maps hydrated conversations into list items with counterpart and unread state", async () => {
    conversationFindMany.mockResolvedValue([
      {
        id: "conversation-1",
        title: null,
        productId: "product-1",
        errandTaskId: null,
        serviceListingId: null,
        createdAt: new Date("2026-07-16T10:00:00.000Z"),
        updatedAt: new Date("2026-07-17T10:00:00.000Z"),
      },
    ]);

    conversationParticipantFindMany.mockResolvedValue([
      {
        conversationId: "conversation-1",
        userId: "user-1",
        lastReadAt: new Date("2026-07-17T09:00:00.000Z"),
        joinedAt: new Date("2026-07-16T10:00:00.000Z"),
        user: {
          id: "user-1",
          name: "买家同学",
          schoolName: "示例大学",
        },
      },
      {
        conversationId: "conversation-1",
        userId: "seller-1",
        lastReadAt: null,
        joinedAt: new Date("2026-07-16T10:00:01.000Z"),
        user: {
          id: "seller-1",
          name: "卖家同学",
          schoolName: "示例大学",
        },
      },
    ]);

    messageFindMany.mockResolvedValue([
      {
        id: "message-1",
        conversationId: "conversation-1",
        senderId: "seller-1",
        content: "还在的，可以今晚面交。",
        createdAt: new Date("2026-07-17T09:30:00.000Z"),
        sender: {
          id: "seller-1",
          name: "卖家同学",
        },
      },
    ]);

    productFindMany.mockResolvedValue([
      {
        id: "product-1",
        title: "高数教材",
        images: [],
      },
    ]);
    serviceListingFindMany.mockResolvedValue([]);

    const items = await getConversationListItems("user-1");

    expect(items).toEqual([
      {
        id: "conversation-1",
        title: "高数教材",
        bizTitle: "高数教材",
        bizType: "PRODUCT",
        bizTargetId: "product-1",
        bizCoverUrl: null,
        counterpartId: "seller-1",
        counterpartName: "卖家同学",
        counterpartSchoolName: "示例大学",
        counterpartAvatarUrl: null,
        counterpartVerificationStatus: "UNVERIFIED",
        lastMessageSenderName: "卖家同学",
        lastMessageContent: "还在的，可以今晚面交。",
        lastMessageAt: "2026-07-17T09:30:00.000Z",
        updatedAt: "2026-07-17T10:00:00.000Z",
        hasUnread: true,
        hasActiveOrder: false,
      },
    ]);
  });
});
