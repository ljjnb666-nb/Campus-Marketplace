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
        // Phase 9A：dedupe 身份可省略——不传时行为与历史版本兼容（NULL 落库）
        dedupeKey: null,
        sourceEventId: null,
      },
    });
  });

  it("Phase 9A：携带 dedupeKey 的批量写入启用 skipDuplicates（outbox exactly-once）", async () => {
    notificationCreateMany.mockResolvedValue({ count: 1 });

    await createNotifications(
      {
        notification: {
          createMany: notificationCreateMany,
        },
      } as never,
      [
        {
          userId: "user-1",
          type: "ORDER",
          title: "商品预留已过期",
          content: "卖家未在确认期限内接受订单，商品预留已自动释放。",
          dedupeKey: "OUTBOX:event-1:IN_APP:user-1",
          sourceEventId: "event-1",
        },
      ],
    );

    expect(notificationCreateMany).toHaveBeenCalledWith({
      data: [
        {
          userId: "user-1",
          orderId: null,
          type: "ORDER",
          title: "商品预留已过期",
          content: "卖家未在确认期限内接受订单，商品预留已自动释放。",
          dedupeKey: "OUTBOX:event-1:IN_APP:user-1",
          sourceEventId: "event-1",
        },
      ],
      skipDuplicates: true,
    });
  });

  it("Phase 9A：不携带 dedupeKey 的批量写入保持原语义（skipDuplicates 不出现）", async () => {
    notificationCreateMany.mockResolvedValue({ count: 1 });

    await createNotifications(
      {
        notification: {
          createMany: notificationCreateMany,
        },
      } as never,
      [
        {
          userId: "user-2",
          type: "ORDER",
          title: "订单状态更新：已接单",
          content: "卖家已将订单状态更新为“已接单”，请前往订单中心查看。",
        },
      ],
    );

    expect(notificationCreateMany).toHaveBeenCalledWith({
      data: [
        {
          userId: "user-2",
          orderId: null,
          type: "ORDER",
          title: "订单状态更新：已接单",
          content: "卖家已将订单状态更新为“已接单”，请前往订单中心查看。",
          dedupeKey: null,
          sourceEventId: null,
        },
      ],
      skipDuplicates: false,
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
