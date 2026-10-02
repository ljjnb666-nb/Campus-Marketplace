import {
  PRODUCT_RESERVATION_EXPIRE_JOB_KIND,
  PRODUCT_RESERVATION_EXPIRE_JOB_SCHEMA_VERSION,
  type JobHandler,
} from "@/lib/async/job-types";
import { productReservationExpireHandler } from "@/lib/async/handlers/product-reservation-expire";

/**
 * Phase 9A：AsyncJob runtime registry（§6 fail closed）。
 *
 * job kind 是 String（不用 Prisma enum），但可执行的 kind/schemaVersion
 * 组合必须在此显式注册；registry 解析失败（未知 kind / 未知
 * schemaVersion）→ runner 以 PERMANENT failure → DEAD_LETTER 落库，
 * 禁止任何猜测执行。
 *
 * 9A 只注册 PRODUCT_RESERVATION_EXPIRE@1（§7）；EMAIL_DELIVERY /
 * RETENTION_CLEANUP / STATISTICS_REFRESH 等 9B/9C handler 在各自阶段
 * 注册，不需改 PostgreSQL enum。
 */

type JobHandlerRegistry = Map<string, Map<number, JobHandler>>;

const jobHandlers: JobHandlerRegistry = new Map([
  [
    PRODUCT_RESERVATION_EXPIRE_JOB_KIND,
    new Map([[PRODUCT_RESERVATION_EXPIRE_JOB_SCHEMA_VERSION, productReservationExpireHandler]]),
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
