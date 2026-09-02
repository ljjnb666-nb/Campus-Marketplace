import { beforeEach, describe, expect, it } from "vitest";

import { withHttpMetrics } from "@/lib/http-metrics";
import { renderPrometheus, resetMetricsForTests } from "@/lib/metrics";

/**
 * BLOCKER 3B：HTTP 指标 wrapper（Node runtime 计数点）单元语义。
 * 真实接入的黑盒证明见 tests/e2e/http-metrics.spec.ts（production server）。
 */
describe("withHttpMetrics", () => {
  beforeEach(() => {
    resetMetricsForTests();
  });

  function metricValue(name: string, labels: string): number | null {
    const match = renderPrometheus().match(new RegExp(`${name}\\{${labels}\\} (\\d+)`));
    return match ? Number(match[1]) : null;
  }

  it("2xx 响应计入 http_requests_total + histogram，不计 errors", async () => {
    const handler = withHttpMetrics(
      "health",
      async () => new Response("ok", { status: 200 }),
    );

    await handler(new Request("http://localhost/api/health"));

    expect(
      metricValue("http_requests_total", 'method="GET",route="health",status_class="2xx"'),
    ).toBe(1);
    expect(metricValue("http_errors_total", 'method="GET",route="health",status_class="2xx"')).toBeNull();
    expect(
      metricValue("http_request_duration_ms_count", 'route="health"'),
    ).toBe(1);
  });

  it("4xx 响应同时计入 http_errors_total（METRIC error 语义：status>=400）", async () => {
    const handler = withHttpMetrics(
      "assets/:id/content",
      async () => new Response("no", { status: 401 }),
    );

    await handler(new Request("http://localhost/api/assets/x/content"));

    expect(
      metricValue("http_requests_total", 'method="GET",route="assets/:id/content",status_class="4xx"'),
    ).toBe(1);
    expect(
      metricValue("http_errors_total", 'method="GET",route="assets/:id/content",status_class="4xx"'),
    ).toBe(1);
  });

  it("handler 抛出异常 → 按 5xx 计数并原样 rethrow（不吞错）", async () => {
    const handler = withHttpMetrics("upload/images", async () => {
      throw new Error("boom");
    });

    await expect(
      handler(new Request("http://localhost/api/upload/images", { method: "POST" })),
    ).rejects.toThrow("boom");

    expect(
      metricValue("http_requests_total", 'method="POST",route="upload/images",status_class="5xx"'),
    ).toBe(1);
    expect(
      metricValue("http_errors_total", 'method="POST",route="upload/images",status_class="5xx"'),
    ).toBe(1);
  });

  it("拒绝高基数 label：routeFamily 含非法字符直接抛错（防业务 ID 混入）", async () => {
    const handler = withHttpMetrics(
      "assets/has space/content",
      async () => new Response("ok"),
    );

    await expect(handler(new Request("http://localhost/x"))).rejects.toThrow(/label 值/);
  });
});
