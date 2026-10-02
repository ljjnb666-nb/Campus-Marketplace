import { z } from "zod";

import { PermanentJobFailure } from "@/lib/async/job-types";

/**
 * Phase 9B：transactional email 配置契约（§44/§45/§29/§26）。
 *
 * - EMAIL_PROVIDER：生产必须 = resend（production-env-check fail-closed
 *   强制）；开发允许 disabled（无外部依赖环境，emit 侧直接抑制 delivery）。
 * - RESEND_API_BASE_URL：生产固定 https://api.resend.com，禁止 env 覆盖
 *   （防 API key exfiltration / SSRF）；仅 NODE_ENV !== production 允许
 *   local fake base URL（integration/E2E fake provider 注入点）。
 * - EMAIL_PROVIDER_TIMEOUT_MS：所有 external HTTP 必须有界（AbortSignal
 *   .timeout）；生产合理范围 1000..30000，缺省 10000。
 * - EMAIL_IDEMPOTENCY_SAFE_WINDOW_MS：Resend provider 幂等保留窗口 24h 的
 *   本地安全窗口（23h）。首次实际 provider attempt（firstAttemptAt）起算，
 *   超窗后的任何 retry 一律 no-provider-call → PermanentJobFailure →
 *   DEAD_LETTER（fail closed，禁止盲目重发）。
 *
 * 隐私：本模块绝不打印/返回任何秘密值（API key / 收件地址由消费方持有，
 * 部署 preflight 日志只允许变量名 + PASS/FAIL——见
 * scripts/production-env-check.ts）。
 */

export const OFFICIAL_RESEND_BASE_URL = "https://api.resend.com";

export const EMAIL_PROVIDER_TIMEOUT_MS_DEFAULT = 10_000;
export const EMAIL_PROVIDER_TIMEOUT_MS_MIN = 1_000;
export const EMAIL_PROVIDER_TIMEOUT_MS_MAX = 30_000;

/** Resend 幂等保留窗口 = 24h；本地安全窗口 = 23h（§26）。 */
export const EMAIL_IDEMPOTENCY_SAFE_WINDOW_HOURS = 23;
export const EMAIL_IDEMPOTENCY_SAFE_WINDOW_MS = EMAIL_IDEMPOTENCY_SAFE_WINDOW_HOURS * 60 * 60 * 1000;

export type EmailProviderName = "resend" | "disabled";

/**
 * emit 时快照所需的 channel config（provider 身份 + sender/replyTo）。
 * from/replyTo 在 emit 时刻固化为 NotificationDelivery.senderSnapshot /
 * replyToSnapshot——retry 绝不重读 env（§33 deterministic request）。
 */
export type EmailChannelConfig = {
  provider: EmailProviderName;
  from: string | null;
  replyTo: string | null;
};

/**
 * provider 真实发送所需的 config（仅 resend 需要；worker 执行边界读取）。
 */
export type EmailSendConfig = {
  provider: EmailProviderName;
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
};

/** 受控配置错误（fail closed；code 属受控机器码格式）。 */
export class EmailProviderConfigError extends PermanentJobFailure {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "EmailProviderConfigError";
  }
}

/**
 * 严格但现实的 email 地址校验（§42）：支持 "addr@domain" 与
 * "Display Name <addr@domain>" 两种形态，地址部分用 z.string().email()。
 * 绝不自写 RFC 巨型 regex。非法/缺失返回 null（调用方据此抑制 delivery）。
 */
export function extractEmailAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const angle = trimmed.match(/<([^<>]+)>\s*$/);
  const candidate = (angle ? angle[1]! : trimmed).trim();
  return z.string().email().safeParse(candidate).success ? candidate : null;
}

type EmailEnv = Record<string, string | undefined>;

/**
 * emit 时解析 channel config（§44）：
 * - EMAIL_PROVIDER=disabled → { provider: "disabled", from: null, replyTo: null }
 *   （delivery 将以 PROVIDER_DISABLED 抑制，0 provider call）；
 * - EMAIL_PROVIDER=resend → from 必须是合法 email 形态（生产由 env-check
 *   保证；运行时 fail closed——非法即 EmailProviderConfigError，emit 事务
 *   回滚零落库）；replyTo 可选（设置时必须合法）。
 * 未设置 EMAIL_PROVIDER：非生产环境按 disabled 处理；生产环境拒绝
 * （生产 env 契约要求显式配置）。
 */
export function resolveEmailChannelConfig(env: EmailEnv = process.env): EmailChannelConfig {
  const rawProvider = env.EMAIL_PROVIDER?.trim() ?? "";
  const isProduction = env.NODE_ENV === "production";

  if (rawProvider === "" || rawProvider === "disabled") {
    if (isProduction && rawProvider === "") {
      throw new EmailProviderConfigError(
        "EMAIL_PROVIDER_CONFIG_INVALID",
        "生产环境 EMAIL_PROVIDER 必须显式配置为 resend",
      );
    }
    return { provider: "disabled", from: null, replyTo: null };
  }

  if (rawProvider !== "resend") {
    throw new EmailProviderConfigError(
      "EMAIL_PROVIDER_CONFIG_INVALID",
      `未知 EMAIL_PROVIDER：仅支持 resend / disabled`,
    );
  }

  const from = extractEmailAddress(env.EMAIL_FROM);
  if (!from) {
    throw new EmailProviderConfigError(
      "EMAIL_PROVIDER_CONFIG_INVALID",
      "EMAIL_PROVIDER=resend 要求合法的 EMAIL_FROM",
    );
  }

  const replyToRaw = env.EMAIL_REPLY_TO?.trim() ?? "";
  let replyTo: string | null = null;
  if (replyToRaw !== "") {
    replyTo = extractEmailAddress(replyToRaw);
    if (!replyTo) {
      throw new EmailProviderConfigError(
        "EMAIL_PROVIDER_CONFIG_INVALID",
        "EMAIL_REPLY_TO 设置时必须是合法 email",
      );
    }
  }

  return { provider: "resend", from: env.EMAIL_FROM!.trim(), replyTo };
}

/**
 * worker 发送边界解析 send config（仅 resend 有真实 external call）。
 * - API key：非空 + 非 unsafe dummy（生产 env-check 双层保证）；
 * - baseUrl：生产强制 OFFICIAL_RESEND_BASE_URL（env 覆盖 = 配置错误，
 *   防 SSRF/secret exfil，§45）；非生产允许 RESEND_API_BASE_URL 注入
 *   local fake provider（integration/E2E）；
 * - timeout：整数 1000..30000（缺省 10000），越界即受控配置错误。
 */
export function resolveEmailSendConfig(env: EmailEnv = process.env): EmailSendConfig {
  const rawProvider = env.EMAIL_PROVIDER?.trim() ?? "";
  const isProduction = env.NODE_ENV === "production";

  if (rawProvider !== "resend") {
    throw new EmailProviderConfigError(
      "EMAIL_PROVIDER_CONFIG_INVALID",
      "EMAIL send config 仅在 EMAIL_PROVIDER=resend 下可用",
    );
  }

  const apiKey = env.RESEND_API_KEY?.trim() ?? "";
  if (apiKey.length === 0 || apiKey.toLowerCase().includes("dummy") || /changeme|your[-_]?key/i.test(apiKey)) {
    throw new EmailProviderConfigError(
      "EMAIL_PROVIDER_CONFIG_INVALID",
      "RESEND_API_KEY 缺失或为不安全占位值",
    );
  }

  const configuredBase = env.RESEND_API_BASE_URL?.trim() ?? "";
  let baseUrl = OFFICIAL_RESEND_BASE_URL;
  if (configuredBase !== "") {
    if (isProduction) {
      throw new EmailProviderConfigError(
        "EMAIL_PROVIDER_CONFIG_INVALID",
        "生产环境禁止覆盖 RESEND_API_BASE_URL（固定 https://api.resend.com）",
      );
    }
    if (!configuredBase.startsWith("http://") && !configuredBase.startsWith("https://")) {
      throw new EmailProviderConfigError(
        "EMAIL_PROVIDER_CONFIG_INVALID",
        "RESEND_API_BASE_URL 必须是 http(s) URL",
      );
    }
    baseUrl = configuredBase.replace(/\/+$/, "");
  }

  const rawTimeout = env.EMAIL_PROVIDER_TIMEOUT_MS?.trim() ?? "";
  let timeoutMs = EMAIL_PROVIDER_TIMEOUT_MS_DEFAULT;
  if (rawTimeout !== "") {
    const parsed = Number(rawTimeout);
    if (!Number.isInteger(parsed) || parsed < EMAIL_PROVIDER_TIMEOUT_MS_MIN || parsed > EMAIL_PROVIDER_TIMEOUT_MS_MAX) {
      throw new EmailProviderConfigError(
        "EMAIL_PROVIDER_CONFIG_INVALID",
        `EMAIL_PROVIDER_TIMEOUT_MS 必须是 ${EMAIL_PROVIDER_TIMEOUT_MS_MIN}..${EMAIL_PROVIDER_TIMEOUT_MS_MAX} 的整数`,
      );
    }
    timeoutMs = parsed;
  }

  return { provider: "resend", apiKey, baseUrl, timeoutMs };
}

/**
 * 邮件链接唯一 origin（§41）：canonical NEXTAUTH_URL；生产必须 https://；
 * 绝不从 Host header / request origin / client input 生成。
 */
export function resolveEmailAppBaseUrl(env: EmailEnv = process.env): string {
  const raw = env.NEXTAUTH_URL?.trim() ?? "";
  if (raw === "") {
    throw new EmailProviderConfigError(
      "EMAIL_LINK_ORIGIN_INVALID",
      "NEXTAUTH_URL 缺失：邮件链接 origin 必须来自 canonical 配置",
    );
  }
  if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
    throw new EmailProviderConfigError(
      "EMAIL_LINK_ORIGIN_INVALID",
      "NEXTAUTH_URL 必须是 http(s) URL",
    );
  }
  if (env.NODE_ENV === "production" && !raw.startsWith("https://")) {
    throw new EmailProviderConfigError(
      "EMAIL_LINK_ORIGIN_INVALID",
      "生产环境邮件链接 origin 必须 https://",
    );
  }
  return raw.replace(/\/+$/, "");
}
