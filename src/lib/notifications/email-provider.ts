import { PermanentJobFailure } from "@/lib/async/job-types";

/**
 * Phase 9B：EmailProvider abstraction（§23）。
 *
 * provider 只认识 transactional email request 本身（地址/主题/正文/幂等键）
 * ——绝不知道 Notification / Order / User / 模板 / retry 语义。外部
 * side effect 只允许发生在 async-worker 的 NOTIFICATION_DELIVERY 执行事务
 * 内（§69：业务事务只 durable record intent，绝不调 external email API）。
 *
 * retry/backoff/dead-letter authority 属 Phase 9A AsyncJob 队列——provider
 * 不自建 retry loop（§62）。provider 的唯一职责：单次请求 + 精确分类。
 */

export type TransactionalEmailRequest = {
  /** deterministic provider 幂等键（notification/<id>/email/v1，§25）。 */
  idempotencyKey: string;
  from: string;
  to: string;
  replyTo?: string | null;
  subject: string;
  text: string;
  html: string;
};

export type TransactionalEmailResult = {
  providerMessageId: string;
};

export interface EmailProvider {
  /** provider 实现身份（与 NotificationDelivery.provider 快照同值域）。 */
  readonly name: string;
  sendTransactionalEmail(request: TransactionalEmailRequest): Promise<TransactionalEmailResult>;
}

// ============================================================
// 受控错误分类（§30）：provider 实现抛出的错误必须是以下两类之一；
// classifyJobFailure 合同：PERMANENT → 立即 DEAD_LETTER，其余 → 9A
// central backoff RETRY until maxAttempts。
// ============================================================

/**
 * PERMANENT provider 失败：auth 配置错误 / 请求结构性非法 / 幂等冲突
 * （invalid_idempotent_request）。重试不可能成功 → 立即 DEAD_LETTER。
 * message 必须是受控内部文案（RB05 合同，绝不携带 provider raw body）。
 */
export class EmailProviderPermanentError extends PermanentJobFailure {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "EmailProviderPermanentError";
  }
}

/**
 * RETRYABLE provider 失败：429 / 5xx / network / timeout /
 * concurrent_idempotent_requests。沿 9A central backoff 重试。
 * 绝不继承 PermanentJobFailure（分类合同依赖 instanceof）。
 */
export class EmailProviderRetryableError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EmailProviderRetryableError";
    this.code = code;
  }
}

/** 结构化观测用的安全分类码白名单值域（§30/§80；绝不包含 provider body）。 */
export const EMAIL_PROVIDER_ERROR_CODES = [
  "EMAIL_PROVIDER_AUTH_FAILED",
  "EMAIL_PROVIDER_INVALID_REQUEST",
  "EMAIL_PROVIDER_IDEMPOTENCY_CONFLICT_INVALID",
  "EMAIL_PROVIDER_IDEMPOTENCY_CONFLICT_CONCURRENT",
  "EMAIL_PROVIDER_RATE_LIMITED",
  "EMAIL_PROVIDER_UNAVAILABLE",
  "EMAIL_PROVIDER_REJECTED",
  "EMAIL_PROVIDER_TIMEOUT",
  "EMAIL_PROVIDER_NETWORK",
] as const;

export type EmailProviderErrorCode = (typeof EMAIL_PROVIDER_ERROR_CODES)[number];

/** 幂等窗口本地安全检查（§26）：首次 attempt 起算超过 23h → fail closed。 */
export function isEmailIdempotencyWindowExpired(
  firstAttemptAt: Date,
  now: Date,
  safeWindowMs: number,
): boolean {
  return now.getTime() - firstAttemptAt.getTime() >= safeWindowMs;
}
