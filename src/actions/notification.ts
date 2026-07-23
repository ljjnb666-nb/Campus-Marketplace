"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/server-auth";

function revalidateNotificationViews() {
  revalidatePath("/notifications");
  revalidatePath("/profile");
}

export async function markNotificationRead(formData: FormData) {
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
}

export async function markAllNotificationsRead() {
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
}
