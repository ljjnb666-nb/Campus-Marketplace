import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { pingDatabaseMock, getRedisClientMock, headBucketMock, warnSpy, errorSpy } = vi.hoisted(
  () => ({
    pingDatabaseMock: vi.fn(),
    getRedisClientMock: vi.fn(),
    headBucketMock: vi.fn(),
    warnSpy: vi.fn(),
    errorSpy: vi.fn(),
  }),
);

vi.mock("@/repositories/health-repository", () => ({
  pingDatabase: pingDatabaseMock,
}));

vi.mock("@/lib/rate-limit", () => ({
  getRedisClient: getRedisClientMock,
}));

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    getStorage: () => ({ headBucket: headBucketMock }),
  };
});

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: errorSpy,
  },
}));

import {
  checkDatabase,
  runReadinessChecks,
} from "@/lib/dependency-health";

function redisStub(pong: string | Promise<string> = "PONG") {
  return { ping: vi.fn().mockResolvedValue(pong), status: "ready" };
}

/**
 * Phase 4 TASK 4/5/13：readiness 探针单元测试。
 * READINESS_DATABASE_FAILURE_TEST / READINESS_REDIS_FAILURE_TEST /
 * READINESS_STORAGE_FAILURE_TEST / READINESS_TIMEOUT_TEST 语义覆盖。
 */
describe("dependency-health（/api/ready 探针）", () => {
  beforeEach(() => {
    pingDatabaseMock.mockReset().mockResolvedValue(undefined);
    getRedisClientMock.mockReset().mockReturnValue(redisStub());
    headBucketMock.mockReset().mockResolvedValue(true);
    warnSpy.mockClear();
    errorSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("全正常 → ready（依赖全 ok，不产生 error 日志）", async () => {
    const report = await runReadinessChecks();

    expect(report.status).toBe("ready");
    expect(report.dependencies).toEqual({ database: "ok", redis: "ok", storage: "ok" });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("READINESS_DATABASE_FAILURE_TEST：DB 不可用 → database=failed → not_ready，产生结构化失败事件", async () => {
    pingDatabaseMock.mockRejectedValue(
      new Error("connect ECONNREFUSED postgresql://app:secretpw@db:5432/campus"),
    );

    const report = await runReadinessChecks();

    expect(report.dependencies.database).toBe("failed");
    expect(report.status).toBe("not_ready");
    // TASK 5：failure 事件 WARN/ERROR + 指标
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = JSON.stringify(errorSpy.mock.calls[0]);
    expect(line).toContain("dependency_health_failed");
    expect(line).toContain('"dependency":"database"');
    // sanitized：连接串密码不进入日志（redaction 已覆盖，双保险断言）
    expect(line).not.toContain("secretpw");
  });

  it("READINESS_STORAGE_FAILURE_TEST：bucket 不可达 → storage=failed → not_ready", async () => {
    headBucketMock.mockResolvedValue(false);

    const report = await runReadinessChecks();

    expect(report.dependencies.storage).toBe("failed");
    expect(report.status).toBe("not_ready");
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("READINESS_REDIS_FAILURE_TEST：Redis 故障 → redis=degraded 但整体仍可接流量（REDIS_READINESS_POLICY）", async () => {
    getRedisClientMock.mockReturnValue({
      ping: vi.fn().mockRejectedValue(new Error("MaxRetriesPerRequestError")),
      status: "ready",
    });

    const report = await runReadinessChecks();

    expect(report.dependencies.redis).toBe("degraded");
    expect(report.dependencies.database).toBe("ok");
    expect(report.status).toBe("degraded");
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("未配置 REDIS_URL（本地限流模式）→ redis=ok（无依赖可失败）", async () => {
    getRedisClientMock.mockReturnValue(null);

    const report = await runReadinessChecks();

    expect(report.dependencies.redis).toBe("ok");
    expect(report.status).toBe("ready");
  });

  it("READINESS_TIMEOUT_TEST：单个依赖卡死被 bounded（不拖住 readiness）", async () => {
    pingDatabaseMock.mockImplementation(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late")), 10_000)),
    );

    const startedAt = Date.now();
    // 单依赖预算压到 50ms：10s 的卡死探针必须被快速放弃
    const result = await checkDatabase(50);

    expect(result.status).toBe("failed");
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("失败事件的 error 序列化经 logger redaction（不泄漏 SQL/连接串形态）", async () => {
    pingDatabaseMock.mockRejectedValue(
      Object.assign(new Error("SELECT 1 failed for postgres://u:hunter2222@db/x"), {
        stack: "Error: SELECT 1 failed for postgres://u:hunter2222@db/x\n    at db",
      }),
    );

    await checkDatabase(500);

    const line = JSON.stringify(errorSpy.mock.calls[0]);
    expect(line).not.toContain("hunter2222");
  });
});
