import type { Prisma } from "@prisma/client";

import {
  expireProductReservationTx,
} from "@/lib/product-order-lifecycle";
import {
  PermanentJobFailure,
  productReservationExpirePayloadSchema,
  type ClaimedAsyncJob,
  type JobExecutionOutcome,
} from "@/lib/async/job-types";

/**
 * Phase 9A：PRODUCT_RESERVATION_EXPIRE@1 handler。
 *
 * canonical expiry 复用合同（§24）——worker 绝不自持第二份 expiry state
 * machine，只能调用 expireProductReservationTx()（Phase 8B/8F authority）；
 * 本 handler 的职责只是 wake up → invoke canonical lifecycle → 表达
 * outcome（§26）：
 *   EXPIRED     → COMPLETED
 *   NOT_PENDING → COMPLETED_IDEMPOTENT（late accept/cancel 或并发 winner
 *                 已先行关闭；绝不重复 Notification）
 *   NOT_DUE     → RESCHEDULE 到权威 deadline（防御分支，正常不发生：
 *                 job runAt 即创建时的 authoritative deadline；防 clock
 *                 漂移 / stale schedule）
 *   null（结构异常：订单缺失 / 非 PRODUCT / PENDING 无 deadline）
 *               → PERMANENT → DEAD_LETTER
 */
export const productReservationExpireHandler = async (
  tx: Prisma.TransactionClient,
  job: ClaimedAsyncJob,
): Promise<JobExecutionOutcome> => {
  const parsed = productReservationExpirePayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    // payload 形状非法 = 结构性损坏，重试不可能成功（§6 fail closed）
    throw new PermanentJobFailure(
      "PRODUCT_RESERVATION_EXPIRE_PAYLOAD_INVALID",
      "PRODUCT_RESERVATION_EXPIRE payload 形状非法（期望 { orderId: string }）",
    );
  }

  const outcome = await expireProductReservationTx(tx, parsed.data.orderId);

  if (outcome === null) {
    throw new PermanentJobFailure(
      "PRODUCT_RESERVATION_STRUCTURAL_INVALID",
      `PRODUCT 预留过期目标行结构异常（缺失/非 PRODUCT/PENDING 无 deadline）：${parsed.data.orderId}`,
    );
  }

  if (outcome.kind === "EXPIRED") {
    return { kind: "COMPLETED" };
  }

  if (outcome.kind === "NOT_PENDING") {
    return { kind: "COMPLETED_IDEMPOTENT" };
  }

  // NOT_DUE：锁内 fresh 行仍在期限内 → 以权威 deadline 重新排程（不计失败）。
  // findUnique 读到 null 属约束下不可能（PENDING PRODUCT 必有 deadline，
  // DB contract）→ fail closed。
  const order = await tx.order.findUnique({
    where: { id: parsed.data.orderId },
    select: { productReservationExpiresAt: true },
  });
  if (!order?.productReservationExpiresAt) {
    throw new PermanentJobFailure(
      "PRODUCT_RESERVATION_STRUCTURAL_INVALID",
      `NOT_DUE 但 PENDING PRODUCT 订单缺少权威 deadline：${parsed.data.orderId}`,
    );
  }
  return { kind: "RESCHEDULE", runAt: order.productReservationExpiresAt };
};
