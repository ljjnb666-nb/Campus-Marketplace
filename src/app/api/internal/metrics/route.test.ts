import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
  },
}));

import { GET } from "@/app/api/internal/metrics/route";

function requestWith(token?: string) {
  const headers = new Headers();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return new Request("http://localhost/api/internal/metrics", { headers });
}

/**
 * Phase 4 TASK 6：metrics 端点访问控制。
 * 契约：未配置 METRICS_BEARER_TOKEN → 404（默认关闭）；配置后需正确
 * 专用 token（禁止复用 NEXTAUTH_SECRET）。
 */
describe("GET /api/internal/metrics", () => {
  beforeEach(() => {
    warnSpy.mockClear();
  });

  afterEach(() => {
    delete process.env.METRICS_BEARER_TOKEN;
  });

  it("未配置 token → 404（端点默认关闭，无裸露面）", async () => {
    delete process.env.METRICS_BEARER_TOKEN;

    const response = await GET(requestWith());

    expect(response.status).toBe(404);
  });

  it("无/错误凭据 → 403 + 结构化拒绝日志", async () => {
    process.env.METRICS_BEARER_TOKEN = "metrics-secret-token-value";

    const noAuth = await GET(requestWith());
    expect(noAuth.status).toBe(403);

    const badAuth = await GET(requestWith("wrong-token"));
    expect(badAuth.status).toBe(403);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("正确 token → 200 + Prometheus 文本格式 + no-store", async () => {
    process.env.METRICS_BEARER_TOKEN = "metrics-secret-token-value";

    const response = await GET(requestWith("metrics-secret-token-value"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(typeof body).toBe("string");
  });

  it("拒绝日志不回显 presented token", async () => {
    process.env.METRICS_BEARER_TOKEN = "expected-token-value-123";

    await GET(requestWith("leak-me-if-you-can"));

    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).not.toContain("leak-me-if-you-can");
  });
});
