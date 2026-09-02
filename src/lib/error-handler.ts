import { Prisma } from "@prisma/client";
import { ZodError } from "zod";

import { logger } from "@/lib/logger";
import { getRequestId } from "@/lib/request-context";
import { classifyError } from "@/lib/error-taxonomy";
import { METRIC_NAMES, incrementCounter } from "@/lib/metrics";

export type HandledError = {
  /** 可直接展示给用户的中文提示 */
  message: string;
  /** 对应的 HTTP 状态码，server action 场景可忽略 */
  statusCode: number;
};

/**
 * 把未知异常归类为「可展示给用户的消息 + HTTP 状态码」。
 * 已知类别（唯一约束、记录不存在、参数校验失败）返回精确提示，
 * 其余一律记日志并返回通用 500 提示，避免内部细节泄漏。
 *
 * Phase 4 增强（TASK 3/6）：服务端故障日志附带运维分类（category）与
 * requestId，并计入 unexpected_server_errors_total；用户可预期的业务
 * 错误（400 校验 / 409 冲突 / 404 不存在）保持原有"不刷日志"行为，
 * 不进入错误率告警关注面。
 */
export function handleError(error: unknown, context: string): HandledError {
  if (error instanceof ZodError) {
    return {
      message: error.issues[0]?.message ?? "请求参数不正确",
      statusCode: 400,
    };
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case "P2002":
        return { message: "数据已存在，请勿重复提交", statusCode: 409 };
      case "P2025":
        return { message: "记录不存在或已被删除", statusCode: 404 };
      default:
        return logServerFault(error, context, "数据库请求失败", "操作失败，请稍后重试");
    }
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    return logServerFault(error, context, "数据库查询参数非法", "操作失败，请稍后重试");
  }

  return logServerFault(error, context, "未处理异常", "服务器内部错误，请稍后重试");
}

/** 记录服务端故障：分类 + requestId + 指标，返回通用 500 提示。 */
function logServerFault(
  error: unknown,
  context: string,
  message: string,
  userMessage: string,
): HandledError {
  const classification = classifyError(error);
  incrementCounter(METRIC_NAMES.unexpectedErrors, { category: classification.category });

  const log = classification.logLevel === "warn" ? logger.warn : logger.error;
  log(message, context, {
    event: "server_error_classified",
    category: classification.category,
    requestId: getRequestId(),
    error,
  });
  return { message: userMessage, statusCode: 500 };
}

/** server action 通用兜底消息（不含状态码场景） */
export function actionErrorMessage(error: unknown, context: string): string {
  return handleError(error, context).message;
}
