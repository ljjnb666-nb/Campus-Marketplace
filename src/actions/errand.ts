"use server";

import { redirect } from "next/navigation";
import { decimalValue } from "@/lib/decimal";
import { actionErrorMessage } from "@/lib/error-handler";
import { completeErrandOrderTx } from "@/lib/errand-completion";
import { containsBannedKeyword } from "@/lib/moderation";
import { claimErrandTx } from "@/lib/order-creation";
import { prisma, withTransaction } from "@/lib/prisma";
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
  try {
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
  } catch (error) {
    return { ...initialState, message: actionErrorMessage(error, "createErrand") };
  }
}

export async function updateErrand(
  _prevState: ErrandActionState,
  formData: FormData,
): Promise<ErrandActionState> {
  try {
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
  } catch (error) {
    return { ...initialState, message: actionErrorMessage(error, "updateErrand") };
  }
}

export async function claimErrand(formData: FormData) {
  try {
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

    await withTransaction(async (tx) =>
      claimErrandTx(tx, {
        errandId,
        publisherId: errand.publisherId,
        claimerId: user.id,
        reward: errand.reward,
      }),
    );

    revalidateErrandViews(errandId);
  } catch (error) {
    actionErrorMessage(error, "claimErrand");
  }
}

export async function updateErrandStatus(formData: FormData) {
  try {
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

    await withTransaction(async (tx) => {
      // COMPLETED 走唯一权威实现（completeErrandOrderTx）：硬性要求
      // Order IN_PROGRESS + ErrandTask PENDING_CONFIRMATION，exactly-once
      // 副作用与完成通知都在 canonical 事务内，此处不得再叠加完成副作用
      if (parsed.data.status === "COMPLETED") {
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

        const completion = await completeErrandOrderTx(tx, {
          orderId: latestOrder.id,
          errandTaskId: parsed.data.errandId,
          buyerId: latestOrder.buyerId,
          sellerId: latestOrder.sellerId,
        });

        if (!completion.completed) {
          return;
        }

        return;
      }

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
  } catch (error) {
    actionErrorMessage(error, "updateErrandStatus");
  }
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

  try {
    await prisma.errandTask.update({
      where: { id: errandId },
      data: {
        deletedAt: new Date(),
        status: "CANCELLED",
        accepterId: null,
      },
    });

    revalidateErrandViews(errandId);
  } catch (error) {
    actionErrorMessage(error, "deleteErrand");
  }

  redirect("/my/errands");
}
