import type { Prisma } from "@prisma/client";

import { createNotifications } from "@/repositories/notification-repository";
import {
  parseOutboxEventPayload,
  PRODUCT_RESERVATION_EXPIRED_BUYER_CONTENT,
  PRODUCT_RESERVATION_EXPIRED_EVENT_SCHEMA_VERSION,
  PRODUCT_RESERVATION_EXPIRED_EVENT_TYPE,
  PRODUCT_RESERVATION_EXPIRED_NOTIFICATION_TITLE,
  PRODUCT_RESERVATION_EXPIRED_SELLER_CONTENT,
  productReservationExpiredEventPayloadSchema,
  type ClaimedOutboxEvent,
} from "@/lib/async/outbox-event-registry";
import { PermanentJobFailure } from "@/lib/async/job-types";

/**
 * Phase 9A：PRODUCT_RESERVATION_EXPIRED@1 materializer（§27/§28/§60）。
 *
 * 在 dispatcher 的单事务内执行（副作用与 PUBLISHED 同一 COMMIT）：
 * 订单聚合 → 恰好两条 In-App 通知（buyer / seller 固定中文文案；继续
 * 禁止 Product title / note / meetingLocation 等 user-authored 内容）。
 *
 * 幂等由 DB 级保证（§28）：Notification.dedupeKey =
 *   OUTBOX:<eventId>:IN_APP:<userId>（UNIQUE）+ createMany skipDuplicates——
 * 并发 materialize / 重放（crash after commit 后的重试路径等）绝不产生
 * 重复行；绝不允许只靠 findFirst-then-create。
 */
export const productReservationExpiredEventHandler = async (
  tx: Prisma.TransactionClient,
  event: ClaimedOutboxEvent,
): Promise<void> => {
  if (
    event.eventType !== PRODUCT_RESERVATION_EXPIRED_EVENT_TYPE ||
    event.schemaVersion !== PRODUCT_RESERVATION_EXPIRED_EVENT_SCHEMA_VERSION
  ) {
    // registry 解析已保证；防御性 fail closed（结构性损坏 → PERMANENT）
    throw new PermanentReservationEventContractError(event);
  }

  const payload = parseOutboxEventPayload(event, productReservationExpiredEventPayloadSchema);

  const order = await tx.order.findUnique({
    where: { id: payload.orderId },
    select: { buyerId: true, sellerId: true },
  });
  if (!order) {
    throw new PermanentReservationEventAggregateMissingError(payload.orderId);
  }

  await createNotifications(tx, [
    {
      userId: order.buyerId,
      orderId: payload.orderId,
      type: "ORDER",
      title: PRODUCT_RESERVATION_EXPIRED_NOTIFICATION_TITLE,
      content: PRODUCT_RESERVATION_EXPIRED_BUYER_CONTENT,
      dedupeKey: `OUTBOX:${event.id}:IN_APP:${order.buyerId}`,
      sourceEventId: event.id,
    },
    {
      userId: order.sellerId,
      orderId: payload.orderId,
      type: "ORDER",
      title: PRODUCT_RESERVATION_EXPIRED_NOTIFICATION_TITLE,
      content: PRODUCT_RESERVATION_EXPIRED_SELLER_CONTENT,
      dedupeKey: `OUTBOX:${event.id}:IN_APP:${order.sellerId}`,
      sourceEventId: event.id,
    },
  ]);
};

class PermanentReservationEventContractError extends PermanentJobFailure {
  constructor(event: Pick<ClaimedOutboxEvent, "eventType" | "schemaVersion">) {
    super(
      "OUTBOX_EVENT_CONTRACT_INVALID",
      `PRODUCT_RESERVATION_EXPIRED materializer 收到未注册的 eventType/version：${event.eventType}@${event.schemaVersion}`,
    );
    this.name = "PermanentReservationEventContractError";
  }
}

class PermanentReservationEventAggregateMissingError extends PermanentJobFailure {
  constructor(orderId: string) {
    super(
      "OUTBOX_EVENT_AGGREGATE_MISSING",
      `PRODUCT_RESERVATION_EXPIRED 聚合缺失（Order 不存在）：${orderId}`,
    );
    this.name = "PermanentReservationEventAggregateMissingError";
  }
}
