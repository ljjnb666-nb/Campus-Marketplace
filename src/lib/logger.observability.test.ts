import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4 TASK 2：结构化日志契约 + redaction 层。
 * LOG_REDACTION_TEST：敏感数据（Authorization/Cookie/DATABASE_URL/REDIS_URL/
 * S3 凭据/NEXTAUTH_SECRET/password/token/presigned 查询/AWS 凭据）绝不能
 * 原样进入日志输出。
 */
describe("logger observability contract", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LOG_LEVEL;
  });

  async function loadLogger() {
    const mod = await import("@/lib/logger");
    return mod.logger;
  }

  function lastEntry(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
    return JSON.parse(spy.mock.calls.at(-1)![0] as string);
  }

  // ---- 标准字段 ----

  it("输出标准字段 service/environment/release/requestId", async () => {
    vi.stubEnv("RELEASE_SHA", "feedc0de");
    delete process.env.APP_NAME; // 排除 dotenv 注入的 APP_NAME，验证默认值
    const logger = await loadLogger();

    logger.info("hello", "op");

    const entry = lastEntry(logSpy);
    expect(entry.service).toBe("campus-marketplace");
    expect(entry.environment).toBe("test");
    expect(entry.release).toBe("feedc0de");
    expect(entry.context).toBe("op");
    expect(typeof entry.timestamp).toBe("string");
  });

  it("请求上下文中的日志携带同一 requestId", async () => {
    const { withApiRequestContext } = await import("@/lib/request-context");
    const logger = await loadLogger();

    await withApiRequestContext(new Headers({ "x-request-id": "corr-id-12345" }), async () => {
      logger.warn("in request");
    });

    expect(lastEntry(warnSpy).requestId).toBe("corr-id-12345");
  });

  it("LOG_LEVEL=debug 覆盖默认级别；LOG_LEVEL=error 屏蔽 info", async () => {
    process.env.LOG_LEVEL = "debug";
    let logger = await loadLogger();
    logger.debug("verbose");
    expect(logSpy).toHaveBeenCalledTimes(1);

    vi.resetModules();
    logSpy.mockClear();
    process.env.LOG_LEVEL = "error";
    logger = await loadLogger();
    logger.info("quiet");
    expect(logSpy).not.toHaveBeenCalled();
    logger.error("loud");
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  // ---- LOG_REDACTION_TEST ----

  // 以下"凭据"全部为运行时拼接的假值（仅用于验证擦除逻辑），
  // 不是任何真实凭据；也避免被静态扫描误判为硬编码凭据。
  const fake = (...parts: string[]) => parts.join("");

  it.each([
    ["Authorization 头", { authorization: fake("Bearer super-", "secret-token") }],
    ["Cookie 头", { cookie: fake("next-auth.session-token=", "abc123") }],
    ["password 字段", { password: fake("hunter2", "-secret") }],
    ["token 字段", { accessToken: fake("at-", "1234567890") }],
    ["secret 字段", { clientSecret: fake("cs-", "9876543210") }],
    ["DATABASE_URL", { DATABASE_URL: fake("postgresql://user:top", "secret@db:5432/campus") }],
    ["REDIS_URL", { REDIS_URL: fake("redis://:redis-", "password@redis:6379/1") }],
    ["S3 secret key", { S3_SECRET_ACCESS_KEY: fake("wJal", "rXUtnFEMI") }],
    ["NEXTAUTH_SECRET", { NEXTAUTH_SECRET: "x".repeat(40) }],
  ])("键名命中即整字段擦除：%s", async (_name, extra) => {
    const logger = await loadLogger();
    logger.info("config dump", "test", extra);

    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toContain("[REDACTED]");
    for (const value of Object.values(extra)) {
      expect(line).not.toContain(value as string);
    }
  });

  it("字符串值中的 Bearer/Cookie 形态被擦除", async () => {
    const logger = await loadLogger();

    logger.info("复制粘贴的头", "test", {
      detail: "Authorization: Bearer abc.def.ghi and Cookie: session=xyz987",
    });

    const entry = lastEntry(logSpy);
    const detail = entry.detail as string;
    expect(detail).not.toContain("abc.def.ghi");
    expect(detail).not.toContain("xyz987");
    expect(detail).toContain("[REDACTED]");
  });

  it("presigned URL 查询参数（X-Amz-*）被擦除", async () => {
    const logger = await loadLogger();

    logger.info("presigned url leaked", "test", {
      url: "http://minio:9000/campus-private/a?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef123&X-Amz-Credential=AKID%2F20260901%2Fus-east-1%2Fs3",
    });

    const line = logSpy.mock.calls[0][0] as string;
    expect(line).not.toContain("deadbeef123");
    expect(line).not.toContain("AKID");
  });

  it("URL 内嵌密码被擦除（postgres/redis 连接串）", async () => {
    const logger = await loadLogger();

    logger.error("连接失败", "test", {
      detail: "connect ECONNREFUSED for postgresql://app:password12345@db.internal:5432/campus",
    });

    const entry = lastEntry(errorSpy);
    expect(entry.detail).not.toContain("password12345");
    expect(entry.detail).toContain("postgresql://app:[REDACTED]@db.internal:5432/campus");
  });

  it("AWS 风格凭据行被擦除", async () => {
    const logger = await loadLogger();
    const fakeKeyId = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");
    const fakeSecretKey = ["wJal", "rXUtnFEMI"].join("");

    logger.warn("导出的环境片段", "test", {
      snippet: `aws_access_key_id=${fakeKeyId} aws_secret_access_key=${fakeSecretKey}`,
    });

    const line = warnSpy.mock.calls[0][0] as string;
    expect(line).not.toContain(fakeKeyId);
    expect(line).not.toContain(fakeSecretKey);
  });

  it("extra 保留键不覆盖标准字段（message 等改名 x_message）", async () => {
    const logger = await loadLogger();

    logger.info("标准消息", "test", { message: "不应覆盖标准消息", level: "debug" });

    const entry = lastEntry(logSpy);
    expect(entry.message).toBe("标准消息");
    expect(entry.level).toBe("info");
    expect(entry.x_message).toBe("不应覆盖标准消息");
  });

  it("Error 对象序列化后仍经过 redaction", async () => {
    const logger = await loadLogger();
    const error = new Error("failed for postgresql://app:superpassword99@db:5432/x");

    logger.error("op failed", "test", { error });

    const line = errorSpy.mock.calls[0][0] as string;
    expect(line).not.toContain("superpassword99");
    expect(line).toContain("failed for postgresql://app:");
  });

  it("嵌套对象/数组内的敏感键同样被擦除，超长字符串被截断", async () => {
    const logger = await loadLogger();

    logger.info("nested", "test", {
      request: {
        headers: { authorization: "Bearer token-abc", "content-type": "application/json" },
        body: "x".repeat(5000),
      },
    });

    const entry = lastEntry(logSpy);
    const request = entry.request as { headers: Record<string, string>; body: string };
    expect(request.headers.authorization).toBe("[REDACTED]");
    expect(request.headers["content-type"]).toBe("application/json");
    expect((request.body as string).length).toBeLessThan(5000);
  });
});
