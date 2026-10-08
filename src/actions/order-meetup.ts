"use server";

import { logger } from "@/lib/logger";
import { MeetupError, type MeetupErrorCode } from "@/lib/meetups/errors";
import {
  cancelOrderMeetupTx,
  confirmOrderMeetupTx,
  markOrderMeetupArrivalTx,
  proposeOrderMeetupTx,
  reportOrderMeetupNoShowTx,
} from "@/lib/meetups/order-meetup-service";
import { withTransaction } from "@/lib/prisma";
import { revalidateOrderMeetupViews } from "@/lib/revalidate";
import { isRbacError } from "@/lib/rbac/errors";
import { NewActivityDisabledError } from "@/lib/feature-flags/feature-flag-guard";
import { requireUser } from "@/lib/server-auth";
import {
  orderMeetupMutationSchema,
  proposeOrderMeetupSchema,
} from "@/validators/order-meetup";

/**
 * Phase 8D-02：Meetup 用户操作面的薄 Server Action 适配层（PRODUCT /
 * SERVICE 专属）。
 *
 * 硬合同（与 8C-02 dispute action 同构，冻结）：
 * - actor 身份一律来自 requireUser()；FormData 中的任何身份字段
 *   （userId / actorId / buyerId / sellerId / reporterId / targetUserId）
 *   即使恶意提交也完全忽略——validator schema 根本不设这些字段；
 * - 仅做：validate → 服务端身份 → withTransaction → canonical 8D-01
 *   Tx service（participant / type / status / campus / 时间窗 / 地点
 *   全部锁内 fresh revalidate）→ revalidate → safe response；
 *   事务外零域判断复制；
 * - 领域 { error: code } 经 src/lib/meetups/errors.ts 单一映射为安全
 *   中文文案（不泄漏 meetup provenance / 授权结构 / raw enum）；
 * - 已知 RBAC inactive 错误返回其现有安全 userMessage；未知异常统一
 *   logger.error + 兜底文案，绝不把 raw Prisma error 返回浏览器。
 */

export type OrderMeetupActionState = {
  success: boolean;
  message: string;
};

const GENERIC_FAILURE_MESSAGE = "操作失败，请稍后重试";

/** 领域 { error: code } → errors.ts SAFE 中文文案（单一映射，禁止就地写文案） */
function meetupDenyMessage(code: MeetupErrorCode): string {
  return new MeetupError(code).message;
}

/** unknown exception → logger + 统一兜底（raw error 不回浏览器） */
function meetupActionFailure(error: unknown, action: string): OrderMeetupActionState {
  if (isRbacError(error) || error instanceof NewActivityDisabledError) {
    // 已知治理/RBAC inactive 家族：现有安全 userMessage（无内部结构）
    return { success: false, message: error.message };
  }
  logger.error("order-meetup action failed", "order-meetup", { action, error });
  return { success: false, message: GENERIC_FAILURE_MESSAGE };
}

export async function proposeOrderMeetupAction(
  _prevState: OrderMeetupActionState,
  formData: FormData,
): Promise<OrderMeetupActionState> {
  const parsed = proposeOrderMeetupSchema.safeParse({
    orderId: formData.get("orderId") ?? "",
    scheduledAt: formData.get("scheduledAt") ?? "",
    locationSource: formData.get("locationSource") ?? "",
    meetupPointId: formData.get("meetupPointId") ?? undefined,
    locationText: formData.get("locationText") ?? undefined,
  });
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? "参数不正确",
    };
  }

  const user = await requireUser();

  try {
    // 地点来源按 choice 精确映射：catalog 来源只传 meetupPointId，
    // custom 来源只传 locationText（禁止双通道同时下发）
    const result = await withTransaction((tx) =>
      proposeOrderMeetupTx(tx, {
        orderId: parsed.data.orderId,
        proposerId: user.id,
        scheduledAt: parsed.data.scheduledAt,
        meetupPointId:
          parsed.data.locationSource === "MEETUP_POINT"
            ? (parsed.data.meetupPointId ?? null)
            : null,
        locationText:
          parsed.data.locationSource === "CUSTOM"
            ? (parsed.data.locationText ?? null)
            : null,
      }),
    );

    if ("error" in result) {
      return { success: false, message: meetupDenyMessage(result.error) };
    }

    revalidateOrderMeetupViews(parsed.data.orderId);
    return { success: true, message: "见面约定已发起，等待对方确认" };
  } catch (error) {
    return meetupActionFailure(error, "proposeOrderMeetupAction");
  }
}

export async function confirmOrderMeetupAction(
  _prevState: OrderMeetupActionState,
  formData: FormData,
): Promise<OrderMeetupActionState> {
  const parsed = orderMeetupMutationSchema.safeParse({
    orderId: formData.get("orderId") ?? "",
    meetupId: formData.get("meetupId") ?? "",
  });
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? "参数不正确",
    };
  }

  const user = await requireUser();

  try {
    const result = await withTransaction((tx) =>
      confirmOrderMeetupTx(tx, {
        orderId: parsed.data.orderId,
        meetupId: parsed.data.meetupId,
        confirmerId: user.id,
      }),
    );

    if ("error" in result) {
      return { success: false, message: meetupDenyMessage(result.error) };
    }

    revalidateOrderMeetupViews(parsed.data.orderId);
    return { success: true, message: "已确认见面约定" };
  } catch (error) {
    return meetupActionFailure(error, "confirmOrderMeetupAction");
  }
}

export async function cancelOrderMeetupAction(
  _prevState: OrderMeetupActionState,
  formData: FormData,
): Promise<OrderMeetupActionState> {
  const parsed = orderMeetupMutationSchema.safeParse({
    orderId: formData.get("orderId") ?? "",
    meetupId: formData.get("meetupId") ?? "",
  });
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? "参数不正确",
    };
  }

  const user = await requireUser();

  try {
    const result = await withTransaction((tx) =>
      cancelOrderMeetupTx(tx, {
        orderId: parsed.data.orderId,
        meetupId: parsed.data.meetupId,
        actorId: user.id,
      }),
    );

    if ("error" in result) {
      return { success: false, message: meetupDenyMessage(result.error) };
    }

    revalidateOrderMeetupViews(parsed.data.orderId);
    return { success: true, message: "见面约定已取消" };
  } catch (error) {
    return meetupActionFailure(error, "cancelOrderMeetupAction");
  }
}

export async function markOrderMeetupArrivalAction(
  _prevState: OrderMeetupActionState,
  formData: FormData,
): Promise<OrderMeetupActionState> {
  const parsed = orderMeetupMutationSchema.safeParse({
    orderId: formData.get("orderId") ?? "",
    meetupId: formData.get("meetupId") ?? "",
  });
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? "参数不正确",
    };
  }

  const user = await requireUser();

  try {
    // self-arrival attestation：input 不存在 target 字段，到场方恒为
    // session user 自己（买家写 buyerArrivedAt / 卖家写 sellerArrivedAt
    // 由 canonical service 裁决）
    const result = await withTransaction((tx) =>
      markOrderMeetupArrivalTx(tx, {
        orderId: parsed.data.orderId,
        meetupId: parsed.data.meetupId,
        actorId: user.id,
      }),
    );

    if ("error" in result) {
      return { success: false, message: meetupDenyMessage(result.error) };
    }

    revalidateOrderMeetupViews(parsed.data.orderId);
    return {
      success: true,
      message: result.alreadyArrived ? "你已登记过到场" : "已登记到场",
    };
  } catch (error) {
    return meetupActionFailure(error, "markOrderMeetupArrivalAction");
  }
}

export async function reportOrderMeetupNoShowAction(
  _prevState: OrderMeetupActionState,
  formData: FormData,
): Promise<OrderMeetupActionState> {
  const parsed = orderMeetupMutationSchema.safeParse({
    orderId: formData.get("orderId") ?? "",
    meetupId: formData.get("meetupId") ?? "",
  });
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? "参数不正确",
    };
  }

  const user = await requireUser();

  try {
    // reporter 恒为 session user；target 由 canonical service 从 order
    // 参与方结构推导（绝不接受客户端指定 targetUserId）
    const result = await withTransaction((tx) =>
      reportOrderMeetupNoShowTx(tx, {
        orderId: parsed.data.orderId,
        meetupId: parsed.data.meetupId,
        reporterId: user.id,
      }),
    );

    if ("error" in result) {
      return { success: false, message: meetupDenyMessage(result.error) };
    }

    revalidateOrderMeetupViews(parsed.data.orderId);
    return { success: true, message: "未到场报告已提交，订单已进入纠纷处理" };
  } catch (error) {
    return meetupActionFailure(error, "reportOrderMeetupNoShowAction");
  }
}
