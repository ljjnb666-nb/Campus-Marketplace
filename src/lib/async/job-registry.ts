import {
  NOTIFICATION_DELIVERY_JOB_KIND,
  NOTIFICATION_DELIVERY_JOB_SCHEMA_VERSION,
  PRODUCT_RESERVATION_EXPIRE_JOB_KIND,
  PRODUCT_RESERVATION_EXPIRE_JOB_SCHEMA_VERSION,
  type JobHandler,
} from "@/lib/async/job-types";
import { productReservationExpireHandler } from "@/lib/async/handlers/product-reservation-expire";
import { notificationDeliveryHandler } from "@/lib/async/handlers/notification-delivery";

/**
 * Phase 9A：AsyncJob runtime registry（§6 fail closed）。
 *
 * job kind 是 String（不用 Prisma enum），但可执行的 kind/schemaVersion
 * 组合必须在此显式注册；registry 解析失败（未知 kind / 未知
 * schemaVersion）→ runner 以 PERMANENT failure → DEAD_LETTER 落库，
 * 禁止任何猜测执行。
 *
 * 9A 注册 PRODUCT_RESERVATION_EXPIRE@1（§7）；Phase 9B 新增
 * NOTIFICATION_DELIVERY@1（§13：EMAIL 渠道投递，payload 仅 deliveryId）。
 * RETENTION_CLEANUP / STATISTICS_REFRESH 等 9C handler 在各自阶段注册，
 * 不需改 PostgreSQL enum。
 */

type JobHandlerRegistry = Map<string, Map<number, JobHandler>>;

const jobHandlers: JobHandlerRegistry = new Map([
  [
    PRODUCT_RESERVATION_EXPIRE_JOB_KIND,
    new Map([[PRODUCT_RESERVATION_EXPIRE_JOB_SCHEMA_VERSION, productReservationExpireHandler]]),
  ],
  [
    NOTIFICATION_DELIVERY_JOB_KIND,
    new Map([[NOTIFICATION_DELIVERY_JOB_SCHEMA_VERSION, notificationDeliveryHandler]]),
  ],
]);

/** 9B/9C 扩展点（tests 的 fault injection 也经由同一 seam，生产路径不调用）。 */
export function registerJobHandler(kind: string, schemaVersion: number, handler: JobHandler): void {
  const versions = jobHandlers.get(kind) ?? new Map<number, JobHandler>();
  versions.set(schemaVersion, handler);
  jobHandlers.set(kind, versions);
}

/** 解析失败返回 null —— 调用方必须以 PERMANENT failure fail closed。 */
export function resolveJobHandler(kind: string, schemaVersion: number): JobHandler | null {
  return jobHandlers.get(kind)?.get(schemaVersion) ?? null;
}
