"use server";

import { Prisma } from "@prisma/client";
import { actionErrorMessage } from "@/lib/error-handler";
import { completeErrandOrderTx } from "@/lib/errand-completion";
import { updateOrderStatusTx } from "@/lib/order-status-service";
import {
  createProductOrderTx,
  createServiceOrderTx,
} from "@/lib/order-creation";
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
        campusId: true,
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

    const order = await withTransaction(async (tx) =>
      createProductOrderTx(tx, {
        buyerId: user.id,
        product: {
          id: product.id,
          price: product.price.toString(),
          sellerId: product.sellerId,
          campusId: product.campusId,
        },
        meetingLocation: parsed.data.meetingLocation,
        note: parsed.data.note || null,
      }),
    );

    // Phase 7C FR-02：tx null 语义已泛化（moderation/现势状态失效/参与方或
    // campus 失配/抢占失败任一）——统一 SAFE 文案，不区分原因（禁止事务外
    // 附加查询重判），不误导为"已有进行中的订单"。
    if (!order) {
      return { ...initialState, message: "商品不存在或当前不可购买" };
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
        campusId: true,
      },
    });

    if (!service) {
      return { ...initialState, message: "服务不存在或当前不可预约" };
    }

    if (service.providerId === user.id) {
      return { ...initialState, message: "不能预约自己发布的服务" };
    }

    // Phase 7C FR-02：canonical 锁内 gate（moderation/现势状态/参与方/
    // campus 失配）拒绝时返回 null——统一映射 SAFE 文案，不泄漏治理状态。
    const order = await withTransaction(async (tx) =>
      createServiceOrderTx(tx, {
        buyerId: user.id,
        service: {
          id: service.id,
          price: service.price.toString(),
          providerId: service.providerId,
          campusId: service.campusId,
        },
        meetingLocation: parsed.data.meetingLocation,
        note: parsed.data.note || null,
      }),
    );

    if (!order) {
      return { ...initialState, message: "服务不存在或当前不可预约" };
    }

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
    // entry auth = 身份发现；RB-03 REVIEW FIX：Order fresh read、
    // isBuyer/isSeller、canTransition 全部以 USER 锁内事务为最终 authority
    const user = await requireUser();

    const parsed = orderStatusSchema.safeParse({
      orderId: formData.get("orderId"),
      status: formData.get("status"),
    });

    if (!parsed.success) {
      return;
    }

    const outcome = await withTransaction(async (tx) =>
      updateOrderStatusTx(tx, user.id, parsed.data.orderId, {
        requestedStatus: parsed.data.status,
      }),
    );

    if (!outcome) {
      return;
    }

    revalidateOrderViews({
      productId: outcome.productId ?? undefined,
      serviceId: outcome.serviceListingId ?? undefined,
      errandId: outcome.errandTaskId ?? undefined,
    });
  } catch (error) {
    actionErrorMessage(error, "updateOrderStatus");
  }
}
