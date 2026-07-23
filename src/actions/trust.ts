"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/server-auth";
import { createNotification } from "@/repositories/notification-repository";
import { reportFormSchema, reviewFormSchema } from "@/validators/trust";

export type TrustActionState = {
  success: boolean;
  message: string;
  redirectTo?: string;
};

const initialState: TrustActionState = {
  success: false,
  message: "",
};

async function refreshUserRating(targetUserId: string) {
  const aggregate = await prisma.review.aggregate({
    where: { targetUserId },
    _avg: { rating: true },
    _count: { rating: true },
  });

  const averageRating = aggregate._avg.rating ?? 0;
  const count = aggregate._count.rating ?? 0;

  await prisma.user.update({
    where: { id: targetUserId },
    data: {
      positiveReviewRate: count === 0 ? 0 : averageRating / 5,
    },
  });
}

export async function createReview(
  _prevState: TrustActionState,
  formData: FormData,
): Promise<TrustActionState> {
  const user = await requireUser();

  const parsed = reviewFormSchema.safeParse({
    orderId: formData.get("orderId"),
    targetUserId: formData.get("targetUserId"),
    rating: formData.get("rating"),
    content: formData.get("content"),
    tags: formData.get("tags"),
  });

  if (!parsed.success) {
    return {
      ...initialState,
      message: parsed.error.issues[0]?.message ?? "评价信息不完整",
    };
  }

  const order = await prisma.order.findUnique({
    where: { id: parsed.data.orderId },
    select: {
      id: true,
      status: true,
      buyerId: true,
      sellerId: true,
      reviews: {
        where: { authorId: user.id },
        select: { id: true },
      },
    },
  });

  if (!order || order.status !== "COMPLETED") {
    return { ...initialState, message: "只有已完成订单可以评价" };
  }

  const isBuyer = order.buyerId === user.id;
  const isSeller = order.sellerId === user.id;

  if (!isBuyer && !isSeller) {
    return { ...initialState, message: "你无权评价该订单" };
  }

  const expectedTargetUserId = isBuyer ? order.sellerId : order.buyerId;

  if (parsed.data.targetUserId !== expectedTargetUserId) {
    return { ...initialState, message: "评价对象不正确" };
  }

  if (order.reviews.length > 0) {
    return { ...initialState, message: "你已经评价过该订单" };
  }

  await prisma.$transaction(async (tx) => {
    await tx.review.create({
      data: {
        orderId: order.id,
        authorId: user.id,
        targetUserId: parsed.data.targetUserId,
        rating: Number(parsed.data.rating),
        content: parsed.data.content || null,
        tags: parsed.data.tags
          ? parsed.data.tags
              .split(/[，,]/)
              .map((item) => item.trim())
              .filter(Boolean)
          : [],
      },
    });

    await createNotification(tx, {
      userId: parsed.data.targetUserId,
      orderId: order.id,
      type: "REVIEW",
      title: "收到新的订单评价",
      content: `${user.name} 已为这笔订单提交评价，快去个人中心查看最新口碑表现。`,
    });
  });

  await refreshUserRating(parsed.data.targetUserId);

  revalidatePath("/my/orders");
  revalidatePath("/my/reviews");
  revalidatePath("/profile");
  revalidatePath("/notifications");

  return {
    success: true,
    message: "评价已提交",
    redirectTo: "/my/orders",
  };
}

export async function createReport(
  _prevState: TrustActionState,
  formData: FormData,
): Promise<TrustActionState> {
  const user = await requireUser();

  const parsed = reportFormSchema.safeParse({
    targetType: formData.get("targetType"),
    reason: formData.get("reason"),
    detail: formData.get("detail"),
    productId: formData.get("productId"),
    errandTaskId: formData.get("errandTaskId"),
    serviceListingId: formData.get("serviceListingId"),
    targetUserId: formData.get("targetUserId"),
    messageId: formData.get("messageId"),
  });

  if (!parsed.success) {
    return {
      ...initialState,
      message: parsed.error.issues[0]?.message ?? "举报信息不完整",
    };
  }

  const payload =
    parsed.data.targetType === "PRODUCT"
      ? { productId: parsed.data.productId || null }
      : parsed.data.targetType === "ERRAND_TASK"
        ? { errandTaskId: parsed.data.errandTaskId || null }
        : parsed.data.targetType === "SERVICE_LISTING"
          ? { serviceListingId: parsed.data.serviceListingId || null }
          : parsed.data.targetType === "USER"
            ? { targetUserId: parsed.data.targetUserId || null }
            : { messageId: parsed.data.messageId || null };

  let targetOwnerId: string | null = null;

  if (parsed.data.targetType === "PRODUCT") {
    const targetRecord = await prisma.product.findFirst({
      where: { id: parsed.data.productId, deletedAt: null },
      select: { id: true, sellerId: true },
    });

    if (!targetRecord) {
      return { ...initialState, message: "举报目标不存在" };
    }

    targetOwnerId = targetRecord.sellerId;
  } else if (parsed.data.targetType === "ERRAND_TASK") {
    const targetRecord = await prisma.errandTask.findFirst({
      where: { id: parsed.data.errandTaskId, deletedAt: null },
      select: { id: true, publisherId: true },
    });

    if (!targetRecord) {
      return { ...initialState, message: "举报目标不存在" };
    }

    targetOwnerId = targetRecord.publisherId;
  } else if (parsed.data.targetType === "SERVICE_LISTING") {
    const targetRecord = await prisma.serviceListing.findFirst({
      where: { id: parsed.data.serviceListingId, deletedAt: null },
      select: { id: true, providerId: true },
    });

    if (!targetRecord) {
      return { ...initialState, message: "举报目标不存在" };
    }

    targetOwnerId = targetRecord.providerId;
  } else if (parsed.data.targetType === "USER") {
    const targetRecord = await prisma.user.findFirst({
      where: { id: parsed.data.targetUserId, deletedAt: null },
      select: { id: true },
    });

    if (!targetRecord) {
      return { ...initialState, message: "举报目标不存在" };
    }

    targetOwnerId = targetRecord.id;
  } else {
    const targetRecord = await prisma.message.findUnique({
      where: { id: parsed.data.messageId },
      select: { id: true, senderId: true },
    });

    if (!targetRecord) {
      return { ...initialState, message: "举报目标不存在" };
    }

    targetOwnerId = targetRecord.senderId;
  }

  if (targetOwnerId && targetOwnerId === user.id) {
    return { ...initialState, message: "不能举报自己发布或发送的内容" };
  }

  const existingOpenReport = await prisma.report.findFirst({
    where: {
      reporterId: user.id,
      targetType: parsed.data.targetType,
      status: {
        in: ["OPEN", "IN_REVIEW"],
      },
      ...payload,
    },
    select: {
      id: true,
    },
  });

  if (existingOpenReport) {
    return { ...initialState, message: "该目标已有待处理举报，请勿重复提交" };
  }

  await prisma.$transaction(async (tx) => {
    const report = await tx.report.create({
      data: {
        reporterId: user.id,
        targetType: parsed.data.targetType,
        reason: parsed.data.reason,
        detail: parsed.data.detail || null,
        ...payload,
      },
    });

    await createNotification(tx, {
      userId: user.id,
      type: "REPORT",
      title: "举报已提交",
      content: `你的举报已受理，编号 ${report.id.slice(-8)}，平台会尽快核查并在处理后通知你。`,
    });
  });

  revalidatePath("/products");
  revalidatePath("/errands");
  revalidatePath("/services");
  revalidatePath("/users");
  revalidatePath("/reports");
  revalidatePath("/notifications");

  return {
    success: true,
    message: "举报已提交，客服人员会尽快审核处理",
  };
}

export async function blockUser(
  _prevState: TrustActionState,
  formData: FormData,
): Promise<TrustActionState> {
  const user = await requireUser();
  const targetUserId = formData.get("targetUserId") as string;
  const reason = (formData.get("reason") as string) || "消息打扰或违规行为";

  if (!targetUserId || targetUserId === user.id) {
    return { success: false, message: "无效的拉黑目标" };
  }

  await prisma.blockedUser.upsert({
    where: {
      blockerId_blockedUserId: {
        blockerId: user.id,
        blockedUserId: targetUserId,
      },
    },
    create: {
      blockerId: user.id,
      blockedUserId: targetUserId,
      reason,
    },
    update: {
      reason,
    },
  });

  revalidatePath("/messages");
  return { success: true, message: "已成功拉黑该用户" };
}

export async function unblockUser(
  _prevState: TrustActionState,
  formData: FormData,
): Promise<TrustActionState> {
  const user = await requireUser();
  const targetUserId = formData.get("targetUserId") as string;

  if (!targetUserId) {
    return { success: false, message: "参数缺失" };
  }

  await prisma.blockedUser.deleteMany({
    where: {
      blockerId: user.id,
      blockedUserId: targetUserId,
    },
  });

  revalidatePath("/messages");
  return { success: true, message: "已解除拉黑" };
}
