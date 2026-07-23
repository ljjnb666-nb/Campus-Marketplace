import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  notificationCreate,
  notificationCreateMany,
  notificationFindMany,
  notificationCount,
} = vi.hoisted(() => ({
  notificationCreate: vi.fn(),
  notificationCreateMany: vi.fn(),
  notificationFindMany: vi.fn(),
  notificationCount: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    notification: {
      create: notificationCreate,
      createMany: notificationCreateMany,
      findMany: notificationFindMany,
      count: notificationCount,
    },
  },
}));

import {
  createNotification,
  createNotifications,
  getNotificationsForUser,
  getUnreadNotificationCount,
} from "@/repositories/notification-repository";

describe("notification repository", () => {
  beforeEach(() => {
    notificationCreate.mockReset();
    notificationCreateMany.mockReset();
    notificationFindMany.mockReset();
    notificationCount.mockReset();
  });

  it("creates one notification with a nullable orderId", async () => {
    await createNotification(
      {
        notification: {
          create: notificationCreate,
        },
      } as never,
      {
        userId: "user-1",
        type: "SYSTEM",
        title: "系统通知",
        content: "资料已更新",
      },
    );

    expect(notificationCreate).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        orderId: null,
        type: "SYSTEM",
        title: "系统通知",
        content: "资料已更新",
      },
    });
  });

  it("skips createMany when there are no notifications to create", async () => {
    await createNotifications(
      {
        notification: {
          createMany: notificationCreateMany,
        },
      } as never,
      [],
    );

    expect(notificationCreateMany).not.toHaveBeenCalled();
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
