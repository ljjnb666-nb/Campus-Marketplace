import { beforeEach, describe, expect, it } from "vitest";

import {
  incrementCounter,
  observeHistogram,
  renderPrometheus,
  resetMetricsForTests,
  routeFamily,
  METRIC_NAMES,
} from "@/lib/metrics";

/**
 * Phase 4 TASK 6：metrics foundation。
 * METRIC_CARDINALITY_TEST：禁止高基数/用户数据 label 进入 registry。
 */
describe("metrics registry", () => {
  beforeEach(() => {
    resetMetricsForTests();
  });

  it("counter 累加并按 label 维度分组渲染 Prometheus 文本", () => {
    incrementCounter(METRIC_NAMES.httpRequests, { route: "/api/products", method: "GET", status_class: "2xx" });
    incrementCounter(METRIC_NAMES.httpRequests, { route: "/api/products", method: "GET", status_class: "2xx" });
    incrementCounter(METRIC_NAMES.httpRequests, { route: "/api/products", method: "GET", status_class: "5xx" });

    const output = renderPrometheus();
    expect(output).toContain("# TYPE http_requests_total counter");
    expect(output).toContain('http_requests_total{method="GET",route="/api/products",status_class="2xx"} 2');
    expect(output).toContain('http_requests_total{method="GET",route="/api/products",status_class="5xx"} 1');
  });

  it("histogram 输出 bucket/sum/count", () => {
    observeHistogram(METRIC_NAMES.httpRequestDuration, { route: "/api/health" }, 7);
    observeHistogram(METRIC_NAMES.httpRequestDuration, { route: "/api/health" }, 3000);

    const output = renderPrometheus();
    expect(output).toContain("# TYPE http_request_duration_ms histogram");
    expect(output).toContain('http_request_duration_ms_bucket{le="10",route="/api/health"} 1');
    expect(output).toContain('http_request_duration_ms_bucket{le="+Inf",route="/api/health"} 2');
    expect(output).toContain('http_request_duration_ms_sum{route="/api/health"} 3007');
  });

  // ---- METRIC_CARDINALITY_TEST ----

  it("拒绝非白名单 label 键（userId/email/orderId 等）", () => {
    expect(() => incrementCounter("m", { userId: "u-1" })).toThrow(/非白名单/);
    expect(() => incrementCounter("m", { email: "a@b.c" })).toThrow(/非白名单/);
    expect(() => incrementCounter("m", { orderId: "o-9" })).toThrow(/非白名单/);
    expect(() => incrementCounter("m", { arbitrary_url: "/api/x" })).toThrow(/非白名单/);
  });

  it("拒绝形态非法的 label 值（空格/引号/超长，防注入与高基数）", () => {
    expect(() => incrementCounter("m", { route: "/api/a b" })).toThrow(/label 值/);
    expect(() => incrementCounter("m", { route: '/api"q' })).toThrow(/label 值/);
    expect(() => incrementCounter("m", { route: "x".repeat(81) })).toThrow(/label 值/);
  });

  it("引号/反斜杠等注入字符在入口即被拒绝（值白名单字符集）", () => {
    expect(() => incrementCounter("m", { route: '/api"q' })).toThrow(/label 值/);
    expect(() => incrementCounter("m", { route: "/api\\evil" })).toThrow(/label 值/);
    expect(() => incrementCounter("m", { route: "/api\nGET /" })).toThrow(/label 值/);
  });

  describe("routeFamily：路径折叠为稳定 route family", () => {
    it("UUID/长 hex/纯数字段折叠为 :id", () => {
      expect(routeFamily("/api/assets/0123456789abcdef0123456789abcdef/content")).toBe(
        "/api/assets/:id/content",
      );
      expect(routeFamily("/api/assets/123e4567-e89b-12d3-a456-426614174000/content")).toBe(
        "/api/assets/:id/content",
      );
      expect(routeFamily("/products/12345")).toBe("/products/:id");
    });

    it("静态段保持原样（低基数）", () => {
      expect(routeFamily("/api/health")).toBe("/api/health");
      expect(routeFamily("/api/ready")).toBe("/api/ready");
      expect(routeFamily("/")).toBe("/");
    });

    it("疑似 ID 的长随机段同样折叠", () => {
      expect(routeFamily("/api/conversations/abcdefghij0123456789abcdefghij01")).toBe(
        "/api/conversations/:id",
      );
    });
  });
});
