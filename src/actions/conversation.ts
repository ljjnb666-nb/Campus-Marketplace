"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { computeConversationKey } from "@/lib/conversation-key";
import { containsBannedKeyword } from "@/lib/moderation";
import { prisma, withTransaction } from "@/lib/prisma";
import { requireUser } from "@/lib/server-auth";
import { createNotification } from "@/repositories/notification-repository";
import {
  errandConversationSchema,
  orderConversationSchema,
  productConversationSchema,
  rentalConversationSchema,
  sendMessageSchema,
  serviceConversationSchema,
} from "@/validators/conversation";

export type ConversationActionState = {
  success: boolean;
  message: string;
  redirectTo?: string;
};

function revalidateConversationPages(conversationId?: string) {
  revalidatePath("/messages");
  revalidatePath("/notifications");
  if (conversationId) {
    revalidatePath(`/messages/${conversationId}`);
  }
}

// 统一并发安全的防重查找与创建
async function getOrCreateConversationSafe(
  bizType: "PRODUCT" | "ERRAND" | "SERVICE" | "RENTAL" | "PRODUCT_ORDER" | "RENTAL_ORDER",
  bizKeyField: "productId" | "errandTaskId" | "serviceListingId" | "rentalListingId" | "orderId" | "rentalOrderId",
  bizId: string,
  participantIds: string[],
  initialData: {
    title: string;
    initialMessageContent: string;
    notificationTitle: string;
    notificationContent: string;
    counterpartId: string;
    currentUserId: string;
  },
) {
  // 0. 验证参与者用户账号合法性
  const validUsers = await prisma.user.findMany({
    where: { id: { in: participantIds } },
    select: { id: true },
  });
  const validUserIds = new Set(validUsers.map((u) => u.id));

  if (!validUserIds.has(initialData.currentUserId)) {
    redirect("/login");
  }

  if (!validUserIds.has(initialData.counterpartId)) {
    return null;
  }

  const conversationKey = await computeConversationKey(bizType, bizId, participantIds);

  // 1. 优先根据数据库 UNIQUE 键检索
  const existing = await prisma.conversation.findUnique({
    where: { conversationKey },
    select: { id: true },
  });

  if (existing) {
    return existing;
  }

  // 2. 数据库事务并发创建
  try {
    const created = await withTransaction(async (tx) => {
      const conv = await tx.conversation.create({
        data: {
          title: initialData.title,
          conversationKey,
          [bizKeyField]: bizId,
          participants: {
            create: participantIds.map((pid) => ({
              userId: pid,
              lastReadAt: pid === initialData.currentUserId ? new Date() : null,
            })),
          },
          messages: {
            create: {
              senderId: initialData.currentUserId,
              type: "DIRECT",
              content: initialData.initialMessageContent,
            },
          },
        },
        select: { id: true },
      });

      await createNotification(tx, {
        userId: initialData.counterpartId,
        type: "MESSAGE",
        title: initialData.notificationTitle,
        content: initialData.notificationContent,
      });

      return conv;
    });

    return created;
  } catch (error: unknown) {
    // 捕获并发产生的 P2002 唯一键冲突，Fallback 获取先建立的会话
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      const fallback = await prisma.conversation.findUnique({
        where: { conversationKey },
        select: { id: true },
      });
      if (fallback) return fallback;
    }
    throw error;
  }
}

// 1. 二手商品沟通
export async function createOrOpenProductConversation(formData: FormData) {
  const user = await requireUser();

  const parsed = productConversationSchema.safeParse({
    productId: formData.get("productId"),
  });

  if (!parsed.success) {
    redirect("/products");
  }

  const product = await prisma.product.findFirst({
    where: { id: parsed.data.productId, deletedAt: null },
    select: { id: true, title: true, sellerId: true },
  });

  if (!product || product.sellerId === user.id) {
    redirect(`/products/${parsed.data.productId}`);
  }

  const participantIds = [user.id, product.sellerId];
  const conversation = await getOrCreateConversationSafe(
    "PRODUCT",
    "productId",
    product.id,
    participantIds,
    {
      title: `商品咨询：${product.title}`,
      initialMessageContent: `你好，我想咨询一下“${product.title}”。`,
      notificationTitle: "收到新的商品咨询",
      notificationContent: `有同学就“${product.title}”向你发起了会话，快去看看。`,
      counterpartId: product.sellerId,
      currentUserId: user.id,
    },
  );

  if (!conversation) {
    redirect(`/products/${parsed.data.productId}`);
  }

  revalidateConversationPages(conversation.id);
  redirect(`/messages/${conversation.id}`);
}

// 2. 跑腿任务沟通
export async function createOrOpenErrandConversation(formData: FormData) {
  const user = await requireUser();

  const parsed = errandConversationSchema.safeParse({
    errandId: formData.get("errandId"),
  });

  if (!parsed.success) {
    redirect("/errands");
  }

  const errand = await prisma.errandTask.findFirst({
    where: { id: parsed.data.errandId, deletedAt: null },
    select: { id: true, title: true, publisherId: true, accepterId: true },
  });

  if (!errand) {
    redirect("/errands");
  }

  const counterpartId = errand.publisherId === user.id ? errand.accepterId : errand.publisherId;
  if (!counterpartId || counterpartId === user.id) {
    redirect(`/errands/${errand.id}`);
  }

  const participantIds = [user.id, counterpartId];
  const conversation = await getOrCreateConversationSafe(
    "ERRAND",
    "errandTaskId",
    errand.id,
    participantIds,
    {
      title: `跑腿沟通：${errand.title}`,
      initialMessageContent: `你好，关于跑腿任务“${errand.title}”与你沟通一下。`,
      notificationTitle: "收到跑腿任务沟通",
      notificationContent: `有同学就“${errand.title}”向你发起了沟通。`,
      counterpartId,
      currentUserId: user.id,
    },
  );

  if (!conversation) {
    redirect(`/errands/${errand.id}`);
  }

  revalidateConversationPages(conversation.id);
  redirect(`/messages/${conversation.id}`);
}

// 3. 技能服务沟通
export async function createOrOpenServiceConversation(formData: FormData) {
  const user = await requireUser();

  const parsed = serviceConversationSchema.safeParse({
    serviceId: formData.get("serviceId"),
  });

  if (!parsed.success) {
    redirect("/services");
  }

  const service = await prisma.serviceListing.findFirst({
    where: { id: parsed.data.serviceId, deletedAt: null },
    select: { id: true, title: true, providerId: true },
  });

  if (!service || service.providerId === user.id) {
    redirect(`/services/${parsed.data.serviceId}`);
  }

  const participantIds = [user.id, service.providerId];
  const conversation = await getOrCreateConversationSafe(
    "SERVICE",
    "serviceListingId",
    service.id,
    participantIds,
    {
      title: `服务咨询：${service.title}`,
      initialMessageContent: `你好，我想预约咨询你的“${service.title}”服务。`,
      notificationTitle: "收到新的服务预约咨询",
      notificationContent: `有同学就“${service.title}”向你发起了会话。`,
      counterpartId: service.providerId,
      currentUserId: user.id,
    },
  );

  if (!conversation) {
    redirect(`/services/${parsed.data.serviceId}`);
  }

  revalidateConversationPages(conversation.id);
  redirect(`/messages/${conversation.id}`);
}

// 4. 租赁物品沟通
export async function createOrOpenRentalConversation(formData: FormData) {
  const user = await requireUser();

  const parsed = rentalConversationSchema.safeParse({
    rentalListingId: formData.get("rentalListingId"),
  });

  if (!parsed.success) {
    redirect("/rentals");
  }

  const rental = await prisma.rentalListing.findFirst({
    where: { id: parsed.data.rentalListingId, deletedAt: null },
    select: { id: true, title: true, ownerId: true },
  });

  if (!rental || rental.ownerId === user.id) {
    redirect(`/rentals/${parsed.data.rentalListingId}`);
  }

  const participantIds = [user.id, rental.ownerId];
  const conversation = await getOrCreateConversationSafe(
    "RENTAL",
    "rentalListingId",
    rental.id,
    participantIds,
    {
      title: `租赁咨询：${rental.title}`,
      initialMessageContent: `你好，我想咨询租用“${rental.title}”。`,
      notificationTitle: "收到物品租赁咨询",
      notificationContent: `有同学向你咨询“${rental.title}”的出租详情。`,
      counterpartId: rental.ownerId,
      currentUserId: user.id,
    },
  );

  if (!conversation) {
    redirect(`/rentals/${parsed.data.rentalListingId}`);
  }

  revalidateConversationPages(conversation.id);
  redirect(`/messages/${conversation.id}`);
}

// 5. 订单直接联系对方沟通
export async function createOrOpenOrderConversation(formData: FormData) {
  const user = await requireUser();

  const parsed = orderConversationSchema.safeParse({
    orderId: formData.get("orderId"),
    orderType: formData.get("orderType"),
  });

  if (!parsed.success) {
    redirect("/my/orders");
  }

  let counterpartId = "";
  let orderTitle = "";
  let orderKey: "orderId" | "rentalOrderId" = "orderId";
  let bizType: "PRODUCT_ORDER" | "RENTAL_ORDER" = "PRODUCT_ORDER";

  if (parsed.data.orderType === "RENTAL") {
    const rentalOrder = await prisma.rentalOrder.findFirst({
      where: {
        id: parsed.data.orderId,
        OR: [{ ownerId: user.id }, { renterId: user.id }],
      },
      select: { id: true, orderNumber: true, ownerId: true, renterId: true },
    });
    if (!rentalOrder) redirect("/my/orders");
    counterpartId = rentalOrder.ownerId === user.id ? rentalOrder.renterId : rentalOrder.ownerId;
    orderTitle = `租赁订单：${rentalOrder.orderNumber}`;
    orderKey = "rentalOrderId";
    bizType = "RENTAL_ORDER";
  } else {
    const order = await prisma.order.findFirst({
      where: {
        id: parsed.data.orderId,
        OR: [{ buyerId: user.id }, { sellerId: user.id }],
      },
      select: { id: true, orderNo: true, buyerId: true, sellerId: true },
    });
    if (!order) redirect("/my/orders");
    counterpartId = order.buyerId === user.id ? order.sellerId : order.buyerId;
    orderTitle = `订单：${order.orderNo}`;
    orderKey = "orderId";
    bizType = "PRODUCT_ORDER";
  }

  const participantIds = [user.id, counterpartId];
  const conversation = await getOrCreateConversationSafe(
    bizType,
    orderKey,
    parsed.data.orderId,
    participantIds,
    {
      title: orderTitle,
      initialMessageContent: `你好，关于“${orderTitle}”想和你沟通一下交接事宜。`,
      notificationTitle: "收到订单交易联系",
      notificationContent: `关于“${orderTitle}”，交易对方向你发起了会话。`,
      counterpartId,
      currentUserId: user.id,
    },
  );

  if (!conversation) {
    redirect("/my/orders");
  }

  revalidateConversationPages(conversation.id);
  redirect(`/messages/${conversation.id}`);
}

// 6. 发送文本消息 Action
export async function sendMessage(
  _prevState: ConversationActionState,
  formData: FormData,
): Promise<ConversationActionState> {
  const user = await requireUser();

  const parsed = sendMessageSchema.safeParse({
    conversationId: formData.get("conversationId"),
    content: formData.get("content"),
  });

  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "消息格式有误" };
  }

  const { conversationId, content } = parsed.data;

  // 1. 验证用户是该会话参与者
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: conversationId,
      participants: {
        some: { userId: user.id },
      },
    },
    include: {
      participants: { select: { userId: true } },
    },
  });

  if (!conversation) {
    return { success: false, message: "无权在该会话中发送消息" };
  }

  const counterpartId = conversation.participants.find((p) => p.userId !== user.id)?.userId;

  if (counterpartId) {
    // 2. 检查拉黑状态
    const blockedByMe = await prisma.blockedUser.findUnique({
      where: {
        blockerId_blockedUserId: { blockerId: counterpartId, blockedUserId: user.id },
      },
    });
    if (blockedByMe) {
      return { success: false, message: "对方对你设置了消息屏蔽，无法发送" };
    }
  }

  // 3. 关键词过滤
  if (await containsBannedKeyword(content)) {
    return { success: false, message: "消息包含敏感违规内容，发送失败" };
  }

  // 4. 发送消息并更新会话更新时间
  await withTransaction(async (tx) => {
    await tx.message.create({
      data: {
        conversationId,
        senderId: user.id,
        type: "DIRECT",
        content,
      },
    });

    await tx.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    await tx.conversationParticipant.updateMany({
      where: { conversationId, userId: user.id },
      data: { lastReadAt: new Date() },
    });
  });

  revalidateConversationPages(conversationId);
  return { success: true, message: "发送成功" };
}
