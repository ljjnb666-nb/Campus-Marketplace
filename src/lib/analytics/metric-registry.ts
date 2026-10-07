import {
  ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_SCHEMA_VERSION,
  ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_TYPE,
} from "@/lib/domain-events/domain-event-registry";

export const COMPLETED_TRANSACTION_COUNT_METRIC_KEY = "COMPLETED_TRANSACTION_COUNT";
export const COMPLETED_TRANSACTION_COUNT_METRIC_VERSION = 1;

export type MetricDefinition = {
  metricKey: string;
  metricVersion: number;
  valueType: "COUNT" | "DECIMAL";
  authority: "DOMAIN_EVENT";
  description: string;
};

export type MetricContributionSpec = {
  metricKey: string;
  metricVersion: number;
  dimensionKey: string;
  value: string;
};

const METRIC_DEFINITIONS = new Map<string, MetricDefinition>([
  [
    COMPLETED_TRANSACTION_COUNT_METRIC_KEY,
    {
      metricKey: COMPLETED_TRANSACTION_COUNT_METRIC_KEY,
      metricVersion: COMPLETED_TRANSACTION_COUNT_METRIC_VERSION,
      valueType: "COUNT",
      authority: "DOMAIN_EVENT",
      description: "已完成交易事件计数；不是付款、结算或平台收入。",
    },
  ],
]);

type EventMetricProjector = (input: {
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}) => MetricContributionSpec[];

const EVENT_METRIC_PROJECTORS = new Map<string, Map<number, EventMetricProjector>>([
  [
    ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_TYPE,
    new Map([
      [
        ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_SCHEMA_VERSION,
        () => [
          {
            metricKey: COMPLETED_TRANSACTION_COUNT_METRIC_KEY,
            metricVersion: COMPLETED_TRANSACTION_COUNT_METRIC_VERSION,
            dimensionKey: "ORDER_TYPE:ERRAND",
            value: "1",
          },
        ],
      ],
    ]),
  ],
]);

export function getMetricDefinition(metricKey: string): MetricDefinition | null {
  return METRIC_DEFINITIONS.get(metricKey) ?? null;
}

export function listMetricDefinitions(): MetricDefinition[] {
  return [...METRIC_DEFINITIONS.values()].map((definition) => ({ ...definition }));
}

/**
 * 未映射事件返回 []，不是错误：DomainEvent ledger 可比 analytics registry
 * 更宽。未来给既有 event 新增 metric projector 时必须提升 projectionVersion
 * 并 replay，禁止同版本静默改变历史 projection 语义。
 */
export function resolveMetricContributions(input: {
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}): MetricContributionSpec[] {
  const projector = EVENT_METRIC_PROJECTORS.get(input.eventType)?.get(input.schemaVersion);
  if (!projector) {
    return [];
  }
  return projector({
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    payload: input.payload,
  });
}
