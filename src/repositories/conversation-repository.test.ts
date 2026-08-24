import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  conversationParticipantFindMany,
  conversationParticipantUpdateMany,
  conversationFindFirst,
  conversationFindMany,
  messageFindMany,
  messageGroupBy,
  messageUpdateMany,
  blockedUserFindUnique,
  productFindMany,
  serviceListingFindMany,
  errandTaskFindMany,
  rentalListingFindMany,
  orderFindMany,
  rentalOrderFindMany,
} = vi.hoisted(() => ({
  conversationParticipantFindMany: vi.fn(),
  conversationParticipantUpdateMany: vi.fn(),
  conversationFindFirst: vi.fn(),
  conversationFindMany: vi.fn(),
  messageFindMany: vi.fn(),
  messageGroupBy: vi.fn(),
  messageUpdateMany: vi.fn(),
  blockedUserFindUnique: vi.fn(),
  productFindMany: vi.fn(),
  serviceListingFindMany: vi.fn(),
  errandTaskFindMany: vi.fn(),
  rentalListingFindMany: vi.fn(),
  orderFindMany: vi.fn(),
  rentalOrderFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversationParticipant: {
      findMany: conversationParticipantFindMany,
      updateMany: conversationParticipantUpdateMany,
    },
    conversation: {
      findFirst: conversationFindFirst,
      findMany: conversationFindMany,
    },
    message: {
      findMany: messageFindMany,
      groupBy: messageGroupBy,
      updateMany: messageUpdateMany,
    },
    blockedUser: {
      findUnique: blockedUserFindUnique,
    },
    product: {
      findMany: productFindMany,
    },
    serviceListing: {
      findMany: serviceListingFindMany,
    },
    errandTask: {
      findMany: errandTaskFindMany,
    },
    rentalListing: {
      findMany: rentalListingFindMany,
    },
    order: {
      findMany: orderFindMany,
    },
    rentalOrder: {
      findMany: rentalOrderFindMany,
    },
  },
}));

import {
  getConversationDetailPayload,
  getConversationListItems,
  getUnreadConversationCount,
} from "@/repositories/conversation-repository";

describe("conversation repository", () => {
  beforeEach(() => {
    conversationParticipantFindMany.mockReset();
    conversationParticipantUpdateMany.mockReset();
    conversationFindFirst.mockReset();
    conversationFindMany.mockReset();
    messageFindMany.mockReset();
    messageGroupBy.mockReset();
    messageUpdateMany.mockReset();
    blockedUserFindUnique.mockReset();
    productFindMany.mockReset();
    serviceListingFindMany.mockReset();
    errandTaskFindMany.mockReset();
    rentalListingFindMany.mockReset();
    orderFindMany.mockReset();
    rentalOrderFindMany.mockReset();
  });

  it("counts unread conversations with a single distinct query instead of per-conversation lookups", async () => {
    messageFindMany.mockResolvedValue([
      { conversationId: "conversation-1" },
      { conversationId: "conversation-2" },
    ]);

    const count = await getUnreadConversationCount("user-1");

    expect(count).toBe(2);
    expect(messageFindMany).toHaveBeenCalledTimes(1);
    expect(messageFindMany).toHaveBeenCalledWith({
      where: {
        isRead: false,
        senderId: { not: "user-1" },
        conversation: {
          participants: { some: { userId: "user-1" } },
        },
      },
      select: { conversationId: true },
      distinct: ["conversationId"],
    });
    expect(conversationParticipantFindMany).not.toHaveBeenCalled();
  });

  it("returns zero unread conversations when there are no unread messages", async () => {
    messageFindMany.mockResolvedValue([]);

    const count = await getUnreadConversationCount("user-1");

    expect(count).toBe(0);
    expect(messageFindMany).toHaveBeenCalledTimes(1);
  });

  it("maps hydrated conversations into list items with counterpart and unread state", async () => {
    conversationFindMany.mockResolvedValue([
      {
        id: "conversation-1",
        title: null,
        productId: "product-1",
        errandTaskId: null,
        serviceListingId: null,
        rentalListingId: null,
        orderId: null,
        rentalOrderId: null,
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
        joinedAt: new Date("2026-07-16T10:00:00.01Z"),
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

    messageGroupBy.mockResolvedValue([
      { conversationId: "conversation-1", _count: { conversationId: 2 } },
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

    // 列表查询只取最后一条消息（DISTINCT ON）而非全量消息
    expect(messageFindMany).toHaveBeenCalledWith({
      where: { conversationId: { in: ["conversation-1"] } },
      orderBy: [
        { conversationId: "asc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      distinct: ["conversationId"],
      include: {
        sender: {
          select: { id: true, name: true, avatarUrl: true },
        },
      },
    });
    // 未读数来自单次 groupBy 查询
    expect(messageGroupBy).toHaveBeenCalledWith({
      by: ["conversationId"],
      where: {
        conversationId: { in: ["conversation-1"] },
        senderId: { not: "user-1" },
        isRead: false,
      },
      _count: { conversationId: true },
    });

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

  it("falls back to updatedAt and marks read state when a conversation has no messages", async () => {
    conversationFindMany.mockResolvedValue([
      {
        id: "conversation-2",
        title: "跑腿沟通",
        productId: null,
        errandTaskId: null,
        serviceListingId: null,
        rentalListingId: null,
        orderId: null,
        rentalOrderId: null,
        createdAt: new Date("2026-07-16T10:00:00.000Z"),
        updatedAt: new Date("2026-07-17T10:00:00.000Z"),
      },
    ]);

    conversationParticipantFindMany.mockResolvedValue([
      {
        conversationId: "conversation-2",
        userId: "user-1",
        lastReadAt: new Date("2026-07-17T09:00:00.000Z"),
        joinedAt: new Date("2026-07-16T10:00:00.000Z"),
        user: { id: "user-1", name: "买家同学", schoolName: "示例大学" },
      },
      {
        conversationId: "conversation-2",
        userId: "seller-1",
        lastReadAt: null,
        joinedAt: new Date("2026-07-16T10:00:00.01Z"),
        user: { id: "seller-1", name: "卖家同学", schoolName: "示例大学" },
      },
    ]);

    messageFindMany.mockResolvedValue([]);
    messageGroupBy.mockResolvedValue([]);
    productFindMany.mockResolvedValue([]);
    serviceListingFindMany.mockResolvedValue([]);

    const items = await getConversationListItems("user-1");

    expect(items).toEqual([
      {
        id: "conversation-2",
        title: "跑腿沟通",
        bizTitle: "站内会话",
        bizType: "PRODUCT",
        bizTargetId: null,
        bizCoverUrl: null,
        counterpartId: "seller-1",
        counterpartName: "卖家同学",
        counterpartSchoolName: "示例大学",
        counterpartAvatarUrl: null,
        counterpartVerificationStatus: "UNVERIFIED",
        lastMessageSenderName: "系统",
        lastMessageContent: "你们还没有开始聊天",
        lastMessageAt: "2026-07-17T10:00:00.000Z",
        updatedAt: "2026-07-17T10:00:00.000Z",
        hasUnread: false,
        hasActiveOrder: false,
      },
    ]);
  });

  it("limits the conversation list to a bounded page size", async () => {
    conversationFindMany.mockResolvedValue([]);

    await getConversationListItems("user-1");

    expect(conversationFindMany).toHaveBeenCalledWith({
      where: {
        participants: { some: { userId: "user-1" } },
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });

    await getConversationListItems("user-1", { limit: 500 });

    expect(conversationFindMany).toHaveBeenLastCalledWith({
      where: {
        participants: { some: { userId: "user-1" } },
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });

    await getConversationListItems("user-1", { limit: 10 });

    expect(conversationFindMany).toHaveBeenLastCalledWith({
      where: {
        participants: { some: { userId: "user-1" } },
      },
      orderBy: { updatedAt: "desc" },
      take: 10,
    });
  });

  it("returns null instead of throwing when the conversation does not exist", async () => {
    conversationFindFirst.mockResolvedValue(null);

    await expect(getConversationDetailPayload("missing", "user-1")).resolves.toBeNull();
    expect(messageUpdateMany).not.toHaveBeenCalled();
  });

  it("marks unread counterpart messages as read via an idempotent updateMany", async () => {
    conversationFindFirst.mockResolvedValue({
      id: "conversation-1",
      title: null,
      productId: null,
      errandTaskId: null,
      serviceListingId: null,
      rentalListingId: null,
      orderId: null,
      rentalOrderId: null,
      createdAt: new Date("2026-07-16T10:00:00.000Z"),
      updatedAt: new Date("2026-07-17T10:00:00.000Z"),
    });

    conversationParticipantFindMany.mockResolvedValue([
      {
        conversationId: "conversation-1",
        userId: "user-1",
        lastReadAt: null,
        joinedAt: new Date("2026-07-16T10:00:00.000Z"),
        user: {
          id: "user-1",
          name: "买家同学",
          avatarUrl: null,
          schoolName: "示例大学",
          verificationStatus: "UNVERIFIED",
        },
      },
      {
        conversationId: "conversation-1",
        userId: "seller-1",
        lastReadAt: null,
        joinedAt: new Date("2026-07-16T10:00:00.01Z"),
        user: {
          id: "seller-1",
          name: "卖家同学",
          avatarUrl: null,
          schoolName: "示例大学",
          verificationStatus: "VERIFIED",
        },
      },
    ]);

    messageFindMany
      .mockResolvedValueOnce([
        {
          id: "message-2",
          conversationId: "conversation-1",
          senderId: "user-1",
          content: "可以，几点方便？",
          createdAt: new Date("2026-07-17T09:40:00.000Z"),
          sender: { id: "user-1", name: "买家同学", avatarUrl: null },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "message-2",
          conversationId: "conversation-1",
          senderId: "user-1",
          type: "DIRECT",
          content: "可以，几点方便？",
          isRead: false,
          createdAt: new Date("2026-07-17T09:40:00.000Z"),
          sender: { id: "user-1", name: "买家同学", avatarUrl: null },
        },
        {
          id: "message-1",
          conversationId: "conversation-1",
          senderId: "seller-1",
          type: "DIRECT",
          content: "还在的，可以今晚面交。",
          isRead: false,
          createdAt: new Date("2026-07-17T09:30:00.000Z"),
          sender: { id: "seller-1", name: "卖家同学", avatarUrl: null },
        },
      ]);

    messageGroupBy.mockResolvedValue([
      { conversationId: "conversation-1", _count: { conversationId: 1 } },
    ]);
    blockedUserFindUnique.mockResolvedValue(null);
    conversationParticipantUpdateMany.mockResolvedValue({ count: 1 });
    messageUpdateMany.mockResolvedValue({ count: 1 });

    const payload = await getConversationDetailPayload("conversation-1", "user-1");

    expect(payload?.id).toBe("conversation-1");
    expect(payload?.counterpart).toEqual({
      id: "seller-1",
      name: "卖家同学",
      avatarUrl: null,
      schoolName: "示例大学",
      verificationStatus: "VERIFIED",
      isBlockedByMe: false,
      hasBlockedMe: false,
    });
    expect(payload?.messages).toEqual([
      {
        id: "message-1",
        senderId: "seller-1",
        senderName: "卖家同学",
        senderAvatarUrl: null,
        type: "DIRECT",
        content: "还在的，可以今晚面交。",
        isRead: false,
        createdAt: "2026-07-17T09:30:00.000Z",
      },
      {
        id: "message-2",
        senderId: "user-1",
        senderName: "买家同学",
        senderAvatarUrl: null,
        type: "DIRECT",
        content: "可以，几点方便？",
        isRead: false,
        createdAt: "2026-07-17T09:40:00.000Z",
      },
    ]);
    expect(messageUpdateMany).toHaveBeenCalledWith({
      where: {
        conversationId: "conversation-1",
        senderId: { not: "user-1" },
        isRead: false,
      },
      data: { isRead: true },
    });
    expect(conversationParticipantUpdateMany).toHaveBeenCalledWith({
      where: { conversationId: "conversation-1", userId: "user-1" },
      data: { lastReadAt: expect.any(Date) },
    });
  });

  it("marks errand conversations with active order state", async () => {
    conversationFindMany.mockResolvedValue([
      {
        id: "conversation-errand",
        title: null,
        productId: null,
        errandTaskId: "errand-1",
        serviceListingId: null,
        rentalListingId: null,
        orderId: null,
        rentalOrderId: null,
        createdAt: new Date("2026-07-16T10:00:00.000Z"),
        updatedAt: new Date("2026-07-17T10:00:00.000Z"),
      },
    ]);
    conversationParticipantFindMany.mockResolvedValue([
      {
        conversationId: "conversation-errand",
        userId: "user-1",
        joinedAt: new Date(),
        user: { id: "user-1", name: "我", schoolName: "示例大学" },
      },
      {
        conversationId: "conversation-errand",
        userId: "publisher-1",
        joinedAt: new Date(),
        user: { id: "publisher-1", name: "发布者", schoolName: "示例大学" },
      },
    ]);
    messageFindMany.mockResolvedValue([]);
    messageGroupBy.mockResolvedValue([]);
    productFindMany.mockResolvedValue([]);
    serviceListingFindMany.mockResolvedValue([]);
    errandTaskFindMany.mockResolvedValue([
      { id: "errand-1", title: "帮我取快递", reward: { toString: () => "5" }, status: "IN_PROGRESS" },
    ]);

    const items = await getConversationListItems("user-1");

    expect(items[0].bizType).toBe("ERRAND");
    expect(items[0].bizTitle).toBe("帮我取快递");
    expect(items[0].hasActiveOrder).toBe(true);
  });

  it("exposes order conversations with an active flag while pending", async () => {
    conversationFindMany.mockResolvedValue([
      {
        id: "conversation-order",
        title: null,
        productId: null,
        errandTaskId: null,
        serviceListingId: null,
        rentalListingId: null,
        orderId: "order-1",
        rentalOrderId: null,
        createdAt: new Date("2026-07-16T10:00:00.000Z"),
        updatedAt: new Date("2026-07-17T10:00:00.000Z"),
      },
    ]);
    conversationParticipantFindMany.mockResolvedValue([
      {
        conversationId: "conversation-order",
        userId: "user-1",
        joinedAt: new Date(),
        user: { id: "user-1", name: "我", schoolName: "示例大学" },
      },
      {
        conversationId: "conversation-order",
        userId: "seller-1",
        joinedAt: new Date(),
        user: { id: "seller-1", name: "卖家", schoolName: "示例大学" },
      },
    ]);
    messageFindMany.mockResolvedValue([]);
    messageGroupBy.mockResolvedValue([]);
    productFindMany.mockResolvedValue([]);
    serviceListingFindMany.mockResolvedValue([]);
    orderFindMany.mockResolvedValue([
      { id: "order-1", orderNo: "CM2026082100000001", amount: 30, status: "PENDING", type: "PRODUCT" },
    ]);

    const items = await getConversationListItems("user-1");

    expect(items[0].bizType).toBe("PRODUCT_ORDER");
    expect(items[0].bizTitle).toBe("订单：CM2026082100000001");
    expect(items[0].hasActiveOrder).toBe(true);

    orderFindMany.mockResolvedValue([
      { id: "order-1", orderNo: "CM2026082100000001", amount: 30, status: "COMPLETED", type: "PRODUCT" },
    ]);
    const completed = await getConversationListItems("user-1");
    expect(completed[0].hasActiveOrder).toBe(false);
  });

  it("pushes the search keyword into the database query and filters by type in memory", async () => {
    conversationFindMany.mockResolvedValue([
      {
        id: "conversation-a",
        title: null,
        productId: "product-1",
        errandTaskId: null,
        serviceListingId: null,
        rentalListingId: null,
        orderId: null,
        rentalOrderId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    conversationParticipantFindMany.mockResolvedValue([
      {
        conversationId: "conversation-a",
        userId: "user-1",
        joinedAt: new Date(),
        user: { id: "user-1", name: "我", schoolName: "示例大学" },
      },
      {
        conversationId: "conversation-a",
        userId: "seller-1",
        joinedAt: new Date(),
        user: { id: "seller-1", name: "卖家甲", schoolName: "示例大学" },
      },
    ]);
    messageFindMany.mockResolvedValue([]);
    messageGroupBy.mockResolvedValue([]);
    productFindMany.mockResolvedValue([{ id: "product-1", title: "高等数学教材", images: [] }]);
    serviceListingFindMany.mockResolvedValue([]);

    // 搜索已下推：where 中包含标题/昵称/消息内容的 OR 谓词
    const items = await getConversationListItems("user-1", { search: "教材" });
    expect(conversationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          participants: { some: { userId: "user-1" } },
          OR: expect.arrayContaining([
            expect.objectContaining({ title: { contains: "教材", mode: "insensitive" } }),
            expect.objectContaining({ participants: expect.anything() }),
            expect.objectContaining({ messages: expect.anything() }),
          ]),
        }),
      }),
    );
    expect(items.map((item) => item.id)).toEqual(["conversation-a"]);

    // filterType ALL 保留全部
    const all = await getConversationListItems("user-1", { filterType: "ALL" });
    expect(all).toHaveLength(1);

    // filterType 不匹配时内存过滤掉
    const none = await getConversationListItems("user-1", { filterType: "ERRAND" });
    expect(none).toHaveLength(0);
  });

  it("builds a rental-order relatedBiz snapshot in the detail payload", async () => {
    conversationFindFirst.mockResolvedValue({
      id: "conversation-rental-order",
      title: null,
      productId: null,
      errandTaskId: null,
      serviceListingId: null,
      rentalListingId: null,
      orderId: null,
      rentalOrderId: "rental-order-1",
      createdAt: new Date("2026-07-16T10:00:00.000Z"),
      updatedAt: new Date("2026-07-17T10:00:00.000Z"),
    });
    conversationParticipantFindMany.mockResolvedValue([
      {
        conversationId: "conversation-rental-order",
        userId: "user-1",
        joinedAt: new Date(),
        user: { id: "user-1", name: "我", schoolName: "示例大学", verificationStatus: "UNVERIFIED" },
      },
      {
        conversationId: "conversation-rental-order",
        userId: "owner-1",
        joinedAt: new Date(),
        user: { id: "owner-1", name: "出租者", schoolName: "示例大学", verificationStatus: "VERIFIED" },
      },
    ]);
    messageFindMany
      .mockResolvedValueOnce([]) // hydrate: 最后一条消息
      .mockResolvedValueOnce([]); // 分页消息
    messageGroupBy.mockResolvedValue([]);
    blockedUserFindUnique.mockResolvedValue({ id: "block-1" });
    conversationParticipantUpdateMany.mockResolvedValue({ count: 1 });
    messageUpdateMany.mockResolvedValue({ count: 0 });
    productFindMany.mockResolvedValue([]);
    serviceListingFindMany.mockResolvedValue([]);
    rentalOrderFindMany.mockResolvedValue([
      { id: "rental-order-1", orderNumber: "RT2026082100000001", finalAmount: 40, status: "IN_RENTAL" },
    ]);

    const payload = await getConversationDetailPayload("conversation-rental-order", "user-1");

    expect(payload?.bizType).toBe("RENTAL_ORDER");
    expect(payload?.relatedBiz).toEqual({
      type: "RENTAL_ORDER",
      id: "rental-order-1",
      title: "租赁订单 (RT2026082100000001)",
      priceText: "总额 ¥40.00",
      detailUrl: "/rental-orders/rental-order-1",
    });
    // 拉黑状态双向查询
    expect(payload?.counterpart.isBlockedByMe).toBe(true);
    expect(payload?.counterpart.hasBlockedMe).toBe(true);
  });

  it("paginates messages with a next cursor when more exist", async () => {
    conversationFindFirst.mockResolvedValue({
      id: "conversation-1",
      title: null,
      productId: null,
      errandTaskId: null,
      serviceListingId: null,
      rentalListingId: null,
      orderId: null,
      rentalOrderId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    conversationParticipantFindMany.mockResolvedValue([
      {
        conversationId: "conversation-1",
        userId: "user-1",
        joinedAt: new Date(),
        user: { id: "user-1", name: "我", schoolName: "示例大学", verificationStatus: "UNVERIFIED" },
      },
      {
        conversationId: "conversation-1",
        userId: "seller-1",
        joinedAt: new Date(),
        user: { id: "seller-1", name: "卖家", schoolName: "示例大学", verificationStatus: "UNVERIFIED" },
      },
    ]);
    const messages = Array.from({ length: 3 }, (_, i) => ({
      id: `message-${i + 1}`,
      conversationId: "conversation-1",
      senderId: "seller-1",
      type: "DIRECT",
      content: `消息 ${i + 1}`,
      isRead: true,
      createdAt: new Date(`2026-07-17T09:3${i}:00.000Z`),
      sender: { id: "seller-1", name: "卖家", avatarUrl: null },
    }));
    messageFindMany
      .mockResolvedValueOnce([]) // hydrate
      .mockResolvedValueOnce(messages); // take: limit + 1 → 3 条，limit=2
    messageGroupBy.mockResolvedValue([]);
    blockedUserFindUnique.mockResolvedValue(null);
    conversationParticipantUpdateMany.mockResolvedValue({ count: 1 });
    messageUpdateMany.mockResolvedValue({ count: 0 });
    productFindMany.mockResolvedValue([]);
    serviceListingFindMany.mockResolvedValue([]);

    const payload = await getConversationDetailPayload("conversation-1", "user-1", undefined, 2);

    // 倒序取 limit+1 条，数组末尾一条被弹出作为向上翻页的 cursor
    expect(payload?.messages.map((m) => m.id)).toEqual(["message-2", "message-1"]);
    expect(payload?.nextCursor).toBe("message-3");
  });
});
