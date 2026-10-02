import { Prisma, type NotificationType } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type NotificationPayload = {
  userId: string;
  orderId?: string | null;
  type: NotificationType;
  title: string;
  content: string;
  // Phase 9A：outbox-driven 通知的 exactly-once 身份（可省略——历史同步
  // 调用不传，行为完全兼容；dedupeKey 命中 UNIQUE 时由调用方选择
  // skipDuplicates 或 upsert 语义）
  dedupeKey?: string | null;
  sourceEventId?: string | null;
};

// 写入入口仅接收事务客户端：扩展客户端与基础客户端的联合类型会在
// schema 增大后触发 Prisma 扩展的类型深度超限（excessive stack depth）。
type NotificationClient = Prisma.TransactionClient;

function toNotificationRow(payload: NotificationPayload) {
  return {
    userId: payload.userId,
    orderId: payload.orderId ?? null,
    type: payload.type,
    title: payload.title,
    content: payload.content,
    dedupeKey: payload.dedupeKey ?? null,
    sourceEventId: payload.sourceEventId ?? null,
  };
}

export async function createNotification(client: NotificationClient, payload: NotificationPayload) {
  return client.notification.create({
    data: toNotificationRow(payload),
  });
}

/**
 * Phase 9A：批量写入。dedupeKey 携带时以 skipDuplicates 保证 DB 级
 * exactly-once（并发/重放安全）；不携带时行为与历史版本逐字兼容。
 */
export async function createNotifications(
  client: NotificationClient,
  payloads: NotificationPayload[],
) {
  if (payloads.length === 0) {
    return;
  }

  const hasDedupeKey = payloads.some((payload) => payload.dedupeKey != null);

  await client.notification.createMany({
    data: payloads.map(toNotificationRow),
    skipDuplicates: hasDedupeKey,
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
