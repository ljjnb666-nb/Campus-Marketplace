type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// 最低输出级别：开发环境输出 debug 及以上，其他环境 info 及以上
const MIN_LEVEL: LogLevel = process.env.NODE_ENV === "development" ? "debug" : "info";

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[MIN_LEVEL];
}

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * 结构化日志：单行 JSON 输出，便于日志聚合服务（如 Loki/CloudWatch）解析。
 * context 标注来源模块或请求场景，extra 携带业务字段。
 */
function emit(level: LogLevel, message: string, context?: string, extra?: Record<string, unknown>) {
  if (!shouldLog(level)) {
    return;
  }

  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };

  if (context) {
    entry.context = context;
  }

  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value instanceof Error) {
        entry[key] = serializeError(value);
      } else {
        entry[key] = value;
      }
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
