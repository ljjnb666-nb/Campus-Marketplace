import { beforeEach, describe, expect, it, vi } from "vitest";

const { runReadinessChecksMock, infoSpy } = vi.hoisted(() => ({
  runReadinessChecksMock: vi.fn(),
  infoSpy: vi.fn(),
}));

vi.mock("@/lib/dependency-health", () => ({
  runReadinessChecks: runReadinessChecksMock,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: infoSpy,
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { GET } from "@/app/api/ready/route";

// 路由签名要求 Request（读取请求头做 request-id 关联）
const dummyRequest = () => new Request("http://localhost/api/ready");

function readyReport(overrides: Record<string, string> = {}) {
  return {
    status: "ready",
    dependencies: { database: "ok", redis: "ok", storage: "ok", ...overrides },
    checks: [],
  };
}

/**
 * Phase 4 TASK 4：/api/ready 路由契约。
 * ERROR_LEAKAGE_TEST：失败响应只含高层状态，绝无 stack/连接串/凭据。
 */
describe("GET /api/ready", () => {
  beforeEach(() => {
    runReadinessChecksMock.mockReset();
    infoSpy.mockClear();
  });

  it("全正常 → 200 + status ready + release + 依赖高层状态", async () => {
    runReadinessChecksMock.mockResolvedValue(readyReport());

    const response = await GET(dummyRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ready");
    expect(body.dependencies).toEqual({ database: "ok", redis: "ok", storage: "ok" });
    expect(body.release).toBe("dev");
    // 正常探测不产生 INFO 日志（避免 polling 刷屏）
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("DB down → 503 + not_ready，但响应体无任何敏感细节", async () => {
    runReadinessChecksMock.mockResolvedValue({
      status: "not_ready",
      dependencies: { database: "failed", redis: "ok", storage: "ok" },
      checks: [
        {
          dependency: "database",
          status: "failed",
          durationMs: 12,
          error: "Error: connect ECONNREFUSED postgresql://app:secretpw@10.0.0.5:5432/campus",
          stack: "Error: at Pool.connect\n    at /app/node_modules/...",
        },
      ],
    });

    const response = await GET(dummyRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("not_ready");
    expect(body.dependencies.database).toBe("failed");
    // ERROR_LEAKAGE_TEST：高层状态之外的一切细节不进入公开响应
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("secretpw");
    expect(raw).not.toContain("ECONNREFUSED");
    expect(raw).not.toContain("stack");
    expect(raw).not.toContain("10.0.0.5");
    // 非 ready 输出一条结构化 readiness_reported 事件
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  it("仅 Redis 降级 → 仍 200 + status degraded", async () => {
    runReadinessChecksMock.mockResolvedValue({
      status: "degraded",
      dependencies: { database: "ok", redis: "degraded", storage: "ok" },
      checks: [],
    });

    const response = await GET(dummyRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.dependencies.redis).toBe("degraded");
  });

  it("响应禁止缓存", async () => {
    runReadinessChecksMock.mockResolvedValue(readyReport());

    const response = await GET(dummyRequest());

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
