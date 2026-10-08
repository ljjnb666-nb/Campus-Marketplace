"use server";

import { logger } from "@/lib/logger";
import { initiateOrderDisputeTx } from "@/lib/order-dispute-machine";
import { withTransaction } from "@/lib/prisma";
import { revalidateOrderViews } from "@/lib/revalidate";
import { requireUser } from "@/lib/server-auth";
import { isRbacError } from "@/lib/rbac/errors";
import { NewActivityDisabledError } from "@/lib/feature-flags/feature-flag-guard";
import { orderDisputeSchema } from "@/validators/order";

/**
 * Phase 8C-02：General Order dispute（PRODUCT/SERVICE/ERRAND）用户入口的
 * 薄 Server Action 适配层。
 *
 * 硬合同：
 * - userId 一律来自 requireUser()，绝不信 FormData 的任何身份字段；
 * - 仅做：validate → 服务端身份 → withTransaction → canonical
 *   initiateOrderDisputeTx（participant/status/type/campus/active dispute
 *   全部由领域服务锁内 fresh check 权威裁决）→ revalidate → safe response。
 *   事务外零域判断复制；
 * - evidencePhotos 恒 []（8C-02 未开放附件上传；不解析 files、不调 asset 服务）；
 * - 领域 { error } 直接映射安全文案；已知 RBAC inactive 错误返回其现有
 *   安全 userMessage；未知错误统一兜底文案 + logger，绝不把 raw Prisma
 *   error 返回浏览器。
 */

export type OrderDisputeActionState = {
  success: boolean;
  message: string;
};

const GENERIC_FAILURE_MESSAGE = "提交纠纷失败，请稍后重试";

export async function initiateGeneralOrderDispute(
  formData: FormData,
): Promise<OrderDisputeActionState> {
  const parsed = orderDisputeSchema.safeParse({
    orderId: formData.get("orderId") ?? "",
    reason: formData.get("reason") ?? "",
  });
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "参数不正确" };
  }

  const user = await requireUser();

  try {
    const result = await withTransaction((tx) =>
      initiateOrderDisputeTx(tx, {
        orderId: parsed.data.orderId,
        userId: user.id,
        reason: parsed.data.reason,
        evidencePhotos: [],
      }),
    );

    if ("error" in result) {
      return { success: false, message: result.error };
    }

    revalidateOrderViews({
      productId: result.productId ?? undefined,
      serviceId: result.serviceListingId ?? undefined,
      errandId: result.errandTaskId ?? undefined,
    });

    return { success: true, message: "纠纷已提交，订单已进入处理流程" };
  } catch (error) {
    if (isRbacError(error) || error instanceof NewActivityDisabledError) {
      // 已知治理/RBAC inactive 家族：现有安全 userMessage（无内部结构）
      return { success: false, message: error.message };
    }
    logger.error("order-dispute action failed", "order-dispute", {
      action: "initiateGeneralOrderDispute",
      error,
    });
    return { success: false, message: GENERIC_FAILURE_MESSAGE };
  }
}
