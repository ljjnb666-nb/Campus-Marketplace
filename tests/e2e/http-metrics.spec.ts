import { expect, test } from "@playwright/test";

/**
 * BLOCKER 3B 黑盒证明（HTTP_METRICS_RUNTIME_TEST，最终事实来源）：
 * production build 起真实 server，配置合法专用 METRICS_BEARER_TOKEN；
 * 真实请求 /api/health、/api/ready 后，/api/internal/metrics 输出中
 * http_requests_total / http_request_duration_ms 必须真实增长；
 * 可控 4xx 路径（未登录访问私有资产内容 → 401）后 http_errors_total 增长。
 * 禁止 mock / 手工 incrementCounter —— 一切以 production runtime 输出为准。
 */

// Playwright webServer 环境注入的专用 token（与 config 保持一致）
const METRICS_TOKEN = ["e2e-dedicated-metrics-token-", "qwertyuiopasdfgh"].join("");

function labelValue(metrics: string, metric: string, labels: string): number | null {
  const escaped = labels.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = metrics.match(new RegExp(`${metric}\\{${escaped}\\} (\\d+)`));
  return match ? Number(match[1]) : null;
}

async function fetchMetrics(request: import("@playwright/test").APIRequestContext): Promise<string> {
  const response = await request.get("/api/internal/metrics", {
    headers: { Authorization: `Bearer ${METRICS_TOKEN}` },
  });
  expect(response.status()).toBe(200);
  return response.text();
}

test("HTTP metrics are runtime-fed in the production server", async ({ request }) => {
  // 1. 基线抓取
  const before = await fetchMetrics(request);

  // 2. 真实请求已知 route
  expect((await request.get("/api/health")).status()).toBe(200);
  expect((await request.get("/api/health")).status()).toBe(200);
  expect((await request.get("/api/ready")).status()).toBeLessThan(500);

  // 3. 再次抓取：requests/duration 必须增长（runtime-fed 证明）
  const after = await fetchMetrics(request);

  const healthBefore = labelValue(before, "http_requests_total", 'method="GET",route="health",status_class="2xx"') ?? 0;
  const healthAfter = labelValue(after, "http_requests_total", 'method="GET",route="health",status_class="2xx"') ?? 0;
  expect(healthAfter).toBeGreaterThanOrEqual(healthBefore + 2);

  const readyBefore = labelValue(before, "http_requests_total", 'method="GET",route="ready",status_class="2xx"') ?? 0;
  const readyAfter = labelValue(after, "http_requests_total", 'method="GET",route="ready",status_class="2xx"') ?? 0;
  expect(readyAfter).toBeGreaterThanOrEqual(readyBefore + 1);

  const durBefore = labelValue(before, "http_request_duration_ms_count", 'route="health"') ?? 0;
  const durAfter = labelValue(after, "http_request_duration_ms_count", 'route="health"') ?? 0;
  expect(durAfter).toBeGreaterThanOrEqual(durBefore + 2);

  // 4. 可控 4xx：未登录访问私有资产内容端点 → 401（真实 route handler）
  const errBefore = labelValue(after, "http_errors_total", 'method="GET",route="assets/:id/content",status_class="4xx"') ?? 0;
  const assetResponse = await request.get("/api/assets/00000000-0000-4000-8000-000000000000/content");
  expect(assetResponse.status()).toBe(401);

  // 5. http_errors_total 必须真实增长
  const final = await fetchMetrics(request);
  const errAfter = labelValue(final, "http_errors_total", 'method="GET",route="assets/:id/content",status_class="4xx"') ?? 0;
  expect(errAfter).toBe(errBefore + 1);
});
