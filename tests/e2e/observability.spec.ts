import { expect, test } from "@playwright/test";

/**
 * Phase 4 HTTP observability E2E：
 * request → X-Request-ID 响应 → /api/health 有效 → /api/ready 成功 →
 * 无敏感细节。不要求通过浏览器 UI 展示 metrics。
 */
test.describe("HTTP observability", () => {
  test("normal page request returns X-Request-ID", async ({ request }) => {
    const response = await request.get("/products");

    // 页面请求经 middleware：必带合法 request ID
    const requestId = response.headers()["x-request-id"];
    expect(requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]{7,63}$/);
  });

  test("client-provided valid X-Request-ID is echoed", async ({ request }) => {
    const response = await request.get("/api/health", {
      headers: { "X-Request-ID": "e2e-trace-0001" },
    });

    expect(response.headers()["x-request-id"]).toBe("e2e-trace-0001");
  });

  test("malformed X-Request-ID is rejected and regenerated", async ({ request }) => {
    // 注：HTTP 客户端（含 Playwright）物理上无法发送 CR/LF 头注入；
    // 这里用"合法头值但不符合 ID 白名单格式"的载荷验证服务端重生成
    const response = await request.get("/api/health", {
      headers: { "X-Request-ID": "user@example.com" },
    });

    const requestId = response.headers()["x-request-id"];
    expect(requestId).toMatch(/^[0-9a-f]{32}$/);
  });

  test("/api/health remains valid (liveness + release identity)", async ({ request }) => {
    const response = await request.get("/api/health");

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(typeof body.release).toBe("string");
    expect(typeof body.timestamp).toBe("string");
  });

  test("/api/ready reports readiness with dependency status, no internals", async ({
    request,
  }) => {
    const response = await request.get("/api/ready");

    expect(response.status()).toBe(200);
    const body = await response.json();

    // degraded 允许（Redis 降级仍接流量）；not_ready 不允许出现在健康 E2E 环境
    expect(["ready", "degraded"]).toContain(body.status);
    expect(body.dependencies.database).toBe("ok");
    expect(body.dependencies.storage).toBe("ok");
    expect(typeof body.release).toBe("string");

    // 无敏感细节：高层状态之外不携带异常/连接信息
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/postgres(ql)?:\/\//);
    expect(raw).not.toMatch(/redis:\/\//);
    expect(raw).not.toContain("stack");
    expect(raw).not.toContain("Error");
  });

  test("/api/internal/metrics enforces its bearer token", async ({ request }) => {
    // E2E 环境已配置专用 METRICS_BEARER_TOKEN（安全契约合法）：
    // 无凭据访问 → 403（不是 404：端点已开启但拒绝匿名访问）
    const response = await request.get("/api/internal/metrics");

    expect(response.status()).toBe(403);
  });
});
