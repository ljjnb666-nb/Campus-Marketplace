import { beforeEach, describe, expect, it, vi } from "vitest";

const { notificationFindMany, notificationCount } = vi.hoisted(() => ({
  notificationFindMany: vi.fn(),
  notificationCount: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    notification: {
      findMany: notificationFindMany,
      count: notificationCount,
    },
  },
}));

import {
  getNotificationsForUser,
  getUnreadNotificationCount,
} from "@/repositories/notification-repository";

/**
 * Phase 9B（§20/§50）：createNotification / createNotifications 已从
 * production 移除——写原语收敛到 canonical notification domain
 * （src/lib/notifications/notification-service.ts）。本文件只锁定读取面
 * 合同（/notifications 页面与未读数行为零改动）；写入合同由
 * notification-registry.test.ts / notification-service.test.ts 与
 * direct-writer static gate 承接。
 */
describe("notification repository（读取面）", () => {
  beforeEach(() => {
    notificationFindMany.mockReset();
    notificationCount.mockReset();
  });

  it("returns notifications ordered by createdAt descending and unread count", async () => {
    notificationFindMany.mockResolvedValue([{ id: "notification-1" }]);
    notificationCount.mockResolvedValue(3);

    const [items, unreadCount] = await Promise.all([
      getNotificationsForUser("user-1"),
      getUnreadNotificationCount("user-1"),
    ]);

    expect(notificationFindMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    expect(notificationCount).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        isRead: false,
      },
    });
    expect(items).toEqual([{ id: "notification-1" }]);
    expect(unreadCount).toBe(3);
  });
});
