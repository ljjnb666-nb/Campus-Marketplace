import {
  DATA_EXPORT_GENERATE_JOB_KIND,
  DATA_EXPORT_GENERATE_JOB_SCHEMA_VERSION,
  ERRAND_DEADLINE_EXPIRE_JOB_KIND,
  ERRAND_DEADLINE_EXPIRE_JOB_SCHEMA_VERSION,
  NOTIFICATION_DELIVERY_JOB_KIND,
  NOTIFICATION_DELIVERY_JOB_SCHEMA_VERSION,
  PRODUCT_RESERVATION_EXPIRE_JOB_KIND,
  PRODUCT_RESERVATION_EXPIRE_JOB_SCHEMA_VERSION,
  type JobHandler,
} from "@/lib/async/job-types";
import { productReservationExpireHandler } from "@/lib/async/handlers/product-reservation-expire";
import { notificationDeliveryHandler } from "@/lib/async/handlers/notification-delivery";
import { errandDeadlineExpireHandler } from "@/lib/async/handlers/errand-deadline-expire";
import { dataExportGenerateHandler } from "@/lib/async/handlers/data-export-generate";
import {
  EMAIL_DELIVERY_EXECUTION_LEASE_SECONDS,
  EMAIL_DELIVERY_EXECUTION_TX_TIMEOUT_MS,
} from "@/lib/notifications/email-contract";
import {
  DATA_EXPORT_GENERATE_EXECUTION_LEASE_SECONDS,
  DATA_EXPORT_GENERATE_EXECUTION_TX_TIMEOUT_MS,
} from "@/lib/privacy/data-export-contract";

/**
 * Phase 9A：AsyncJob runtime registry（§6 fail closed）。
 *
 * job kind 是 String（不用 Prisma enum），但可执行的 kind/schemaVersion
 * 组合必须在此显式注册；registry 解析失败（未知 kind / 未知
 * schemaVersion）→ runner 以 PERMANENT failure → DEAD_LETTER 落库，
 * 禁止任何猜测执行。
 *
 * 9A 注册 PRODUCT_RESERVATION_EXPIRE@1（§7）；Phase 9B 新增
 * NOTIFICATION_DELIVERY@1（§13：EMAIL 渠道投递，payload 仅 deliveryId）；
 * Phase 9C-02 新增 ERRAND_DEADLINE_EXPIRE@1（§9：errand deadline 到期
 * scheduler wake-up 意图，payload 仅 errandId，dedupeKey =
 * ERRAND_DEADLINE_EXPIRE:<errandId>——一个 Errand 生命周期至多一个
 * canonical expiry intent）；Phase 9C-03 新增 DATA_EXPORT_GENERATE@1
 * （payload 仅 requestId，dedupeKey = DATA_EXPORT_GENERATE:<requestId>，
 * Step A/B durable generation lifecycle + scoped dead-letter reconciler）。
 * RETENTION_CLEANUP / STATISTICS_REFRESH 等
 * 9C handler 在各自阶段注册，不需改 PostgreSQL enum。
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
  [
    ERRAND_DEADLINE_EXPIRE_JOB_KIND,
    new Map([[ERRAND_DEADLINE_EXPIRE_JOB_SCHEMA_VERSION, errandDeadlineExpireHandler]]),
  ],
  [
    DATA_EXPORT_GENERATE_JOB_KIND,
    new Map([[DATA_EXPORT_GENERATE_JOB_SCHEMA_VERSION, dataExportGenerateHandler]]),
  ],
]);

// ============================================================
// RB06（Review Round 2）：per-job execution policy（SSOT = 本 registry）。
//
// EMAIL execution transaction 在 serialization boundary 内含 provider
// HTTP 调用，默认 10s 事务预算 < provider 30s 上限 = correctness bug；
// runner 对已注册 handler 按 policy 执行（预算算术冻结于
// email-contract.ts 注释与 EMAIL-TX-BUDGET-01 / EMAIL-LEASE-BUDGET-01
// 静态不变量测试）。
//
// 未注册 kind/version → {}（runner 继承既有默认：withTransaction 的
// TRANSACTION_TIMEOUT_MS 与 60s execution lease 覆盖链）——unknown-job 的
// PERMANENT → DEAD_LETTER 合同不受 policy 影响，既有 9A handler
//（PRODUCT_RESERVATION_EXPIRE@1）不被 Email 预算污染。
// ============================================================

export type JobExecutionPolicy = {
  /** 覆盖默认事务预算（默认 = prisma.TRANSACTION_TIMEOUT_MS = 10s）。 */
  transactionTimeoutMs?: number;
  /** 覆盖 beginAsyncJobExecutionTx 的 execution lease（默认 60s）。 */
  executionLeaseSeconds?: number;
};

const JOB_EXECUTION_POLICIES: Map<string, Map<number, JobExecutionPolicy>> = new Map([
  [
    NOTIFICATION_DELIVERY_JOB_KIND,
    new Map([
      [
        NOTIFICATION_DELIVERY_JOB_SCHEMA_VERSION,
        {
          transactionTimeoutMs: EMAIL_DELIVERY_EXECUTION_TX_TIMEOUT_MS,
          executionLeaseSeconds: EMAIL_DELIVERY_EXECUTION_LEASE_SECONDS,
        },
      ],
    ]),
  ],
  [
    // Phase 9C-03（§47/§48）：execution transaction 在 serialization
    // boundary（USER governance lock + AsyncJob 行锁）内含 export build
    // （多查询 DB 读）+ 序列化 + MiB 级 S3 PUT，必须使用扩展事务预算 +
    // 覆盖它的 execution lease（预算算术冻结于 data-export-contract.ts
    // 注释与 EXPORT-TX-BUDGET-01 / EXPORT-LEASE-BUDGET-01 静态不变量测试）。
    DATA_EXPORT_GENERATE_JOB_KIND,
    new Map([
      [
        DATA_EXPORT_GENERATE_JOB_SCHEMA_VERSION,
        {
          transactionTimeoutMs: DATA_EXPORT_GENERATE_EXECUTION_TX_TIMEOUT_MS,
          executionLeaseSeconds: DATA_EXPORT_GENERATE_EXECUTION_LEASE_SECONDS,
        },
      ],
    ]),
  ],
]);

/** 已注册 kind/version 的执行预算覆盖；未注册 → {}（继承既有默认合同）。 */
export function resolveJobExecutionPolicy(
  kind: string,
  schemaVersion: number,
): JobExecutionPolicy {
  return JOB_EXECUTION_POLICIES.get(kind)?.get(schemaVersion) ?? {};
}

/** 9B 扩展点（tests 的 fault injection 也经由同一 seam，生产路径不调用）。 */
export function registerJobHandler(kind: string, schemaVersion: number, handler: JobHandler): void {
  const versions = jobHandlers.get(kind) ?? new Map<number, JobHandler>();
  versions.set(schemaVersion, handler);
  jobHandlers.set(kind, versions);
}

/** 解析失败返回 null —— 调用方必须以 PERMANENT failure fail closed。 */
export function resolveJobHandler(kind: string, schemaVersion: number): JobHandler | null {
  return jobHandlers.get(kind)?.get(schemaVersion) ?? null;
}
