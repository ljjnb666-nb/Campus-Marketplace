import type { Prisma } from "@prisma/client";
import { z } from "zod";

import {
  PermanentJobFailure,
  safeAsyncErrorCode,
} from "@/lib/async/job-types";

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

/**
 * PRODUCT_RESERVATION_EXPIRED@1 payload 冻结形状：仅 orderId。
 * RB04：strict——未知键即 INVALID（strip 只保护 parse 结果，不阻止原始
 * JSON 落库；写边界必须拒绝而非静默剥离）。
 */
export const productReservationExpiredEventPayloadSchema = z
  .object({
    orderId: z.string().min(1),
  })
  .strict();

// ============================================================
// RB04 纯契约层（writer 边界 + runtime 双层共用）：本文件只含
// eventType / schemaVersion / Zod schema，绝不 import handler。
// ============================================================

const OUTBOX_PAYLOAD_CONTRACTS = new Map<string, Map<number, z.ZodType>>([
  [
    PRODUCT_RESERVATION_EXPIRED_EVENT_TYPE,
    new Map([[PRODUCT_RESERVATION_EXPIRED_EVENT_SCHEMA_VERSION, productReservationExpiredEventPayloadSchema]]),
  ],
]);

export type OutboxIntentValidation =
  | { ok: true; payload: Prisma.InputJsonValue }
  | { ok: false; reason: "UNKNOWN_CONTRACT" | "INVALID_PAYLOAD" };

/** RB04 写边界契约校验（与 validateJobIntent 同一合同）。 */
export function validateOutboxIntent(
  eventType: string,
  schemaVersion: number,
  payload: unknown,
): OutboxIntentValidation {
  const versions = OUTBOX_PAYLOAD_CONTRACTS.get(eventType);
  const schema = versions?.get(schemaVersion);
  if (!schema) {
    return { ok: false, reason: "UNKNOWN_CONTRACT" };
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, reason: "INVALID_PAYLOAD" };
  }
  return { ok: true, payload: parsed.data as Prisma.InputJsonValue };
}

/**
 * RB04 写边界受控契约错误：recordOutboxEventTx 校验失败时抛出——业务事务
 * 回滚、零 OutboxEvent 行。code 属受控机器码格式（RB05 合同）。
 */
export class OutboxEventIntentContractError extends PermanentJobFailure {
  constructor(
    reason: "UNKNOWN_CONTRACT" | "INVALID_PAYLOAD",
    eventType: string,
    schemaVersion: number,
  ) {
    super(
      reason === "UNKNOWN_CONTRACT"
        ? "OUTBOX_EVENT_INTENT_CONTRACT_UNKNOWN"
        : "OUTBOX_EVENT_INTENT_CONTRACT_INVALID",
      reason === "UNKNOWN_CONTRACT"
        ? `未注册的 outbox eventType/schemaVersion 拒绝写入：${eventType}@${schemaVersion}`
        : `outbox payload 未通过 strict 契约校验（eventType=${eventType} version=${schemaVersion}）`,
    );
    this.name = "OutboxEventIntentContractError";
  }
}

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

/**
 * OutboxEvent.lastErrorCode 合同（RB05）：与 jobErrorCode 共用
 * safeAsyncErrorCode 实现（CONTROLLED MACHINE CODE ONLY），禁止漂移。
 */
export function outboxEventErrorCode(error: unknown): string {
  return safeAsyncErrorCode(error);
}

/**
 * RB02 安全合同（与 jobErrorMessage 同一原则）：raw exception message 默认
 * 拒绝落库；仅 PermanentJobFailure 的受控内部文案允许（仍消毒 <=500）。
 * 机器诊断依赖 lastErrorCode；完整细节只进结构化应用日志（errorName/code）。
 */
export function outboxEventErrorMessage(error: unknown): string {
  if (error instanceof PermanentJobFailure) {
    const firstLine = error.message.split("\n", 1)[0] ?? "";
    return firstLine
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, 500);
  }
  return "异步事件处理失败";
}
