import { productReservationExpiredEventHandler } from "@/lib/async/handlers/product-reservation-expired-event";
import {
  PRODUCT_RESERVATION_EXPIRED_EVENT_SCHEMA_VERSION,
  PRODUCT_RESERVATION_EXPIRED_EVENT_TYPE,
  type OutboxEventHandler,
} from "@/lib/async/outbox-event-registry";

/**
 * Phase 9A：OutboxEvent runtime registry（§22 fail closed）。
 *
 * eventType 是 String（不用 Prisma enum），可派生的 eventType/version
 * 组合必须在此显式注册；解析失败（未知 eventType / 未知 version）→
 * dispatcher 以 PERMANENT failure → DEAD_LETTER，禁止猜测派生。
 *
 * 9A 只注册 PRODUCT_RESERVATION_EXPIRED@1；9B 的 Email / 渠道抽象在同一
 * registry 上扩展（OutboxEvent schema 不写死 in-app only，§30）。
 */

type OutboxHandlerRegistry = Map<string, Map<number, OutboxEventHandler>>;

const outboxHandlers: OutboxHandlerRegistry = new Map([
  [
    PRODUCT_RESERVATION_EXPIRED_EVENT_TYPE,
    new Map([[PRODUCT_RESERVATION_EXPIRED_EVENT_SCHEMA_VERSION, productReservationExpiredEventHandler]]),
  ],
]);

/** 9B 扩展点（tests 的 fault injection 也经由同一 seam，生产路径不调用）。 */
export function registerOutboxEventHandler(
  eventType: string,
  schemaVersion: number,
  handler: OutboxEventHandler,
): void {
  const versions = outboxHandlers.get(eventType) ?? new Map<number, OutboxEventHandler>();
  versions.set(schemaVersion, handler);
  outboxHandlers.set(eventType, versions);
}

/** 解析失败返回 null —— 调用方必须以 PERMANENT failure fail closed。 */
export function resolveOutboxEventHandler(
  eventType: string,
  schemaVersion: number,
): OutboxEventHandler | null {
  return outboxHandlers.get(eventType)?.get(schemaVersion) ?? null;
}
