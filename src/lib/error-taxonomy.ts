/**
 * 运维视角的错误分类（TASK 3）。
 *
 * 不是第二套业务错误体系：业务语义仍由 handleError / AssetServiceError /
 * ZodError 表达；本模块只回答运维关心的三个问题——
 *   1. 这是什么类别的故障（category）
 *   2. 该以什么级别记录（logLevel）——用户可预期的 4xx 业务错误不触发
 *      error 级告警语义，真正的基础设施故障才是 error
 *   3. 是否属于服务端自身故障（isServerFault → metrics/error rate 关注点）
 */

export type ErrorCategory =
  | "VALIDATION"
  | "AUTHENTICATION"
  | "AUTHORIZATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMIT"
  | "DEPENDENCY"
  | "DATABASE"
  | "CACHE"
  | "STORAGE"
  | "INTERNAL";

export type ErrorClassification = {
  category: ErrorCategory;
  httpStatus: number;
  logLevel: "info" | "warn" | "error";
  /** true = 服务端/基础设施故障（错误率指标与 P1 告警的关注面） */
  isServerFault: boolean;
};

/** HTTP 状态码 → 预期业务错误分类；4xx 一律不视为 server fault */
export function classifyHttpStatus(status: number): ErrorClassification {
  switch (status) {
    case 400:
    case 422:
      return { category: "VALIDATION", httpStatus: status, logLevel: "warn", isServerFault: false };
    case 401:
      return {
        category: "AUTHENTICATION",
        httpStatus: status,
        logLevel: "info",
        isServerFault: false,
      };
    case 403:
      return {
        category: "AUTHORIZATION",
        httpStatus: status,
        logLevel: "warn",
        isServerFault: false,
      };
    case 404:
      return { category: "NOT_FOUND", httpStatus: status, logLevel: "info", isServerFault: false };
    case 409:
      return { category: "CONFLICT", httpStatus: status, logLevel: "warn", isServerFault: false };
    case 429:
      return { category: "RATE_LIMIT", httpStatus: status, logLevel: "warn", isServerFault: false };
    default:
      return { category: "INTERNAL", httpStatus: 500, logLevel: "error", isServerFault: true };
  }
}

/** Redis 客户端错误族（ioredis 命令失败/重试耗尽）的特征名 */
const REDIS_ERROR_NAMES = new Set([
  "MaxRetriesPerRequestError",
  "RedisError",
  "ReplyError",
  "ConnectionError",
]);

/**
 * 把未知异常归入运维分类。
 * 识别顺序：显式 status 属性（业务 error class）→ Prisma → Redis →
 * S3 SDK（$metadata）→ 兜底 INTERNAL。
 */
export function classifyError(error: unknown): ErrorClassification {
  const explicitStatus = (error as { status?: unknown } | null)?.status;
  if (error instanceof Error && typeof explicitStatus === "number") {
    return classifyHttpStatus(explicitStatus);
  }

  // Prisma（按 error-handler.ts 的既有映射：P2002→409、P2025→404，其余 5xx）
  if (error instanceof Error && error.name.startsWith("PrismaClient")) {
    const code = (error as { code?: string }).code;
    if (code === "P2002") {
      return { category: "CONFLICT", httpStatus: 409, logLevel: "warn", isServerFault: false };
    }
    if (code === "P2025") {
      return { category: "NOT_FOUND", httpStatus: 404, logLevel: "info", isServerFault: false };
    }
    return { category: "DATABASE", httpStatus: 500, logLevel: "error", isServerFault: true };
  }

  if (error instanceof Error && REDIS_ERROR_NAMES.has(error.name)) {
    return { category: "CACHE", httpStatus: 500, logLevel: "warn", isServerFault: true };
  }

  // AWS SDK v3 服务错误带 $metadata.httpStatusCode
  const metadata = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata;
  if (metadata && typeof metadata.httpStatusCode === "number") {
    return { category: "STORAGE", httpStatus: 500, logLevel: "error", isServerFault: true };
  }

  // 校验类异常名（ZodError 已由 instanceof 覆盖不了的等价场景兜底）
  if (error instanceof Error && /validation/i.test(error.name)) {
    return { category: "VALIDATION", httpStatus: 400, logLevel: "warn", isServerFault: false };
  }

  return { category: "INTERNAL", httpStatus: 500, logLevel: "error", isServerFault: true };
}
