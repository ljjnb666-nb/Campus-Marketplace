import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

export type BizType =
  | "PRODUCT"
  | "ERRAND"
  | "SERVICE"
  | "RENTAL"
  | "PRODUCT_ORDER"
  | "RENTAL_ORDER";

export type ConversationListItem = {
  id: string;
  title: string;
  bizType: BizType;
  bizTitle: string;
  bizCoverUrl?: string | null;
  bizTargetId?: string | null;
  counterpartId: string;
  counterpartName: string;
  counterpartAvatarUrl?: string | null;
  counterpartSchoolName: string;
  counterpartVerificationStatus: string;
  lastMessageSenderName: string;
  lastMessageContent: string;
  lastMessageAt: string;
  updatedAt: string;
  hasUnread: boolean;
  hasActiveOrder: boolean;
};

export type ConversationMessageItem = {
  id: string;
  senderId: string | null;
  senderName: string;
  senderAvatarUrl?: string | null;
  type: string;
  content: string;
  isRead: boolean;
  createdAt: string;
};

export type RelatedBizSnapshot = {
  type: BizType;
  id: string;
  title: string;
  priceText?: string;
  statusText?: string;
  coverUrl?: string | null;
  detailUrl: string;
};

export type ConversationDetailPayload = {
  id: string;
  bizType: BizType;
  title: string;
  counterpart: {
    id: string;
    name: string;
    avatarUrl?: string | null;
    schoolName: string;
    verificationStatus: string;
    isBlockedByMe: boolean;
    hasBlockedMe: boolean;
  };
  relatedBiz?: RelatedBizSnapshot | null;
  messages: ConversationMessageItem[];
  nextCursor?: string | null;
};

async function hydrateConversations(
  conversations: Array<{
    id: string;
    title: string | null;
    productId: string | null;
    errandTaskId: string | null;
    serviceListingId: string | null;
    rentalListingId: string | null;
    orderId: string | null;
    rentalOrderId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>,
) {
  const conversationIds = conversations.map((item) => item.id);
  const productIds = conversations.map((item) => item.productId).filter((v): v is string => Boolean(v));
  const errandIds = conversations.map((item) => item.errandTaskId).filter((v): v is string => Boolean(v));
  const serviceIds = conversations.map((item) => item.serviceListingId).filter((v): v is string => Boolean(v));
  const rentalIds = conversations.map((item) => item.rentalListingId).filter((v): v is string => Boolean(v));
  const orderIds = conversations.map((item) => item.orderId).filter((v): v is string => Boolean(v));
  const rentalOrderIds = conversations.map((item) => item.rentalOrderId).filter((v): v is string => Boolean(v));

  const [
    participants,
    messages,
    products,
    errands,
    services,
    rentals,
    orders,
    rentalOrders,
  ] = await Promise.all([
    prisma.conversationParticipant.findMany({
      where: { conversationId: { in: conversationIds } },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
            schoolName: true,
            verificationStatus: true,
          },
        },
      },
      orderBy: { joinedAt: "asc" },
    }),
    prisma.message.findMany({
      where: { conversationId: { in: conversationIds } },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    productIds.length > 0
      ? prisma.product.findMany({
          where: { id: { in: productIds } },
          include: { images: { take: 1, orderBy: { sortOrder: "asc" } } },
        })
      : Promise.resolve([]),
    errandIds.length > 0
      ? prisma.errandTask.findMany({
          where: { id: { in: errandIds } },
          select: { id: true, title: true, reward: true, status: true },
        })
      : Promise.resolve([]),
    serviceIds.length > 0
      ? prisma.serviceListing.findMany({
          where: { id: { in: serviceIds } },
          select: { id: true, title: true, price: true, coverImageUrl: true },
        })
      : Promise.resolve([]),
    rentalIds.length > 0
      ? prisma.rentalListing.findMany({
          where: { id: { in: rentalIds } },
          include: { images: { take: 1, orderBy: { sortOrder: "asc" } } },
        })
      : Promise.resolve([]),
    orderIds.length > 0
      ? prisma.order.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, orderNo: true, amount: true, status: true, type: true },
        })
      : Promise.resolve([]),
    rentalOrderIds.length > 0
      ? prisma.rentalOrder.findMany({
          where: { id: { in: rentalOrderIds } },
          select: { id: true, orderNumber: true, finalAmount: true, status: true },
        })
      : Promise.resolve([]),
  ]);

  const participantsByConv = new Map<string, typeof participants>();
  for (const p of participants) {
    const list = participantsByConv.get(p.conversationId) ?? [];
    list.push(p);
    participantsByConv.set(p.conversationId, list);
  }

  const messagesByConv = new Map<string, typeof messages>();
  for (const m of messages) {
    const list = messagesByConv.get(m.conversationId) ?? [];
    list.push(m);
    messagesByConv.set(m.conversationId, list);
  }

  const productMap = new Map(products.map((item) => [item.id, item]));
  const errandMap = new Map(errands.map((item) => [item.id, item]));
  const serviceMap = new Map(services.map((item) => [item.id, item]));
  const rentalMap = new Map(rentals.map((item) => [item.id, item]));
  const orderMap = new Map(orders.map((item) => [item.id, item]));
  const rentalOrderMap = new Map(rentalOrders.map((item) => [item.id, item]));

  return conversations.map((conv) => ({
    ...conv,
    product: conv.productId ? productMap.get(conv.productId) ?? null : null,
    errandTask: conv.errandTaskId ? errandMap.get(conv.errandTaskId) ?? null : null,
    serviceListing: conv.serviceListingId ? serviceMap.get(conv.serviceListingId) ?? null : null,
    rentalListing: conv.rentalListingId ? rentalMap.get(conv.rentalListingId) ?? null : null,
    order: conv.orderId ? orderMap.get(conv.orderId) ?? null : null,
    rentalOrder: conv.rentalOrderId ? rentalOrderMap.get(conv.rentalOrderId) ?? null : null,
    participants: participantsByConv.get(conv.id) ?? [],
    messages: messagesByConv.get(conv.id) ?? [],
  }));
}

export async function getUnreadConversationCount(userId: string): Promise<number> {
  const participants = await prisma.conversationParticipant.findMany({
    where: { userId },
    select: {
      conversationId: true,
      lastReadAt: true,
    },
  });

  if (participants.length === 0) return 0;

  const unreadFlags = await Promise.all(
    participants.map(async (participant) => {
      const latestMessage = await prisma.message.findFirst({
        where: {
          conversationId: participant.conversationId,
          senderId: { not: userId },
        },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });

      return Boolean(
        latestMessage &&
          (!participant.lastReadAt || latestMessage.createdAt > participant.lastReadAt),
      );
    }),
  );

  return unreadFlags.filter(Boolean).length;
}

export async function getConversationListItems(
  userId: string,
  options?: {
    search?: string;
    filterType?: string;
  },
): Promise<ConversationListItem[]> {
  const conversations = await prisma.conversation.findMany({
    where: {
      participants: {
        some: { userId },
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  const hydrated = await hydrateConversations(conversations);

  const items: ConversationListItem[] = [];

  for (const conv of hydrated) {
    const currentParticipant = conv.participants.find((item) => item.userId === userId);
    const counterpart = conv.participants.find((item) => item.userId !== userId)?.user;
    const lastMessage = conv.messages[conv.messages.length - 1] ?? null;
    const hasUnread =
      Boolean(lastMessage) &&
      lastMessage.senderId !== userId &&
      (!currentParticipant?.lastReadAt || lastMessage.createdAt > currentParticipant.lastReadAt);

    let bizType: BizType = "PRODUCT";
    let bizTitle = "站内会话";
    let bizCoverUrl: string | null = null;
    let bizTargetId: string | null = null;
    let hasActiveOrder = false;

    if (conv.product) {
      bizType = "PRODUCT";
      bizTitle = conv.product.title;
      bizCoverUrl = conv.product.images[0]?.url || null;
      bizTargetId = conv.product.id;
    } else if (conv.errandTask) {
      bizType = "ERRAND";
      bizTitle = conv.errandTask.title;
      bizTargetId = conv.errandTask.id;
      hasActiveOrder = conv.errandTask.status === "IN_PROGRESS";
    } else if (conv.serviceListing) {
      bizType = "SERVICE";
      bizTitle = conv.serviceListing.title;
      bizCoverUrl = conv.serviceListing.coverImageUrl;
      bizTargetId = conv.serviceListing.id;
    } else if (conv.rentalListing) {
      bizType = "RENTAL";
      bizTitle = conv.rentalListing.title;
      bizCoverUrl = conv.rentalListing.images[0]?.url || null;
      bizTargetId = conv.rentalListing.id;
    } else if (conv.order) {
      bizType = "PRODUCT_ORDER";
      bizTitle = `订单：${conv.order.orderNo}`;
      bizTargetId = conv.order.id;
      hasActiveOrder = !["COMPLETED", "CANCELLED", "REFUNDED"].includes(conv.order.status);
    } else if (conv.rentalOrder) {
      bizType = "RENTAL_ORDER";
      bizTitle = `租赁单：${conv.rentalOrder.orderNumber}`;
      bizTargetId = conv.rentalOrder.id;
      hasActiveOrder = !["COMPLETED", "CANCELLED", "REJECTED", "CLOSED"].includes(conv.rentalOrder.status);
    }

    // 搜索过滤
    if (options?.search) {
      const q = options.search.toLowerCase();
      const matchName = counterpart?.name.toLowerCase().includes(q);
      const matchTitle = bizTitle.toLowerCase().includes(q);
      const matchMsg = lastMessage?.content.toLowerCase().includes(q);
      if (!matchName && !matchTitle && !matchMsg) continue;
    }

    // 类型过滤
    if (options?.filterType && options.filterType !== "ALL") {
      if (options.filterType !== bizType) continue;
    }

    items.push({
      id: conv.id,
      title: conv.title || bizTitle,
      bizType,
      bizTitle,
      bizCoverUrl,
      bizTargetId,
      counterpartId: counterpart?.id ?? "",
      counterpartName: counterpart?.name ?? "匿名同学",
      counterpartAvatarUrl: counterpart?.avatarUrl || null,
      counterpartSchoolName: counterpart?.schoolName ?? "认证高校",
      counterpartVerificationStatus: counterpart?.verificationStatus ?? "UNVERIFIED",
      lastMessageSenderName: lastMessage?.sender?.name ?? "系统",
      lastMessageContent: lastMessage?.content ?? "你们还没有开始聊天",
      lastMessageAt: lastMessage?.createdAt.toISOString() ?? conv.updatedAt.toISOString(),
      updatedAt: conv.updatedAt.toISOString(),
      hasUnread,
      hasActiveOrder,
    });
  }

  return items;
}

export async function getConversationDetailPayload(
  conversationId: string,
  userId: string,
  cursor?: string,
  limit = 20,
): Promise<ConversationDetailPayload> {
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: conversationId,
      participants: {
        some: { userId },
      },
    },
  });

  if (!conversation) {
    notFound();
  }

  const [hydrated] = await hydrateConversations([conversation]);
  const counterpart = hydrated.participants.find((p) => p.userId !== userId)?.user;

  if (!counterpart) {
    notFound();
  }

  // 检查拉黑状态
  const [blockedByMe, blockedMe] = await Promise.all([
    prisma.blockedUser.findUnique({
      where: {
        blockerId_blockedUserId: { blockerId: userId, blockedUserId: counterpart.id },
      },
    }),
    prisma.blockedUser.findUnique({
      where: {
        blockerId_blockedUserId: { blockerId: counterpart.id, blockedUserId: userId },
      },
    }),
  ]);

  // 标记当前用户已读并全量已读本会话
  await Promise.all([
    prisma.conversationParticipant.updateMany({
      where: { conversationId, userId },
      data: { lastReadAt: new Date() },
    }),
    prisma.message.updateMany({
      where: {
        conversationId,
        senderId: { not: userId },
        isRead: false,
      },
      data: { isRead: true },
    }),
  ]);

  // 分页获取消息 (Cursor 向上翻页)
  const messagesRaw = await prisma.message.findMany({
    where: { conversationId },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { createdAt: "desc" },
    include: {
      sender: {
        select: { id: true, name: true, avatarUrl: true },
      },
    },
  });

  let nextCursor: string | null = null;
  if (messagesRaw.length > limit) {
    const nextItem = messagesRaw.pop();
    nextCursor = nextItem?.id ?? null;
  }

  const messages: ConversationMessageItem[] = messagesRaw.reverse().map((msg) => ({
    id: msg.id,
    senderId: msg.senderId,
    senderName: msg.sender?.name ?? "系统通知",
    senderAvatarUrl: msg.sender?.avatarUrl || null,
    type: msg.type,
    content: msg.content,
    isRead: msg.isRead,
    createdAt: msg.createdAt.toISOString(),
  }));

  // 构建业务关联快照
  let relatedBiz: RelatedBizSnapshot | null = null;
  let bizType: BizType = "PRODUCT";

  if (hydrated.product) {
    bizType = "PRODUCT";
    relatedBiz = {
      type: "PRODUCT",
      id: hydrated.product.id,
      title: hydrated.product.title,
      priceText: `¥${Number(hydrated.product.price).toFixed(2)}`,
      coverUrl: hydrated.product.images[0]?.url || null,
      detailUrl: `/products/${hydrated.product.id}`,
    };
  } else if (hydrated.errandTask) {
    bizType = "ERRAND";
    relatedBiz = {
      type: "ERRAND",
      id: hydrated.errandTask.id,
      title: hydrated.errandTask.title,
      priceText: `赏金 ¥${Number(hydrated.errandTask.reward).toFixed(2)}`,
      detailUrl: `/errands/${hydrated.errandTask.id}`,
    };
  } else if (hydrated.serviceListing) {
    bizType = "SERVICE";
    relatedBiz = {
      type: "SERVICE",
      id: hydrated.serviceListing.id,
      title: hydrated.serviceListing.title,
      priceText: `¥${Number(hydrated.serviceListing.price).toFixed(2)}`,
      coverUrl: hydrated.serviceListing.coverImageUrl || null,
      detailUrl: `/services/${hydrated.serviceListing.id}`,
    };
  } else if (hydrated.rentalListing) {
    bizType = "RENTAL";
    relatedBiz = {
      type: "RENTAL",
      id: hydrated.rentalListing.id,
      title: hydrated.rentalListing.title,
      priceText: `租金 ¥${Number(hydrated.rentalListing.price).toFixed(2)}`,
      coverUrl: hydrated.rentalListing.images[0]?.url || null,
      detailUrl: `/rentals/${hydrated.rentalListing.id}`,
    };
  } else if (hydrated.order) {
    bizType = "PRODUCT_ORDER";
    relatedBiz = {
      type: "PRODUCT_ORDER",
      id: hydrated.order.id,
      title: `交易订单 (${hydrated.order.orderNo})`,
      priceText: `实付 ¥${Number(hydrated.order.amount).toFixed(2)}`,
      detailUrl: `/my/orders`,
    };
  } else if (hydrated.rentalOrder) {
    bizType = "RENTAL_ORDER";
    relatedBiz = {
      type: "RENTAL_ORDER",
      id: hydrated.rentalOrder.id,
      title: `租赁订单 (${hydrated.rentalOrder.orderNumber})`,
      priceText: `总额 ¥${Number(hydrated.rentalOrder.finalAmount).toFixed(2)}`,
      detailUrl: `/rental-orders/${hydrated.rentalOrder.id}`,
    };
  }

  return {
    id: hydrated.id,
    bizType,
    title: hydrated.title || relatedBiz?.title || "私聊会话",
    counterpart: {
      id: counterpart.id,
      name: counterpart.name,
      avatarUrl: counterpart.avatarUrl || null,
      schoolName: counterpart.schoolName || "校园用户",
      verificationStatus: counterpart.verificationStatus,
      isBlockedByMe: Boolean(blockedByMe),
      hasBlockedMe: Boolean(blockedMe),
    },
    relatedBiz,
    messages,
    nextCursor,
  };
}
