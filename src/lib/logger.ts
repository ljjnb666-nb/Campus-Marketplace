import { getRequestId } from "@/lib/request-context";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLevel(value: string | undefined): LogLevel | undefined {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
    ? value
    : undefined;
}

/**
 * 最低输出级别（TASK 2）：
 * - LOG_LEVEL 环境变量显式覆盖（运维可在不改代码的情况下调整噪音/排障级别）；
 * - 未设置时沿用默认：开发 debug，其他 info。
 */
function minLevel(): LogLevel {
  const override = normalizeLevel(process.env.LOG_LEVEL);
  if (override) {
    return override;
  }
  return process.env.NODE_ENV === "development" ? "debug" : "info";
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel()];
}

// ---------------------------------------------------------------------------
// Redaction（TASK 2）：不能依赖开发者"记得不打印"，在 logger 出口统一擦除。
// 原则：宁可过度擦除，不可泄漏秘密。
// ---------------------------------------------------------------------------

/** 键名命中即整字段擦除（含 connection string 类字段本身）。 */
const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|authorization|auth|cookie|credential|apikey|api[-_]?key|access[-_]?key|session|presigned|x-amz|database[-_]?url|redis[-_]?url|connection[-_]?url)/i;

/** 字符串值内的秘密形态（Bearer 头、presigned 查询参数、URL 内嵌密码）。 */
const SENSITIVE_VALUE_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /bearer\s+[a-z0-9._~+/=-]+/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /cookie:\s*[^;,"']+/gi, replacement: "Cookie: [REDACTED]" },
  { pattern: /(x-amz-(signature|credential|security-token|date))=[^&\s"']+/gi, replacement: "$1=[REDACTED]" },
  {
    pattern: /((?:postgres(?:ql)?|redis|rediss|mysql|mongodb):\/\/[^:/\s"@]+:)[^@/\s"]+(@)/gi,
    replacement: "$1[REDACTED]$2",
  },
  { pattern: /(aws_access_key_id|aws_secret_access_key)\s*[=:]\s*\S+/gi, replacement: "$1=[REDACTED]" },
];

const REDACTED = "[REDACTED]";
const MAX_REDACT_DEPTH = 4;
/** 单个字符串字段上限：超长值（如完整 request body）不进入日志。 */
const MAX_STRING_LENGTH = 2000;

/** 日志标准字段：extra 中的同名键不得覆盖（加 x_ 前缀保留信息） */
const RESERVED_KEYS = new Set([
  "timestamp",
  "level",
  "message",
  "service",
  "environment",
  "release",
  "requestId",
  "context",
]);

function redactString(value: string): string {
  let result = value;
  for (const { pattern, replacement } of SENSITIVE_VALUE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  if (result.length > MAX_STRING_LENGTH) {
    result = `${result.slice(0, MAX_STRING_LENGTH)}…[truncated]`;
  }
  return result;
}

function redactValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (value instanceof Error) {
    return redactString(serializeError(value));
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value;
  }
  if (depth >= MAX_REDACT_DEPTH) {
    return "[depth-truncated]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactValue(item, depth + 1));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactValue(item, depth + 1);
    }
    return out;
  }
  // symbol / function 等不可序列化值
  return String(value);
}

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * 结构化日志（TASK 2 契约，见 docs/OBSERVABILITY.md）：
 * 单行机器可解析 JSON，标准字段 timestamp/level/message/service/
 * environment/release/requestId + context（= operation）+ 业务 extra。
 * extra 经 redaction 层统一脱敏后再输出。
 */
function emit(level: LogLevel, message: string, context?: string, extra?: Record<string, unknown>) {
  if (!shouldLog(level)) {
    return;
  }

  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
    service: process.env.APP_NAME || "campus-marketplace",
    environment: process.env.NODE_ENV ?? "unknown",
    release: process.env.RELEASE_SHA ?? "dev",
  };

  const requestId = getRequestId();
  if (requestId) {
    entry.requestId = requestId;
  }

  if (context) {
    entry.context = context;
  }

  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      // 保留键防覆盖：extra 里的同名键加前缀，保证标准字段永远可信
      const targetKey = RESERVED_KEYS.has(key) ? `x_${key}` : key;
      entry[targetKey] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactValue(value, 0);
    }
  }

  const line = JSON.stringify(entry);

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug(message: string, context?: string, extra?: Record<string, unknown>) {
    emit("debug", message, context, extra);
  },
  info(message: string, context?: string, extra?: Record<string, unknown>) {
    emit("info", message, context, extra);
  },
  warn(message: string, context?: string, extra?: Record<string, unknown>) {
    emit("warn", message, context, extra);
  },
  error(message: string, context?: string, extra?: Record<string, unknown>) {
    emit("error", message, context, extra);
  },
};
