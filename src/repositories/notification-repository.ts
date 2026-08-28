import { Prisma, type NotificationType } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type NotificationPayload = {
  userId: string;
  orderId?: string | null;
  type: NotificationType;
  title: string;
  content: string;
};

// 写入入口仅接收事务客户端：扩展客户端与基础客户端的联合类型会在
// schema 增大后触发 Prisma 扩展的类型深度超限（excessive stack depth）。
type NotificationClient = Prisma.TransactionClient;

export async function createNotification(client: NotificationClient, payload: NotificationPayload) {
  return client.notification.create({
    data: {
      userId: payload.userId,
      orderId: payload.orderId ?? null,
      type: payload.type,
      title: payload.title,
      content: payload.content,
    },
  });
}

export async function createNotifications(
  client: NotificationClient,
  payloads: NotificationPayload[],
) {
  if (payloads.length === 0) {
    return;
  }

  await client.notification.createMany({
    data: payloads.map((payload) => ({
      userId: payload.userId,
      orderId: payload.orderId ?? null,
      type: payload.type,
      title: payload.title,
      content: payload.content,
    })),
  });
}

export async function getNotificationsForUser(userId: string) {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export async function getUnreadNotificationCount(userId: string) {
  return prisma.notification.count({
    where: {
      userId,
      isRead: false,
    },
  });
}
