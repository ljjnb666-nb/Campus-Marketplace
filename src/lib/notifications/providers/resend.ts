import {
  EmailProviderPermanentError,
  EmailProviderRetryableError,
  type EmailProvider,
  type TransactionalEmailRequest,
  type TransactionalEmailResult,
} from "@/lib/notifications/email-provider";

/**
 * Phase 9B：RESEND concrete provider（§24/§30/§31）。
 *
 * - native fetch 直调官方 Email API（POST {base}/emails），不为单个
 *   endpoint 引入 SDK 依赖（§91）；
 * - 每次请求必须携带 deterministic Idempotency-Key（§25——由 delivery 行
 *   固化，provider 绝不生成随机 key）；
 * - 所有 external HTTP 有界：AbortSignal.timeout(timeoutMs)（§29）；
 * - 错误分类（§30）：
 *     2xx                         → { providerMessageId }
 *     429 / 5xx / network / timeout / 409 concurrent → RETRYABLE
 *     409 invalid_idempotent_request / 400 / 其它 4xx / 401 / 403 → PERMANENT
 * - 隐私（§31/§32）：provider 绝不持久化/记录 raw response body——分类
 *   只依据 status code 与 409 body 中受控枚举 token 的等值匹配；返回/抛出
 *   的 message 全部为受控内部文案。API key 只进 Authorization header，
 *   绝不进错误对象/日志。
 */

const IDEMPOTENCY_CONFLICT_INVALID_TOKEN = "invalid_idempotent_request";
const IDEMPOTENCY_CONFLICT_CONCURRENT_TOKEN = "concurrent_idempotent_requests";

export type ResendEmailProviderOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** 测试注入 seam（生产使用 globalThis.fetch）。 */
  fetchImpl?: typeof fetch;
};

/** 安全提取 409 body 中的受控枚举 token（绝不返回原始 body）。 */
function classifyConflictToken(bodyText: string | null): "invalid" | "concurrent" | "unknown" {
  if (!bodyText) return "unknown";
  if (bodyText.includes(IDEMPOTENCY_CONFLICT_INVALID_TOKEN)) return "invalid";
  if (bodyText.includes(IDEMPOTENCY_CONFLICT_CONCURRENT_TOKEN)) return "concurrent";
  return "unknown";
}

function safeBodyText(response: Response): Promise<string | null> {
  return response
    .text()
    .then((text) => text.slice(0, 4096))
    .catch(() => null);
}

function mapHttpError(status: number, bodyText: string | null): Error {
  if (status === 409) {
    const token = classifyConflictToken(bodyText);
    if (token === "invalid") {
      return new EmailProviderPermanentError(
        "EMAIL_PROVIDER_IDEMPOTENCY_CONFLICT_INVALID",
        "provider 拒绝幂等键（invalid_idempotent_request）：PERMANENT",
      );
    }
    return new EmailProviderRetryableError(
      "EMAIL_PROVIDER_IDEMPOTENCY_CONFLICT_CONCURRENT",
      "provider 幂等键并发请求（concurrent_idempotent_requests）：RETRYABLE",
    );
  }
  if (status === 429) {
    return new EmailProviderRetryableError(
      "EMAIL_PROVIDER_RATE_LIMITED",
      "provider 限流（429）：RETRYABLE",
    );
  }
  if (status >= 500) {
    return new EmailProviderRetryableError(
      "EMAIL_PROVIDER_UNAVAILABLE",
      "provider 服务端错误（5xx）：RETRYABLE",
    );
  }
  if (status === 401 || status === 403) {
    return new EmailProviderPermanentError(
      "EMAIL_PROVIDER_AUTH_FAILED",
      "provider 认证/授权失败（401/403）：检查 RESEND_API_KEY / 发信域名",
    );
  }
  if (status === 400 || status === 422) {
    return new EmailProviderPermanentError(
      "EMAIL_PROVIDER_INVALID_REQUEST",
      "provider 拒绝请求结构（400/422）：PERMANENT",
    );
  }
  return new EmailProviderPermanentError(
    "EMAIL_PROVIDER_REJECTED",
    `provider 拒绝请求（${status}）：PERMANENT`,
  );
}

export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ResendEmailProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.resend.com").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async sendTransactionalEmail(
    request: TransactionalEmailRequest,
  ): Promise<TransactionalEmailResult> {
    if (!request.idempotencyKey) {
      throw new EmailProviderPermanentError(
        "EMAIL_PROVIDER_IDEMPOTENCY_KEY_MISSING",
        "transactional email request 缺少 deterministic 幂等键",
      );
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          // provider 幂等（24h 保留窗口）：重放/超时重试产生同一逻辑投递
          "Idempotency-Key": request.idempotencyKey,
        },
        body: JSON.stringify({
          from: request.from,
          to: [request.to],
          ...(request.replyTo ? { reply_to: request.replyTo } : {}),
          subject: request.subject,
          text: request.text,
          html: request.html,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // network 层失败分类：timeout（AbortSignal 触发）vs 其它传输错误。
      // 绝不把底层 error message 向上传播（可能含 URL/header 细节）。
      const isTimeout =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      if (isTimeout) {
        throw new EmailProviderRetryableError(
          "EMAIL_PROVIDER_TIMEOUT",
          `provider 请求超时（>${this.timeoutMs}ms）：RETRYABLE`,
        );
      }
      throw new EmailProviderRetryableError(
        "EMAIL_PROVIDER_NETWORK",
        "provider 网络错误（连接失败/重置）：RETRYABLE",
      );
    }

    if (!response.ok) {
      const bodyText = await safeBodyText(response);
      throw mapHttpError(response.status, bodyText);
    }

    // 2xx：提取 providerMessageId（Resend 响应形如 { id: "..." }）。
    let payload: { id?: unknown };
    try {
      payload = (await response.json()) as { id?: unknown };
    } catch {
      throw new EmailProviderRetryableError(
        "EMAIL_PROVIDER_UNAVAILABLE",
        "provider 响应不是合法 JSON：RETRYABLE",
      );
    }
    const providerMessageId = typeof payload.id === "string" ? payload.id : "";
    if (providerMessageId.length === 0) {
      throw new EmailProviderRetryableError(
        "EMAIL_PROVIDER_UNAVAILABLE",
        "provider 2xx 响应缺少 message id：RETRYABLE",
      );
    }
    return { providerMessageId };
  }
}
