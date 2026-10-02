import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { PermanentJobFailure } from "@/lib/async/job-types";

/**
 * Phase 9A：OutboxEvent 契约类型与 runtime registry（§22 fail closed）。
 *
 * eventType 是 String（不用 Prisma enum），9A 只注册
 * PRODUCT_RESERVATION_EXPIRED@1；未知 eventType / 未知 version 一律
 * PERMANENT → DEAD_LETTER，禁止猜测派生。
 *
 * 9B 前瞻（§30）：OutboxEvent 是"已发生 domain fact 的幂等派生面"，
 * schema 不写死 in-app only——9B 可在同一 event 上扩展
 * NotificationDelivery(IN_APP/EMAIL/...) 渠道意图；event payload 始终
 * 只允许 IDs + 机器状态。
 */

export const PRODUCT_RESERVATION_EXPIRED_EVENT_TYPE = "PRODUCT_RESERVATION_EXPIRED";
export const PRODUCT_RESERVATION_EXPIRED_EVENT_SCHEMA_VERSION = 1;
export const PRODUCT_RESERVATION_EXPIRED_AGGREGATE_TYPE = "ORDER";

/** PRODUCT_RESERVATION_EXPIRED@1 payload 冻结形状：仅 orderId。 */
export const productReservationExpiredEventPayloadSchema = z.object({
  orderId: z.string().min(1),
});

/** 9A materializer 产出固定两条 In-App 通知的标题/正文（§27，禁止
 * Product title / note / meetingLocation 等 user-authored 内容）。 */
export const PRODUCT_RESERVATION_EXPIRED_NOTIFICATION_TITLE = "商品预留已过期";
export const PRODUCT_RESERVATION_EXPIRED_BUYER_CONTENT =
  "卖家未在确认期限内接受订单，商品预留已自动释放。";
export const PRODUCT_RESERVATION_EXPIRED_SELLER_CONTENT =
  "该商品订单已超过确认期限，预留已自动释放。";

export type ClaimedOutboxEvent = {
  id: string;
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  payload: Prisma.JsonValue;
  attempts: number;
  maxAttempts: number;
  leaseToken: string;
  /** claim 前的状态：PROCESSING = lease 过期回收（crash recovery）。 */
  previousStatus: string;
};

/**
 * materializer 在 dispatcher 的单事务内执行：verify lease → 派生副作用 →
 * event PUBLISHED，同一 COMMIT（§29 原子性）。
 */
export type OutboxEventHandler = (
  tx: Prisma.TransactionClient,
  event: ClaimedOutboxEvent,
) => Promise<void>;

/** event payload 校验失败 = 结构性损坏（PERMANENT，fail closed）。 */
export function parseOutboxEventPayload<T>(
  event: Pick<ClaimedOutboxEvent, "id" | "eventType" | "payload">,
  schema: z.ZodType<T>,
): T {
  const parsed = schema.safeParse(event.payload);
  if (!parsed.success) {
    throw new PermanentJobFailure(
      "OUTBOX_EVENT_PAYLOAD_INVALID",
      `${event.eventType} payload 形状非法（event=${event.id}）`,
    );
  }
  return parsed.data;
}

export function outboxEventErrorCode(error: unknown): string {
  if (error instanceof PermanentJobFailure) {
    return error.code;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.length > 0) {
    return code.slice(0, 100);
  }
  if (error instanceof Error && error.name) {
    return error.name.slice(0, 100);
  }
  return "UNKNOWN";
}

export function outboxEventErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split("\n", 1)[0] ?? "";
  return firstLine
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 500);
}
