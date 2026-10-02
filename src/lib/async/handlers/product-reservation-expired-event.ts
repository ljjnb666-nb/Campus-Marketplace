import type { Prisma } from "@prisma/client";

import { emitNotificationsTx } from "@/lib/notifications/notification-service";
import { PRODUCT_RESERVATION_EXPIRED_KIND } from "@/lib/notifications/notification-registry";
import {
  parseOutboxEventPayload,
  PRODUCT_RESERVATION_EXPIRED_EVENT_SCHEMA_VERSION,
  PRODUCT_RESERVATION_EXPIRED_EVENT_TYPE,
  productReservationExpiredEventPayloadSchema,
  type ClaimedOutboxEvent,
} from "@/lib/async/outbox-event-registry";
import { PermanentJobFailure } from "@/lib/async/job-types";

/**
 * PRODUCT_RESERVATION_EXPIRED@1 materializer。
 *
 * Phase 9A（§27/§28/§60）：OutboxEvent → 幂等派生面（In-App 通知）。
 * Phase 9B（§21）：派生面收敛到 canonical notification domain——
 * emitNotificationsTx 在 dispatcher 的单事务内执行（副作用与 PUBLISHED
 * 同一 COMMIT），并按 registry 渠道策略物化渠道投递意图（9B：EMAIL
 * NotificationDelivery + NOTIFICATION_DELIVERY AsyncJob，与 IN_APP 投影
 * 同事务原子落盘）。OutboxEvent PUBLISHED = notification intents 已
 * durably materialized，不表示 email 已投递（后者由 EMAIL job 的
 * providerAcceptedAt 表达）。
 *
 * 幂等由 DB 级保证（§28）：Notification.dedupeKey =
 *   OUTBOX:<eventId>:IN_APP:<userId>（UNIQUE，9A 键不变）+ createMany
 *   skipDuplicates——并发 materialize / 重放（crash after commit 后的重试
 *   路径等）绝不产生重复行/重复 delivery/重复 job（§67）；绝不允许只靠
 *   findFirst-then-create。
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

  await emitNotificationsTx(tx, [
    {
      kind: PRODUCT_RESERVATION_EXPIRED_KIND,
      recipientUserId: order.buyerId,
      orderId: payload.orderId,
      dedupeKey: `OUTBOX:${event.id}:IN_APP:${order.buyerId}`,
      sourceEventId: event.id,
      payload: { orderId: payload.orderId, buyerId: order.buyerId, sellerId: order.sellerId },
    },
    {
      kind: PRODUCT_RESERVATION_EXPIRED_KIND,
      recipientUserId: order.sellerId,
      orderId: payload.orderId,
      dedupeKey: `OUTBOX:${event.id}:IN_APP:${order.sellerId}`,
      sourceEventId: event.id,
      payload: { orderId: payload.orderId, buyerId: order.buyerId, sellerId: order.sellerId },
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
