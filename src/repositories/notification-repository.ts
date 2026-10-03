import { prisma } from "@/lib/prisma";

/**
 * Notification 读取面（Phase 9B 收敛后仅存 read primitives）。
 *
 * Phase 9B（§17/§20/§50）：createNotification / createNotifications 已从
 * production 移除——所有 production 通知写入必须经 canonical notification
 * domain（src/lib/notifications/notification-service.ts emitNotificationTx/
 * emitNotificationsTx），title/content 由 notification-registry 渲染器生成，
 * 业务域不再持有任意 title/content 写入能力。静态 gate（direct-writer gate
 * test）保证新增直写 → CI fail。
 *
 * 本文件的读原语保持 /notifications 页面与未读数行为完全不变（§51）。
 */

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
