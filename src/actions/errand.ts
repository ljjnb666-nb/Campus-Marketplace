"use server";

import { redirect } from "next/navigation";
import { decimalValue } from "@/lib/decimal";
import { containsBannedKeyword } from "@/lib/moderation";
import { createOrderNo } from "@/lib/order-no";
import { prisma } from "@/lib/prisma";
import { revalidateErrandViews } from "@/lib/revalidate";
import { requireUser } from "@/lib/server-auth";
import { createNotifications } from "@/repositories/notification-repository";
import { errandFormSchema, errandStatusSchema } from "@/validators/errand";

export type ErrandActionState = {
  success: boolean;
  message: string;
  redirectTo?: string;
};

const initialState: ErrandActionState = {
  success: false,
  message: "",
};

function parseDeadline(input: string) {
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getErrandStatusLabel(
  status: "OPEN" | "CLAIMED" | "IN_PROGRESS" | "PENDING_CONFIRMATION" | "COMPLETED" | "CANCELLED",
) {
  switch (status) {
    case "OPEN":
      return "待接单";
    case "CLAIMED":
      return "已接单";
    case "IN_PROGRESS":
      return "进行中";
    case "PENDING_CONFIRMATION":
      return "待确认完成";
    case "COMPLETED":
      return "已完成";
    case "CANCELLED":
      return "已取消";
  }
}

export async function createErrand(
  _prevState: ErrandActionState,
  formData: FormData,
): Promise<ErrandActionState> {
  const user = await requireUser();

  const parsed = errandFormSchema.safeParse({
    title: formData.get("title"),
    description: formData.get("description"),
    categoryId: formData.get("categoryId"),
    reward: formData.get("reward"),
    pickupLocation: formData.get("pickupLocation"),
    deliveryLocation: formData.get("deliveryLocation"),
    deadline: formData.get("deadline"),
    contactNote: formData.get("contactNote"),
    needsAdvancePay: formData.get("needsAdvancePay"),
    advanceAmount: formData.get("advanceAmount"),
  });

  if (!parsed.success) {
    return {
      ...initialState,
      message: parsed.error.issues[0]?.message ?? "任务信息不完整",
    };
  }

  const deadline = parseDeadline(parsed.data.deadline);
  if (!deadline || deadline <= new Date()) {
    return { ...initialState, message: "截止时间必须晚于当前时间" };
  }

  const bannedKeyword = await containsBannedKeyword(
    `${parsed.data.title}\n${parsed.data.description}\n${parsed.data.contactNote}`,
  );

  if (bannedKeyword) {
    return {
      ...initialState,
      message: `内容命中违规关键词：${bannedKeyword}`,
    };
  }

  const [publisher, category] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.id },
      select: { campusId: true },
    }),
    prisma.errandCategory.findUnique({
      where: { id: parsed.data.categoryId },
      select: { id: true, isActive: true },
    }),
  ]);

  if (!publisher) {
    return { ...initialState, message: "用户不存在" };
  }

  if (!category || !category.isActive) {
    return { ...initialState, message: "任务分类不存在或已停用" };
  }

  const errand = await prisma.errandTask.create({
    data: {
      title: parsed.data.title,
      description: parsed.data.description,
      categoryId: parsed.data.categoryId,
      reward: decimalValue(parsed.data.reward),
      pickupLocation: parsed.data.pickupLocation,
      deliveryLocation: parsed.data.deliveryLocation,
      deadline,
      contactNote: parsed.data.contactNote || null,
      needsAdvancePay: parsed.data.needsAdvancePay === "true",
      advanceAmount:
        parsed.data.advanceAmount && parsed.data.advanceAmount !== ""
          ? decimalValue(parsed.data.advanceAmount)
          : null,
      campusId: publisher.campusId,
      publisherId: user.id,
    },
  });

  revalidateErrandViews(errand.id);

  return {
    success: true,
    message: "任务发布成功",
    redirectTo: `/errands/${errand.id}`,
  };
}

export async function updateErrand(
  _prevState: ErrandActionState,
  formData: FormData,
): Promise<ErrandActionState> {
  const user = await requireUser();
  const errandId = String(formData.get("errandId") ?? "");

  const parsed = errandFormSchema.safeParse({
    title: formData.get("title"),
    description: formData.get("description"),
    categoryId: formData.get("categoryId"),
    reward: formData.get("reward"),
    pickupLocation: formData.get("pickupLocation"),
    deliveryLocation: formData.get("deliveryLocation"),
    deadline: formData.get("deadline"),
    contactNote: formData.get("contactNote"),
    needsAdvancePay: formData.get("needsAdvancePay"),
    advanceAmount: formData.get("advanceAmount"),
  });

  if (!errandId) {
    return { ...initialState, message: "任务不存在" };
  }

  if (!parsed.success) {
    return {
      ...initialState,
      message: parsed.error.issues[0]?.message ?? "任务信息不完整",
    };
  }

  const deadline = parseDeadline(parsed.data.deadline);
  if (!deadline || deadline <= new Date()) {
    return { ...initialState, message: "截止时间必须晚于当前时间" };
  }

  const errand = await prisma.errandTask.findFirst({
    where: {
      id: errandId,
      publisherId: user.id,
      deletedAt: null,
    },
    select: { id: true, status: true },
  });

  if (!errand) {
    return { ...initialState, message: "无权修改该任务" };
  }

  if (errand.status !== "OPEN") {
    return { ...initialState, message: "只有待接单任务允许编辑" };
  }

  const category = await prisma.errandCategory.findUnique({
    where: { id: parsed.data.categoryId },
    select: { id: true, isActive: true },
  });

  if (!category || !category.isActive) {
    return { ...initialState, message: "任务分类不存在或已停用" };
  }

  const bannedKeyword = await containsBannedKeyword(
    `${parsed.data.title}\n${parsed.data.description}\n${parsed.data.contactNote}`,
  );

  if (bannedKeyword) {
    return {
      ...initialState,
      message: `内容命中违规关键词：${bannedKeyword}`,
    };
  }

  await prisma.errandTask.update({
    where: { id: errandId },
    data: {
      title: parsed.data.title,
      description: parsed.data.description,
      categoryId: parsed.data.categoryId,
      reward: decimalValue(parsed.data.reward),
      pickupLocation: parsed.data.pickupLocation,
      deliveryLocation: parsed.data.deliveryLocation,
      deadline,
      contactNote: parsed.data.contactNote || null,
      needsAdvancePay: parsed.data.needsAdvancePay === "true",
      advanceAmount:
        parsed.data.advanceAmount && parsed.data.advanceAmount !== ""
          ? decimalValue(parsed.data.advanceAmount)
          : null,
    },
  });

  revalidateErrandViews(errandId);

  return {
    success: true,
    message: "任务已更新",
    redirectTo: `/errands/${errandId}`,
  };
}

export async function claimErrand(formData: FormData) {
  const user = await requireUser();
  const errandId = String(formData.get("errandId") ?? "");

  if (!errandId) {
    return;
  }

  const errand = await prisma.errandTask.findFirst({
    where: {
      id: errandId,
      deletedAt: null,
    },
    select: {
      id: true,
      publisherId: true,
      accepterId: true,
      status: true,
      reward: true,
    },
  });

  if (!errand || errand.status !== "OPEN" || errand.accepterId) {
    return;
  }

  if (errand.publisherId === user.id) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    const claimResult = await tx.errandTask.updateMany({
      where: {
        id: errandId,
        status: "OPEN",
        accepterId: null,
      },
      data: {
        accepterId: user.id,
        status: "CLAIMED",
      },
    });

    if (claimResult.count === 0) {
      return;
    }

    const order = await tx.order.create({
      data: {
        orderNo: createOrderNo(),
        type: "ERRAND",
        status: "ACCEPTED",
        amount: errand.reward,
        paymentStatus: "OFFLINE_PENDING",
        buyerId: errand.publisherId,
        sellerId: user.id,
        errandTaskId: errand.id,
      },
    });

    await createNotifications(tx, [
      {
        userId: errand.publisherId,
        orderId: order.id,
        type: "ORDER",
        title: "跑腿任务已被接单",
        content: "你的跑腿任务已有同学接单，可以前往订单中心继续跟进。",
      },
      {
        userId: user.id,
        orderId: order.id,
        type: "ORDER",
        title: "你已接下跑腿任务",
        content: "接单成功，请尽快与发布者沟通并推进任务。",
      },
    ]);
  });

  revalidateErrandViews(errandId);
}

export async function updateErrandStatus(formData: FormData) {
  const user = await requireUser();

  const parsed = errandStatusSchema.safeParse({
    errandId: formData.get("errandId"),
    status: formData.get("status"),
  });

  if (!parsed.success) {
    return;
  }

  const errand = await prisma.errandTask.findFirst({
    where: { id: parsed.data.errandId, deletedAt: null },
    select: {
      id: true,
      publisherId: true,
      accepterId: true,
      status: true,
    },
  });

  if (!errand) {
    return;
  }

  const isPublisher = errand.publisherId === user.id;
  const isAccepter = errand.accepterId === user.id;

  const canTransition =
    (parsed.data.status === "OPEN" && isPublisher && errand.status === "CLAIMED") ||
    (parsed.data.status === "IN_PROGRESS" && isAccepter && errand.status === "CLAIMED") ||
    (parsed.data.status === "PENDING_CONFIRMATION" &&
      isAccepter &&
      errand.status === "IN_PROGRESS") ||
    (parsed.data.status === "COMPLETED" &&
      isPublisher &&
      errand.status === "PENDING_CONFIRMATION") ||
    (parsed.data.status === "CANCELLED" && isPublisher && errand.status === "OPEN");

  if (!canTransition) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.errandTask.update({
      where: { id: parsed.data.errandId },
      data: {
        status: parsed.data.status,
        ...(parsed.data.status === "OPEN" ? { accepterId: null } : {}),
      },
    });

    const latestOrder = await tx.order.findFirst({
      where: {
        errandTaskId: parsed.data.errandId,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, buyerId: true, sellerId: true },
    });

    if (!latestOrder) {
      return;
    }

    if (parsed.data.status === "OPEN") {
      await tx.order.update({
        where: { id: latestOrder.id },
        data: {
          status: "CANCELLED",
          cancelReason: "发布者撤销接单",
        },
      });
    }

    if (parsed.data.status === "IN_PROGRESS") {
      await tx.order.update({
        where: { id: latestOrder.id },
        data: { status: "IN_PROGRESS" },
      });
    }

    if (parsed.data.status === "COMPLETED") {
      await tx.order.update({
        where: { id: latestOrder.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
        },
      });

      await tx.user.update({
        where: { id: latestOrder.buyerId },
        data: { completedOrdersCount: { increment: 1 } },
      });

      await tx.user.update({
        where: { id: latestOrder.sellerId },
        data: { completedOrdersCount: { increment: 1 } },
      });
    }

    const statusLabel = getErrandStatusLabel(parsed.data.status);

    await createNotifications(tx, [
      {
        userId: errand.publisherId,
        orderId: latestOrder.id,
        type: "ORDER",
        title: `跑腿任务状态更新：${statusLabel}`,
        content: `当前跑腿任务状态已更新为“${statusLabel}”，请前往订单中心查看。`,
      },
      {
        userId: latestOrder.sellerId,
        orderId: latestOrder.id,
        type: "ORDER",
        title: `跑腿任务状态更新：${statusLabel}`,
        content: `当前跑腿任务状态已更新为“${statusLabel}”，请前往订单中心查看。`,
      },
    ]);
  });

  revalidateErrandViews(parsed.data.errandId);
}

export async function deleteErrand(formData: FormData) {
  const user = await requireUser();
  const errandId = String(formData.get("errandId") ?? "");

  if (!errandId) {
    redirect("/my/errands");
  }

  const errand = await prisma.errandTask.findFirst({
    where: {
      id: errandId,
      publisherId: user.id,
      deletedAt: null,
    },
    select: {
      id: true,
      status: true,
    },
  });

  if (!errand || (errand.status !== "OPEN" && errand.status !== "CANCELLED")) {
    redirect("/my/errands");
  }

  await prisma.errandTask.update({
    where: { id: errandId },
    data: {
      deletedAt: new Date(),
      status: "CANCELLED",
      accepterId: null,
    },
  });

  revalidateErrandViews(errandId);
  redirect("/my/errands");
}
