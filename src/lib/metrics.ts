/**
 * 轻量 vendor-neutral metrics foundation（TASK 6）。
 *
 * 设计决定：
 * - 进程内 registry + Prometheus 文本渲染协议，不绑定任何付费厂商，
 *   未来可被任意 Prometheus 兼容采集器抓取；
 * - 不引入 prom-client 等依赖：需要的能力（counter/histogram/文本输出）
 *   约百行即可覆盖，且避免 standalone 打包体积与依赖面扩大；
 * - label 白名单化：只允许 route family / method / 状态类 / 依赖名 /
 *   错误类别等低基数稳定值，绝不使用 userId/email/订单号/对象 ID。
 *
 * 暴露入口见 src/app/api/internal/metrics（METRICS_BEARER_TOKEN 访问控制，
 * 未配置时端点整体关闭）。
 */

export type MetricLabels = Record<string, string>;

type CounterSeries = { labels: MetricLabels; value: number };
type HistogramSeries = { labels: MetricLabels; buckets: number[]; counts: number[]; sum: number; count: number };

const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

/** label 键白名单：防止任意高基数维度进入 registry */
const ALLOWED_LABEL_KEYS = new Set([
  "route",
  "method",
  "status_class",
  "dependency",
  "category",
  "outcome",
]);

function sanitizeLabels(labels: MetricLabels): MetricLabels {
  const out: MetricLabels = {};
  for (const [key, value] of Object.entries(labels)) {
    if (!ALLOWED_LABEL_KEYS.has(key)) {
      throw new Error(`metrics: 非白名单 label 键 "${key}"（高基数维度禁止入 registry）`);
    }
    if (!/^[a-z0-9_:/-]{1,80}$/i.test(value)) {
      // label 值也必须是稳定枚举形态；含空格/引号/用户数据的值直接拒绝
      throw new Error(`metrics: label 值形态非法 "${key}"`);
    }
    out[key] = value;
  }
  return out;
}

function labelsKey(labels: MetricLabels): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join("|");
}

const counters = new Map<string, Map<string, CounterSeries>>();
const histograms = new Map<string, Map<string, HistogramSeries>>();

export function incrementCounter(name: string, labels: MetricLabels = {}, value = 1): void {
  const safe = sanitizeLabels(labels);
  let series = counters.get(name);
  if (!series) {
    series = new Map();
    counters.set(name, series);
  }
  const key = labelsKey(safe);
  const existing = series.get(key);
  if (existing) {
    existing.value += value;
  } else {
    series.set(key, { labels: safe, value });
  }
}

export function observeHistogram(name: string, labels: MetricLabels, valueMs: number): void {
  const safe = sanitizeLabels(labels);
  let series = histograms.get(name);
  if (!series) {
    series = new Map();
    histograms.set(name, series);
  }
  const key = labelsKey(safe);
  let existing = series.get(key);
  if (!existing) {
    existing = { labels: safe, buckets: DEFAULT_BUCKETS, counts: DEFAULT_BUCKETS.map(() => 0), sum: 0, count: 0 };
    series.set(key, existing);
  }
  for (let i = 0; i < existing.buckets.length; i += 1) {
    if (valueMs <= existing.buckets[i]) {
      existing.counts[i] += 1;
    }
  }
  existing.sum += valueMs;
  existing.count += 1;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function renderLabels(labels: MetricLabels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((key) => `${key}="${escapeLabelValue(labels[key])}"`);
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
}

/** Prometheus 文本格式（text/plain; version=0.0.4）。 */
export function renderPrometheus(): string {
  const lines: string[] = [];

  for (const [name, series] of counters) {
    lines.push(`# TYPE ${name} counter`);
    for (const { labels, value } of series.values()) {
      lines.push(`${name}${renderLabels(labels)} ${value}`);
    }
  }

  for (const [name, series] of histograms) {
    lines.push(`# TYPE ${name} histogram`);
    for (const item of series.values()) {
      for (let i = 0; i < item.buckets.length; i += 1) {
        lines.push(
          `${name}_bucket${renderLabels({ ...item.labels, le: String(item.buckets[i]) })} ${item.counts[i]}`,
        );
      }
      lines.push(`${name}_bucket${renderLabels({ ...item.labels, le: "+Inf" })} ${item.count}`);
      lines.push(`${name}_sum${renderLabels(item.labels)} ${item.sum}`);
      lines.push(`${name}_count${renderLabels(item.labels)} ${item.count}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** 测试专用：清空 registry。 */
export function resetMetricsForTests(): void {
  counters.clear();
  histograms.clear();
}

// ---------------------------------------------------------------------------
// Route family 归一化：/api/assets/<uuid>/content → /api/assets/:id/content
// 保证指标 label 不携带具体业务 ID（无高基数、无用户数据外泄）。
// ---------------------------------------------------------------------------

const ID_SEGMENT_PATTERN = /^[0-9a-f]{8,64}$|^[0-9a-f-]{36}$|^\d{3,}$/i;

/** 把路径中的具体 ID 段折叠为 :id；无法识别的长随机段同样折叠。 */
export function routeFamily(pathname: string): string {
  const segments = pathname.split("/").map((segment) => {
    if (segment.length === 0 || segment === ":id") {
      return segment;
    }
    if (ID_SEGMENT_PATTERN.test(segment)) {
      return ":id";
    }
    // 含混合字母数字且长度 > 24 的疑似 ID 段也折叠，防漏网
    if (segment.length > 24 && /^[A-Za-z0-9_-]+$/.test(segment)) {
      return ":id";
    }
    return segment;
  });
  return segments.join("/");
}

/** 已注册的标准指标名（docs/OBSERVABILITY.md 契约的单一事实来源）。 */
export const METRIC_NAMES = {
  httpRequests: "http_requests_total",
  httpErrors: "http_errors_total",
  httpRequestDuration: "http_request_duration_ms",
  dependencyReadinessFailures: "dependency_readiness_failures_total",
  unexpectedErrors: "unexpected_server_errors_total",
} as const;
