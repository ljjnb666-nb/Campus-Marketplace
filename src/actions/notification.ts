"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { actionErrorMessage } from "@/lib/error-handler";
import { requireUser } from "@/lib/server-auth";

function revalidateNotificationViews() {
  revalidatePath("/notifications");
  revalidatePath("/profile");
}

export async function markNotificationRead(formData: FormData) {
  try {
    const user = await requireUser();
    const notificationId = String(formData.get("notificationId") ?? "");

    if (!notificationId) {
      return;
    }

    await prisma.notification.updateMany({
      where: {
        id: notificationId,
        userId: user.id,
        isRead: false,
      },
      data: {
        isRead: true,
      },
    });

    revalidateNotificationViews();
  } catch (error) {
    actionErrorMessage(error, "markNotificationRead");
  }
}

export async function markAllNotificationsRead() {
  try {
    const user = await requireUser();

    await prisma.notification.updateMany({
      where: {
        userId: user.id,
        isRead: false,
      },
      data: {
        isRead: true,
      },
    });

    revalidateNotificationViews();
  } catch (error) {
    actionErrorMessage(error, "markAllNotificationsRead");
  }
}
