import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("logger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // 测试环境 NODE_ENV=test，info 及以上级别会输出
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function loadLogger() {
    const mod = await import("@/lib/logger");
    return mod.logger;
  }

  it("emits info logs as single-line JSON with level and message", async () => {
    const logger = await loadLogger();

    logger.info("请求完成", "order", { orderId: "o-1" });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("请求完成");
    expect(entry.context).toBe("order");
    expect(entry.orderId).toBe("o-1");
    expect(typeof entry.timestamp).toBe("string");
  });

  it("routes warn/error to console.warn/console.error", async () => {
    const logger = await loadLogger();

    logger.warn("流量异常", "rate-limit");
    logger.error("数据库不可达", "health");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const warnEntry = JSON.parse(warnSpy.mock.calls[0][0] as string);
    const errorEntry = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(warnEntry.level).toBe("warn");
    expect(errorEntry.level).toBe("error");
  });

  it("serializes Error objects in extra fields to stack strings", async () => {
    const logger = await loadLogger();
    const failure = new Error("boom");

    logger.error("操作失败", "action", { error: failure });

    const entry = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(entry.error).toContain("boom");
    expect(entry.error).toContain("Error:");
  });

  it("suppresses debug logs when NODE_ENV is not development", async () => {
    const logger = await loadLogger();

    logger.debug("调试信息");

    expect(logSpy).not.toHaveBeenCalled();
  });
});
