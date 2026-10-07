import { describe, expect, it } from "vitest";

import {
  COMPLETED_TRANSACTION_COUNT_METRIC_KEY,
  COMPLETED_TRANSACTION_COUNT_METRIC_VERSION,
  getMetricDefinition,
  listMetricDefinitions,
  resolveMetricContributions,
} from "@/lib/analytics/metric-registry";

describe("Phase 10B Metric Registry", () => {
  it("METRIC-REG-01: completed transaction count has explicit versioned DomainEvent authority", () => {
    expect(getMetricDefinition(COMPLETED_TRANSACTION_COUNT_METRIC_KEY)).toEqual({
      metricKey: COMPLETED_TRANSACTION_COUNT_METRIC_KEY,
      metricVersion: COMPLETED_TRANSACTION_COUNT_METRIC_VERSION,
      valueType: "COUNT",
      authority: "DOMAIN_EVENT",
      description: "已完成交易事件计数；不是付款、结算或平台收入。",
    });
    expect(listMetricDefinitions()).toHaveLength(1);
  });

  it("METRIC-REG-02: ERRAND completion emits one event-level contribution, not a time bucket", () => {
    expect(
      resolveMetricContributions({
        eventType: "ERRAND_ORDER_COMPLETED",
        schemaVersion: 1,
        aggregateType: "ORDER",
        aggregateId: "order-1",
        payload: { orderId: "order-1", errandTaskId: "errand-1" },
      }),
    ).toEqual([
      {
        metricKey: COMPLETED_TRANSACTION_COUNT_METRIC_KEY,
        metricVersion: COMPLETED_TRANSACTION_COUNT_METRIC_VERSION,
        dimensionKey: "ORDER_TYPE:ERRAND",
        value: "1",
      },
    ]);
  });

  it("METRIC-REG-03: unmapped DomainEvent is a valid zero-contribution projection", () => {
    expect(
      resolveMetricContributions({
        eventType: "FUTURE_EVENT",
        schemaVersion: 1,
        aggregateType: "FUTURE",
        aggregateId: "a1",
        payload: {},
      }),
    ).toEqual([]);
  });
});
