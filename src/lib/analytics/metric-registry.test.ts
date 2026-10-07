import { describe, expect, it } from "vitest";

import {
  COMPLETED_TRANSACTION_COUNT_METRIC_KEY,
  COMPLETED_TRANSACTION_COUNT_METRIC_VERSION,
  COMPLETED_TRANSACTION_VALUE_METRIC_KEY,
  COMPLETED_TRANSACTION_VALUE_METRIC_VERSION,
  DEMAND_CREATED_COUNT_METRIC_KEY,
  DEMAND_CREATED_COUNT_METRIC_VERSION,
  NEW_LISTING_COUNT_METRIC_KEY,
  NEW_LISTING_COUNT_METRIC_VERSION,
  getMetricDefinition,
  listMetricDefinitions,
  resolveMetricContributions,
} from "@/lib/analytics/metric-registry";

describe("Phase 10C Liquidity Metric Registry", () => {
  it("P10C-METRIC-01: safe count + CTV metrics have explicit DomainEvent authority", () => {
    expect(listMetricDefinitions()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metricKey: NEW_LISTING_COUNT_METRIC_KEY,
        metricVersion: NEW_LISTING_COUNT_METRIC_VERSION,
        valueType: "COUNT",
        authority: "DOMAIN_EVENT",
      }),
      expect.objectContaining({
        metricKey: DEMAND_CREATED_COUNT_METRIC_KEY,
        metricVersion: DEMAND_CREATED_COUNT_METRIC_VERSION,
        valueType: "COUNT",
        authority: "DOMAIN_EVENT",
      }),
      expect.objectContaining({
        metricKey: COMPLETED_TRANSACTION_COUNT_METRIC_KEY,
        metricVersion: COMPLETED_TRANSACTION_COUNT_METRIC_VERSION,
        valueType: "COUNT",
        authority: "DOMAIN_EVENT",
      }),
      expect.objectContaining({
        metricKey: COMPLETED_TRANSACTION_VALUE_METRIC_KEY,
        metricVersion: COMPLETED_TRANSACTION_VALUE_METRIC_VERSION,
        valueType: "DECIMAL",
        authority: "DOMAIN_EVENT",
      }),
    ]));
    expect(listMetricDefinitions()).toHaveLength(4);
    expect(getMetricDefinition("GMV")).toBeNull();
    expect(getMetricDefinition(COMPLETED_TRANSACTION_VALUE_METRIC_KEY)).toMatchObject({
      valueType: "DECIMAL",
      authority: "DOMAIN_EVENT",
    });
  });

  it("P10C-METRIC-02: listing/demand/completion facts emit one count each", () => {
    expect(resolveMetricContributions({
      eventType: "LIQUIDITY_LISTING_CREATED",
      schemaVersion: 1,
      aggregateType: "LISTING",
      aggregateId: "p1",
      payload: { listingId: "p1", listingType: "PRODUCT" },
    })).toEqual([{
      metricKey: NEW_LISTING_COUNT_METRIC_KEY,
      metricVersion: NEW_LISTING_COUNT_METRIC_VERSION,
      dimensionKey: "LISTING_TYPE:PRODUCT",
      value: "1",
    }]);

    expect(resolveMetricContributions({
      eventType: "LIQUIDITY_DEMAND_CREATED",
      schemaVersion: 1,
      aggregateType: "DEMAND",
      aggregateId: "e1",
      payload: { demandId: "e1", demandType: "ERRAND_TASK" },
    })).toEqual([{
      metricKey: DEMAND_CREATED_COUNT_METRIC_KEY,
      metricVersion: DEMAND_CREATED_COUNT_METRIC_VERSION,
      dimensionKey: "DEMAND_TYPE:ERRAND_TASK",
      value: "1",
    }]);

    expect(resolveMetricContributions({
      eventType: "LIQUIDITY_TRANSACTION_COMPLETED",
      schemaVersion: 1,
      aggregateType: "TRANSACTION",
      aggregateId: "o1",
      payload: { transactionId: "o1", transactionType: "RENTAL" },
    })).toEqual([{
      metricKey: COMPLETED_TRANSACTION_COUNT_METRIC_KEY,
      metricVersion: COMPLETED_TRANSACTION_COUNT_METRIC_VERSION,
      dimensionKey: "TRANSACTION_TYPE:RENTAL",
      value: "1",
    }]);
  });

  it("P10C2-METRIC-01: value fact emits CTV without pretending to be settlement/GMV", () => {
    expect(resolveMetricContributions({
      eventType: "LIQUIDITY_TRANSACTION_VALUE_RECORDED",
      schemaVersion: 1,
      aggregateType: "TRANSACTION",
      aggregateId: "rental-1",
      payload: {
        transactionId: "rental-1",
        transactionType: "RENTAL",
        bookedValue: "15.00",
      },
    })).toEqual([{
      metricKey: COMPLETED_TRANSACTION_VALUE_METRIC_KEY,
      metricVersion: COMPLETED_TRANSACTION_VALUE_METRIC_VERSION,
      dimensionKey: "TRANSACTION_TYPE:RENTAL",
      value: "15.00",
    }]);
  });

  it("P10C1-METRIC-03: legacy ERRAND completion is zero-contribution under v2", () => {
    expect(resolveMetricContributions({
      eventType: "ERRAND_ORDER_COMPLETED",
      schemaVersion: 1,
      aggregateType: "ORDER",
      aggregateId: "order-1",
      payload: { orderId: "order-1", errandTaskId: "errand-1" },
    })).toEqual([]);
  });
});
