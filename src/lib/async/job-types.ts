import type { Prisma } from "@prisma/client";
import { z } from "zod";

/**
 * Phase 9A：AsyncJob 契约类型与 runtime registry 的 fail-closed 原语。
 *
 * job kind 不使用 Prisma enum（§6）：新增 worker handler 不应每次都改
 * PostgreSQL enum。kind 是 String + schemaVersion Int；runtime registry
 * 对未知 kind / 未知 schemaVersion 一律 PERMANENT → DEAD_LETTER，
 * 禁止任何猜测执行（fail closed）。
 *
 * payload 契约（§7 / privacy registry）：只允许 IDs + 机器状态；
 * 每个已注册 kind 的 payload 形状由 zod schema 冻结，形状非法 =
 * PERMANENT（结构性损坏，重试不可能成功）。
 */

/** 9A 唯一 production job kind：PRODUCT 预留到期 scheduler wake-up 意图。 */
export const PRODUCT_RESERVATION_EXPIRE_JOB_KIND = "PRODUCT_RESERVATION_EXPIRE";
export const PRODUCT_RESERVATION_EXPIRE_JOB_SCHEMA_VERSION = 1;

/** PRODUCT_RESERVATION_EXPIRE payload 冻结形状：仅 orderId。 */
export const productReservationExpirePayloadSchema = z.object({
  orderId: z.string().min(1),
});

export type ProductReservationExpirePayload = z.infer<typeof productReservationExpirePayloadSchema>;

/** Job DB 行错误字段的长度上限（§18：sanitized message <= 500）。 */
export const MAX_LAST_ERROR_MESSAGE_LENGTH = 500;
export const MAX_LAST_ERROR_CODE_LENGTH = 100;

/** handler failure 分类（§17）。 */
export type JobFailureClass = "RETRYABLE" | "PERMANENT";

/**
 * PERMANENT failure：unknown job kind / 未知 schemaVersion / payload 形状
 * 非法 / canonical structural corruption。直接 DEAD_LETTER，重试不可能成功。
 * 其余一切（含未知异常）默认 RETRYABLE until maxAttempts。
 */
export class PermanentJobFailure extends Error {
  readonly failureClass: JobFailureClass = "PERMANENT";
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "PermanentJobFailure";
    this.code = code;
  }
}

/**
 * handler 的 domain outcome（§26）：
 *   COMPLETED           = 业务事务已提交（如 EXPIRED materialize）
 *   COMPLETED_IDEMPOTENT = no-op 幂等成功（如 NOT_PENDING——并发 winner
 *                          或 late accept/cancel 已先行关闭）
 *   RESCHEDULE          = NOT_DUE 防御分支：按权威 deadline 重新排程，
 *                         不计失败、不消耗 retry（正常不发生，防 clock /
 *                         stale schedule）
 */
export type JobExecutionOutcome =
  | { kind: "COMPLETED" }
  | { kind: "COMPLETED_IDEMPOTENT" }
  | { kind: "RESCHEDULE"; runAt: Date };

/** claim 后交给 handler 的 job 上下文（payload 原样，由 handler 校验）。 */
export type ClaimedAsyncJob = {
  id: string;
  kind: string;
  schemaVersion: number;
  payload: Prisma.JsonValue;
  attempts: number;
  maxAttempts: number;
  leaseToken: string;
  /** claim 前的状态：RUNNING = lease 过期回收（crash recovery）。 */
  previousStatus: string;
};

export type JobHandler = (
  tx: Prisma.TransactionClient,
  job: ClaimedAsyncJob,
) => Promise<JobExecutionOutcome>;

/** 安全 error code 提取（§18/§39）：优先 PermanentJobFailure.code，其次
 * Prisma/Node 错误 code，再次 Error.name；绝不包含 payload / stack。 */
export function jobErrorCode(error: unknown): string {
  if (error instanceof PermanentJobFailure) {
    return error.code;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.length > 0) {
    return code.slice(0, MAX_LAST_ERROR_CODE_LENGTH);
  }
  if (error instanceof Error && error.name) {
    return error.name.slice(0, MAX_LAST_ERROR_CODE_LENGTH);
  }
  return "UNKNOWN";
}

/**
 * sanitized error message（§18）：仅首行、去控制字符、截断到 500。
 * 完整 stack 走结构化应用日志，绝不写入 job DB 行（严禁 JWT / password /
 * SMTP password / raw provider payload / user free text 入库）。
 */
export function jobErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split("\n", 1)[0] ?? "";
  return firstLine
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, MAX_LAST_ERROR_MESSAGE_LENGTH);
}

/** 分类入口：PermanentJobFailure → PERMANENT；未知异常 → RETRYABLE（§17）。 */
export function classifyJobFailure(error: unknown): JobFailureClass {
  return error instanceof PermanentJobFailure ? "PERMANENT" : "RETRYABLE";
}
