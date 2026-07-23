import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePath,
  requireUser,
  notificationUpdateMany,
} = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireUser: vi.fn(),
  notificationUpdateMany: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath,
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    notification: {
      updateMany: notificationUpdateMany,
    },
  },
}));

import { markAllNotificationsRead, markNotificationRead } from "@/actions/notification";

describe("notification actions", () => {
  beforeEach(() => {
    revalidatePath.mockReset();
    requireUser.mockReset();
    notificationUpdateMany.mockReset();

    requireUser.mockResolvedValue({ id: "user-1", role: "STUDENT" });
  });

  it("marks one unread notification as read for the current user", async () => {
    const formData = new FormData();
    formData.set("notificationId", "notification-1");

    await markNotificationRead(formData);

    expect(notificationUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "notification-1",
        userId: "user-1",
        isRead: false,
      },
      data: {
        isRead: true,
      },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/notifications");
    expect(revalidatePath).toHaveBeenCalledWith("/profile");
  });

  it("marks all unread notifications as read for the current user", async () => {
    await markAllNotificationsRead();

    expect(notificationUpdateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        isRead: false,
      },
      data: {
        isRead: true,
      },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/notifications");
    expect(revalidatePath).toHaveBeenCalledWith("/profile");
  });
});
