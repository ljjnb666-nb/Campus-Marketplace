import {
  LIQUIDITY_DEMAND_CREATED_EVENT_SCHEMA_VERSION,
  LIQUIDITY_DEMAND_CREATED_EVENT_TYPE,
  LIQUIDITY_LISTING_CREATED_EVENT_SCHEMA_VERSION,
  LIQUIDITY_LISTING_CREATED_EVENT_TYPE,
  LIQUIDITY_TRANSACTION_COMPLETED_EVENT_SCHEMA_VERSION,
  LIQUIDITY_TRANSACTION_COMPLETED_EVENT_TYPE,
  LIQUIDITY_TRANSACTION_VALUE_RECORDED_EVENT_SCHEMA_VERSION,
  LIQUIDITY_TRANSACTION_VALUE_RECORDED_EVENT_TYPE,
} from "@/lib/domain-events/domain-event-registry";

export const NEW_LISTING_COUNT_METRIC_KEY = "NEW_LISTING_COUNT";
export const NEW_LISTING_COUNT_METRIC_VERSION = 1;

export const DEMAND_CREATED_COUNT_METRIC_KEY = "DEMAND_CREATED_COUNT";
export const DEMAND_CREATED_COUNT_METRIC_VERSION = 1;

export const COMPLETED_TRANSACTION_COUNT_METRIC_KEY = "COMPLETED_TRANSACTION_COUNT";
// v2：统一 PRODUCT/SERVICE/ERRAND/RENTAL completion fact；v1 仅有 ERRAND。
export const COMPLETED_TRANSACTION_COUNT_METRIC_VERSION = 2;

export const COMPLETED_TRANSACTION_VALUE_METRIC_KEY = "COMPLETED_TRANSACTION_VALUE";
export const COMPLETED_TRANSACTION_VALUE_METRIC_VERSION = 1;

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
    NEW_LISTING_COUNT_METRIC_KEY,
    {
      metricKey: NEW_LISTING_COUNT_METRIC_KEY,
      metricVersion: NEW_LISTING_COUNT_METRIC_VERSION,
      valueType: "COUNT",
      authority: "DOMAIN_EVENT",
      description: "新供给 listing 创建数；按 PRODUCT/SERVICE/RENTAL 维度。",
    },
  ],
  [
    DEMAND_CREATED_COUNT_METRIC_KEY,
    {
      metricKey: DEMAND_CREATED_COUNT_METRIC_KEY,
      metricVersion: DEMAND_CREATED_COUNT_METRIC_VERSION,
      valueType: "COUNT",
      authority: "DOMAIN_EVENT",
      description: "新需求创建数；ERRAND 以任务发布计，其他域以订单/租赁申请创建计。",
    },
  ],
  [
    COMPLETED_TRANSACTION_COUNT_METRIC_KEY,
    {
      metricKey: COMPLETED_TRANSACTION_COUNT_METRIC_KEY,
      metricVersion: COMPLETED_TRANSACTION_COUNT_METRIC_VERSION,
      valueType: "COUNT",
      authority: "DOMAIN_EVENT",
      description: "已完成交易事实计数；不是付款、结算或平台收入。",
    },
  ],
  [
    COMPLETED_TRANSACTION_VALUE_METRIC_KEY,
    {
      metricKey: COMPLETED_TRANSACTION_VALUE_METRIC_KEY,
      metricVersion: COMPLETED_TRANSACTION_VALUE_METRIC_VERSION,
      valueType: "DECIMAL",
      authority: "DOMAIN_EVENT",
      description:
        "CTV：平台记录的已完成交易核心记账金额；不是支付实收、结算、平台收入或 GMV。Rental 仅计 rentalAmount。",
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
    LIQUIDITY_LISTING_CREATED_EVENT_TYPE,
    new Map([
      [
        LIQUIDITY_LISTING_CREATED_EVENT_SCHEMA_VERSION,
        ({ payload }) => [
          {
            metricKey: NEW_LISTING_COUNT_METRIC_KEY,
            metricVersion: NEW_LISTING_COUNT_METRIC_VERSION,
            dimensionKey: `LISTING_TYPE:${String(payload.listingType)}`,
            value: "1",
          },
        ],
      ],
    ]),
  ],
  [
    LIQUIDITY_DEMAND_CREATED_EVENT_TYPE,
    new Map([
      [
        LIQUIDITY_DEMAND_CREATED_EVENT_SCHEMA_VERSION,
        ({ payload }) => [
          {
            metricKey: DEMAND_CREATED_COUNT_METRIC_KEY,
            metricVersion: DEMAND_CREATED_COUNT_METRIC_VERSION,
            dimensionKey: `DEMAND_TYPE:${String(payload.demandType)}`,
            value: "1",
          },
        ],
      ],
    ]),
  ],
  [
    LIQUIDITY_TRANSACTION_COMPLETED_EVENT_TYPE,
    new Map([
      [
        LIQUIDITY_TRANSACTION_COMPLETED_EVENT_SCHEMA_VERSION,
        ({ payload }) => [
          {
            metricKey: COMPLETED_TRANSACTION_COUNT_METRIC_KEY,
            metricVersion: COMPLETED_TRANSACTION_COUNT_METRIC_VERSION,
            dimensionKey: `TRANSACTION_TYPE:${String(payload.transactionType)}`,
            value: "1",
          },
        ],
      ],
    ]),
  ],
  [
    LIQUIDITY_TRANSACTION_VALUE_RECORDED_EVENT_TYPE,
    new Map([
      [
        LIQUIDITY_TRANSACTION_VALUE_RECORDED_EVENT_SCHEMA_VERSION,
        ({ payload }) => [
          {
            metricKey: COMPLETED_TRANSACTION_VALUE_METRIC_KEY,
            metricVersion: COMPLETED_TRANSACTION_VALUE_METRIC_VERSION,
            dimensionKey: `TRANSACTION_TYPE:${String(payload.transactionType)}`,
            value: String(payload.bookedValue),
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
 * 未映射事件返回 []：10C projection v2 故意不再消费旧
 * ERRAND_ORDER_COMPLETED，避免与统一 LIQUIDITY_TRANSACTION_COMPLETED
 * 双计。旧 v1 contribution/receipt 保留作历史版本，不做 destructive cleanup。
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
