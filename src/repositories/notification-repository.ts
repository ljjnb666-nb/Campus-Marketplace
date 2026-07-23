import { Prisma, type NotificationType } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type NotificationPayload = {
  userId: string;
  orderId?: string | null;
  type: NotificationType;
  title: string;
  content: string;
};

type NotificationClient = Prisma.TransactionClient | typeof prisma;

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
