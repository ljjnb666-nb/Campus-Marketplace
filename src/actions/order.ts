"use server";

import { Prisma } from "@prisma/client";
import { decimalValue } from "@/lib/decimal";
import { actionErrorMessage } from "@/lib/error-handler";
import { createOrderNo } from "@/lib/order-no";
import { prisma, withTransaction } from "@/lib/prisma";
import { revalidateOrderViews } from "@/lib/revalidate";
import { requireUser } from "@/lib/server-auth";
import { createNotifications } from "@/repositories/notification-repository";
import { orderStatusSchema, productOrderFormSchema, serviceOrderFormSchema } from "@/validators/order";

export type OrderActionState = {
  success: boolean;
  message: string;
  redirectTo?: string;
};

const initialState: OrderActionState = {
  success: false,
  message: "",
};

async function incrementCompletedUsers(
  tx: Prisma.TransactionClient,
  buyerId: string,
  sellerId: string,
) {
  await tx.user.update({
    where: { id: buyerId },
    data: { completedOrdersCount: { increment: 1 } },
  });

  await tx.user.update({
    where: { id: sellerId },
    data: { completedOrdersCount: { increment: 1 } },
  });
}

function getStatusLabel(status: "ACCEPTED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED") {
  switch (status) {
    case "ACCEPTED":
      return "已接受";
    case "IN_PROGRESS":
      return "进行中";
    case "COMPLETED":
      return "已完成";
    case "CANCELLED":
      return "已取消";
  }
}

export async function createProductOrder(
  _prevState: OrderActionState,
  formData: FormData,
): Promise<OrderActionState> {
  try {
    const user = await requireUser();

    const parsed = productOrderFormSchema.safeParse({
      productId: formData.get("productId"),
      meetingLocation: formData.get("meetingLocation"),
      note: formData.get("note"),
    });

    if (!parsed.success) {
      return {
        ...initialState,
        message: parsed.error.issues[0]?.message ?? "购买信息不完整",
      };
    }

    const product = await prisma.product.findFirst({
      where: {
        id: parsed.data.productId,
        deletedAt: null,
        status: "ACTIVE",
      },
      select: {
        id: true,
        price: true,
        sellerId: true,
      },
    });

    if (!product) {
      return { ...initialState, message: "商品不存在或当前不可购买" };
    }

    if (product.sellerId === user.id) {
      return { ...initialState, message: "不能购买自己发布的商品" };
    }

    const existingOrder = await prisma.order.findFirst({
      where: {
        productId: product.id,
        status: {
          in: ["PENDING", "ACCEPTED", "IN_PROGRESS"],
        },
      },
      select: { id: true },
    });

    if (existingOrder) {
      return { ...initialState, message: "该商品已有进行中的订单" };
    }

    const order = await withTransaction(async (tx) => {
      const reserveResult = await tx.product.updateMany({
        where: {
          id: product.id,
          status: "ACTIVE",
          deletedAt: null,
        },
        data: { status: "RESERVED" },
      });

      if (reserveResult.count === 0) {
        return null;
      }

      const nextOrder = await tx.order.create({
        data: {
          orderNo: createOrderNo(),
          type: "PRODUCT",
          amount: decimalValue(product.price.toString()),
          meetingLocation: parsed.data.meetingLocation,
          note: parsed.data.note || null,
          paymentStatus: "OFFLINE_PENDING",
          buyerId: user.id,
          sellerId: product.sellerId,
          productId: product.id,
        },
      });

      await createNotifications(tx, [
        {
          userId: user.id,
          orderId: nextOrder.id,
          type: "ORDER",
          title: "购买申请已提交",
          content: "你的商品购买申请已提交，等待卖家确认。",
        },
        {
          userId: product.sellerId,
          orderId: nextOrder.id,
          type: "ORDER",
          title: "收到新的商品订单",
          content: "有同学提交了你的商品购买申请，请尽快确认订单状态。",
        },
      ]);

      return nextOrder;
    });

    if (!order) {
      return { ...initialState, message: "该商品已有进行中的订单" };
    }

    revalidateOrderViews({ productId: product.id });

    return {
      success: true,
      message: "购买申请已提交，等待卖家确认",
      redirectTo: "/my/orders",
    };
  } catch (error) {
    return { ...initialState, message: actionErrorMessage(error, "createProductOrder") };
  }
}

export async function createServiceOrder(
  _prevState: OrderActionState,
  formData: FormData,
): Promise<OrderActionState> {
  try {
    const user = await requireUser();

    const parsed = serviceOrderFormSchema.safeParse({
      serviceId: formData.get("serviceId"),
      meetingLocation: formData.get("meetingLocation"),
      note: formData.get("note"),
    });

    if (!parsed.success) {
      return {
        ...initialState,
        message: parsed.error.issues[0]?.message ?? "预约信息不完整",
      };
    }

    const service = await prisma.serviceListing.findFirst({
      where: {
        id: parsed.data.serviceId,
        deletedAt: null,
        status: "ACTIVE",
      },
      select: {
        id: true,
        price: true,
        providerId: true,
      },
    });

    if (!service) {
      return { ...initialState, message: "服务不存在或当前不可预约" };
    }

    if (service.providerId === user.id) {
      return { ...initialState, message: "不能预约自己发布的服务" };
    }

    await withTransaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          orderNo: createOrderNo(),
          type: "SERVICE",
          amount: decimalValue(service.price.toString()),
          meetingLocation: parsed.data.meetingLocation,
          note: parsed.data.note || null,
          paymentStatus: "OFFLINE_PENDING",
          buyerId: user.id,
          sellerId: service.providerId,
          serviceListingId: service.id,
        },
      });

      await createNotifications(tx, [
        {
          userId: user.id,
          orderId: order.id,
          type: "ORDER",
          title: "服务预约已提交",
          content: "你的服务预约已提交，等待服务提供者确认。",
        },
        {
          userId: service.providerId,
          orderId: order.id,
          type: "ORDER",
          title: "收到新的服务预约",
          content: "有同学预约了你的服务，请尽快确认并安排后续沟通。",
        },
      ]);
    });

    revalidateOrderViews({ serviceId: service.id });

    return {
      success: true,
      message: "预约已提交，等待服务提供者确认",
      redirectTo: "/my/orders",
    };
  } catch (error) {
    return { ...initialState, message: actionErrorMessage(error, "createServiceOrder") };
  }
}

export async function updateOrderStatus(formData: FormData) {
  try {
    const user = await requireUser();

    const parsed = orderStatusSchema.safeParse({
      orderId: formData.get("orderId"),
      status: formData.get("status"),
    });

    if (!parsed.success) {
      return;
    }

    const order = await prisma.order.findUnique({
      where: { id: parsed.data.orderId },
      select: {
        id: true,
        type: true,
        status: true,
        buyerId: true,
        sellerId: true,
        productId: true,
        errandTaskId: true,
        serviceListingId: true,
      },
    });

    if (!order) {
      return;
    }

    const isBuyer = order.buyerId === user.id;
    const isSeller = order.sellerId === user.id;

    const canTransition =
      (parsed.data.status === "ACCEPTED" &&
        isSeller &&
        order.status === "PENDING" &&
        (order.type === "PRODUCT" || order.type === "SERVICE")) ||
      (parsed.data.status === "IN_PROGRESS" &&
        isSeller &&
        order.status === "ACCEPTED" &&
        (order.type === "SERVICE" || order.type === "ERRAND")) ||
      (parsed.data.status === "COMPLETED" &&
        ((order.type === "PRODUCT" && isBuyer && order.status === "ACCEPTED") ||
          (order.type === "SERVICE" &&
            ((isBuyer && order.status === "IN_PROGRESS") ||
              (isSeller && order.status === "IN_PROGRESS"))) ||
          (order.type === "ERRAND" && isBuyer && order.status === "IN_PROGRESS"))) ||
      (parsed.data.status === "CANCELLED" &&
        ((order.type === "PRODUCT" && order.status === "PENDING" && (isBuyer || isSeller)) ||
          (order.type === "SERVICE" && order.status === "PENDING" && (isBuyer || isSeller))));

    if (!canTransition) {
      return;
    }

    await withTransaction(async (tx) => {
      // 条件更新充当乐观锁：仅当状态仍是读取时的状态才允许流转，
      // 防止并发请求重复触发完成/取消的副作用（计数与通知被重复执行）
      const transitionResult = await tx.order.updateMany({
        where: { id: order.id, status: order.status },
        data: {
          status: parsed.data.status,
          completedAt: parsed.data.status === "COMPLETED" ? new Date() : null,
          cancelReason: parsed.data.status === "CANCELLED" ? "用户主动取消" : null,
        },
      });

      if (transitionResult.count === 0) {
        return;
      }

      if (order.type === "PRODUCT" && order.productId) {
        if (parsed.data.status === "CANCELLED") {
          await tx.product.update({
            where: { id: order.productId },
            data: { status: "ACTIVE" },
          });
        }

        if (parsed.data.status === "COMPLETED") {
          await tx.product.update({
            where: { id: order.productId },
            data: { status: "SOLD" },
          });

          await incrementCompletedUsers(tx, order.buyerId, order.sellerId);
        }
      }

      if (order.type === "SERVICE" && order.serviceListingId && parsed.data.status === "COMPLETED") {
        await tx.serviceListing.update({
          where: { id: order.serviceListingId },
          data: { completedOrderCount: { increment: 1 } },
        });

        await incrementCompletedUsers(tx, order.buyerId, order.sellerId);
      }

      const actorLabel = isBuyer ? "买家" : "卖家";
      const statusLabel = getStatusLabel(parsed.data.status);

      await createNotifications(tx, [
        {
          userId: order.buyerId,
          orderId: order.id,
          type: "ORDER",
          title: `订单状态更新：${statusLabel}`,
          content: `${actorLabel}已将订单状态更新为“${statusLabel}”，请前往订单中心查看。`,
        },
        {
          userId: order.sellerId,
          orderId: order.id,
          type: "ORDER",
          title: `订单状态更新：${statusLabel}`,
          content: `${actorLabel}已将订单状态更新为“${statusLabel}”，请前往订单中心查看。`,
        },
      ]);
    });

    revalidateOrderViews({
      productId: order.productId ?? undefined,
      serviceId: order.serviceListingId ?? undefined,
      errandId: order.errandTaskId ?? undefined,
    });
  } catch (error) {
    actionErrorMessage(error, "updateOrderStatus");
  }
}
