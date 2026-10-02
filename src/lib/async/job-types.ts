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

/**
 * PRODUCT_RESERVATION_EXPIRE payload 冻结形状：仅 orderId。
 * RB04：strict——未知键即 INVALID（绝不 parse-success + silently strip：
 * strip 只保护 parse 结果，不阻止原始 JSON 落库）。
 */
export const productReservationExpirePayloadSchema = z
  .object({
    orderId: z.string().min(1),
  })
  .strict();

export type ProductReservationExpirePayload = z.infer<typeof productReservationExpirePayloadSchema>;

// ============================================================
// RB04 纯契约层（writer 边界 + runtime 双层共用的单一事实源）：
// 本文件只含 kind / schemaVersion / Zod schema，绝不 import handler——
// repository（写边界）与 job-registry/handler（执行边界）均可安全消费。
// ============================================================

const JOB_PAYLOAD_CONTRACTS = new Map<string, Map<number, z.ZodType>>(
  [[
    PRODUCT_RESERVATION_EXPIRE_JOB_KIND,
    new Map([[PRODUCT_RESERVATION_EXPIRE_JOB_SCHEMA_VERSION, productReservationExpirePayloadSchema]]),
  ]],
);

export type AsyncIntentValidation =
  | { ok: true; payload: Prisma.InputJsonValue }
  | { ok: false; reason: "UNKNOWN_CONTRACT" | "INVALID_PAYLOAD" };

/**
 * RB04 写边界契约校验：未知 kind/version 或 payload 形状非法（含未知键），
 * 一律拒绝并返回 canonical parsed payload（持久化的只能是 canonical 形状，
 * 绝不是原始输入 JSON）。
 */
export function validateJobIntent(
  kind: string,
  schemaVersion: number,
  payload: unknown,
): AsyncIntentValidation {
  const versions = JOB_PAYLOAD_CONTRACTS.get(kind);
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

// RB04 写边界受控契约错误 AsyncJobIntentContractError：定义置于本文件
// PermanentJobFailure 之后（class extends 无提升）。

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
 * RB04 写边界受控契约错误：enqueueAsyncJobTx 校验失败时抛出——业务事务
 * 回滚、零 AsyncJob 行（privacy violation 绝不先落库再靠 worker dead-letter
 * 补救）。code 属受控机器码格式（RB05 合同）。
 */
export class AsyncJobIntentContractError extends PermanentJobFailure {
  constructor(reason: "UNKNOWN_CONTRACT" | "INVALID_PAYLOAD", kind: string, schemaVersion: number) {
    super(
      reason === "UNKNOWN_CONTRACT"
        ? "ASYNC_JOB_INTENT_CONTRACT_UNKNOWN"
        : "ASYNC_JOB_INTENT_CONTRACT_INVALID",
      reason === "UNKNOWN_CONTRACT"
        ? `未注册的 job kind/schemaVersion 拒绝写入：${kind}@${schemaVersion}`
        : `job payload 未通过 strict 契约校验（kind=${kind} version=${schemaVersion}）`,
    );
    this.name = "AsyncJobIntentContractError";
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
// ============================================================
// RB05：lastErrorCode = CONTROLLED MACHINE CODE ONLY。
// 受控内部码 / Prisma 机器码（格式 allowlist）/ Node 传输码（显式
// allowlist）/ 安全机器格式的 Error.name——四类之外一律 UNKNOWN。
// 绝不持久化 arbitrary exception 附加字段（error.code 可携带任意字符串，
// 包括 secret / free text；secret regex 黑名单不可能穷尽，唯一防线是
// DENY-BY-DEFAULT allowlist）。jobErrorCode 与 outboxEventErrorCode 共用
// 本实现，禁止两套逻辑漂移。
// ============================================================

/** 受控内部码格式（PermanentJobFailure.code 必须匹配，否则 INTERNAL_ERROR）。 */
const CONTROLLED_CODE_PATTERN = /^[A-Z][A-Z0-9_:-]{0,99}$/;
/** Prisma known request 机器码格式（P1001 / P2002 / ...）。 */
const PRISMA_MACHINE_CODE_PATTERN = /^P[0-9]{4}$/;
/** Node 传输层错误码显式 allowlist（9A 仅 DB 依赖，按需扩展）。 */
const NODE_TRANSPORT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
]);
/** Error.name 安全机器格式（TypeError / Error / PrismaClientKnownRequestError ...）。 */
const SAFE_ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;

export function safeAsyncErrorCode(error: unknown): string {
  if (error instanceof PermanentJobFailure) {
    return CONTROLLED_CODE_PATTERN.test(error.code) ? error.code : "INTERNAL_ERROR";
  }

  const candidate = error as { name?: unknown; code?: unknown } | null;
  const name = typeof candidate?.name === "string" ? candidate.name : "";
  const code = typeof candidate?.code === "string" ? candidate.code : "";

  // Prisma known request 机器码：仅凭"存在 code 字段"判断是不够的——
  // 必须 name 与 P#### 格式同时命中
  if (name === "PrismaClientKnownRequestError" && PRISMA_MACHINE_CODE_PATTERN.test(code)) {
    return code;
  }
  // Node 传输层码：显式 allowlist（无 regex / 无任意字符串）
  if (NODE_TRANSPORT_ERROR_CODES.has(code)) {
    return code;
  }
  // Error.name：安全机器格式 → bounded safe code；否则 UNKNOWN
  if (SAFE_ERROR_NAME_PATTERN.test(name)) {
    return name.slice(0, MAX_LAST_ERROR_CODE_LENGTH);
  }
  return "UNKNOWN";
}

/** AsyncJob.lastErrorCode 合同（与 outboxEventErrorCode 共用实现）。 */
export function jobErrorCode(error: unknown): string {
  return safeAsyncErrorCode(error);
}

/**
 * RB02 安全合同（DENY RAW EXCEPTION MESSAGE BY DEFAULT）：
 *
 * `lastErrorMessage` 必须是 SAFE MACHINE DIAGNOSTIC ONLY——绝不允许任意
 * exception text 落库。秘密格式无限（JWT/password/SMTP secret/provider
 * response/user free text），secret regex 黑名单不可能穷尽，因此唯一防线是：
 *
 *   DENY raw error.message by default
 *   ALLOW controlled internal message only
 *
 * - PermanentJobFailure：message 由内部代码自行生成的受控文案（可含 orderId
 *   等机器 ID）→ 允许，但仍经消毒（首行 / 去控制字符 / <=500）；
 * - 其余一切（unknown / retryable exception）→ 固定 generic message；
 *   机器诊断依赖 lastErrorCode，完整技术细节走结构化应用日志（且日志同样
 *   只写 errorName/errorCode，不写 message/stack/payload）。
 */
export const GENERIC_JOB_FAILURE_MESSAGE = "异步任务执行失败";

function sanitizeControlledMessage(raw: string): string {
  const firstLine = raw.split("\n", 1)[0] ?? "";
  return firstLine
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, MAX_LAST_ERROR_MESSAGE_LENGTH);
}

export function jobErrorMessage(error: unknown): string {
  if (error instanceof PermanentJobFailure) {
    return sanitizeControlledMessage(error.message);
  }
  return GENERIC_JOB_FAILURE_MESSAGE;
}

/** 分类入口：PermanentJobFailure → PERMANENT；未知异常 → RETRYABLE（§17）。 */
export function classifyJobFailure(error: unknown): JobFailureClass {
  return error instanceof PermanentJobFailure ? "PERMANENT" : "RETRYABLE";
}
