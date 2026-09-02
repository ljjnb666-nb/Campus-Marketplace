import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { warnSpy, errorSpy } = vi.hoisted(() => ({ warnSpy: vi.fn(), errorSpy: vi.fn() }));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: errorSpy,
  },
}));

import { GET } from "@/app/api/internal/metrics/route";

// 运行时拼接：合法形态的专用 token（非真实凭据，>=24 字符，非 NEXTAUTH_SECRET）
const DEDICATED_TOKEN = ["e2e-dedicated-metrics-token-", "qwertyuiopasdfgh"].join("");
const NEXTAUTH_SECRET = ["nextauth-secret-value-", "zxcvbnmasdfghjkl"].join("");

function requestWith(token?: string) {
  const headers = new Headers();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return new Request("http://localhost/api/internal/metrics", { headers });
}

/**
 * Phase 4 TASK 6 + BLOCKER 3：metrics 端点访问控制（代码强制 fail-closed）。
 * 契约：未配置 → 404（默认关闭）；配置但违反安全契约（过短/危险默认值/
 * 复用 NEXTAUTH_SECRET）→ 端点保持关闭（404）+ 结构化配置错误日志；
 * 契约通过后正确 token → 200，错误 token → 403。
 */
describe("GET /api/internal/metrics", () => {
  beforeEach(() => {
    warnSpy.mockClear();
    errorSpy.mockClear();
  });

  afterEach(() => {
    delete process.env.METRICS_BEARER_TOKEN;
    delete process.env.NEXTAUTH_SECRET;
  });

  it("METRICS_TOKEN_UNSET：未配置 token → 404（端点默认关闭，无裸露面）", async () => {
    delete process.env.METRICS_BEARER_TOKEN;

    const response = await GET(requestWith());

    expect(response.status).toBe(404);
    expect(errorSpy).not.toHaveBeenCalled(); // 未设置是允许态，不算配置错误
  });

  it("正确专用 token → 200 + Prometheus 文本格式 + no-store", async () => {
    process.env.METRICS_BEARER_TOKEN = DEDICATED_TOKEN;

    const ok = await GET(requestWith(DEDICATED_TOKEN));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toContain("text/plain");
    expect(ok.headers.get("Cache-Control")).toBe("no-store");

    const wrong = await GET(requestWith("wrong-token-value-that-is-long-enough"));
    expect(wrong.status).toBe(403);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("METRICS_SHORT_TOKEN_TEST：过短 token → 端点保持关闭（404）+ 配置错误日志", async () => {
    process.env.METRICS_BEARER_TOKEN = "short-token";

    const response = await GET(requestWith("short-token"));

    expect(response.status).toBe(404);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(errorSpy.mock.calls[0]);
    expect(logged).toContain("too_short");
    // 日志不回显 token 值
    expect(logged).not.toContain("short-token");
  });

  it("METRICS_SECRET_REUSE_TEST：token == NEXTAUTH_SECRET → 端点保持关闭（404）", async () => {
    process.env.METRICS_BEARER_TOKEN = NEXTAUTH_SECRET;
    process.env.NEXTAUTH_SECRET = NEXTAUTH_SECRET;

    const response = await GET(requestWith(NEXTAUTH_SECRET));

    expect(response.status).toBe(404);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(errorSpy.mock.calls[0]);
    expect(logged).toContain("reuses_nextauth_secret");
    // 日志绝不输出两个 secret 值
    expect(logged).not.toContain(NEXTAUTH_SECRET);
  });

  it("危险默认值/placeholder 形态 → 端点保持关闭（404）", async () => {
    process.env.METRICS_BEARER_TOKEN = "changeme-please-replace-this-token";

    const response = await GET(requestWith("changeme-please-replace-this-token"));

    expect(response.status).toBe(404);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("拒绝日志不回显 presented token", async () => {
    process.env.METRICS_BEARER_TOKEN = DEDICATED_TOKEN;

    await GET(requestWith("leak-me-if-you-can"));

    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).not.toContain("leak-me-if-you-can");
  });
});
