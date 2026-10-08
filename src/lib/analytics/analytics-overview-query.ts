import { Prisma } from "@prisma/client";

import { getActiveSupplySnapshot } from "@/lib/analytics/liquidity-snapshot";
import {
  COMPLETED_TRANSACTION_COUNT_METRIC_KEY,
  COMPLETED_TRANSACTION_COUNT_METRIC_VERSION,
  COMPLETED_TRANSACTION_VALUE_METRIC_KEY,
  COMPLETED_TRANSACTION_VALUE_METRIC_VERSION,
  DEMAND_CREATED_COUNT_METRIC_KEY,
  DEMAND_CREATED_COUNT_METRIC_VERSION,
  NEW_LISTING_COUNT_METRIC_KEY,
  NEW_LISTING_COUNT_METRIC_VERSION,
} from "@/lib/analytics/metric-registry";
import {
  ANALYTICS_METRIC_PROJECTION_KEY,
  ANALYTICS_METRIC_PROJECTION_VERSION,
} from "@/lib/analytics/projection-contract";
import { canReadAnalyticsCampus, deriveAnalyticsReadAccess } from "@/lib/analytics/analytics-read-access";
import { prisma } from "@/lib/prisma";
import { loadAuthorizationContext } from "@/lib/rbac/service";

export type AnalyticsMetricName = "listing" | "demand" | "completed" | "consideration";
export type AnalyticsMetricRow = {
  name: AnalyticsMetricName;
  metricKey: string;
  metricVersion: number;
  label: string;
  total: string;
  dimensions: { label: string; value: string }[];
};
export type AnalyticsOverview = {
  campusId: string;
  campusName: string;
  from: string;
  until: string;
  periodDays: 7 | 30;
  currentSupply: {
    capturedAt: string;
    product: number;
    service: number;
    rental: number;
    total: number;
  };
  projectionVersion: number;
  metrics: AnalyticsMetricRow[];
};

const METRICS = [
  { name: "listing", metricKey: NEW_LISTING_COUNT_METRIC_KEY, metricVersion: NEW_LISTING_COUNT_METRIC_VERSION, label: "新增供给（条）", prefix: "LISTING_TYPE:" },
  { name: "demand", metricKey: DEMAND_CREATED_COUNT_METRIC_KEY, metricVersion: DEMAND_CREATED_COUNT_METRIC_VERSION, label: "创建需求（条）", prefix: "DEMAND_TYPE:" },
  { name: "completed", metricKey: COMPLETED_TRANSACTION_COUNT_METRIC_KEY, metricVersion: COMPLETED_TRANSACTION_COUNT_METRIC_VERSION, label: "完成交易（笔）", prefix: "TRANSACTION_TYPE:" },
  { name: "consideration", metricKey: COMPLETED_TRANSACTION_VALUE_METRIC_KEY, metricVersion: COMPLETED_TRANSACTION_VALUE_METRIC_VERSION, label: "完成交易记账对价（元）", prefix: "TRANSACTION_TYPE:" },
] as const;

const DIMENSION_LABELS: Record<string, string> = {
  PRODUCT: "二手商品", SERVICE: "技能服务", RENTAL: "物品租赁",
  PRODUCT_ORDER: "商品订单", SERVICE_ORDER: "技能服务订单",
  RENTAL_ORDER: "租赁申请", ERRAND_TASK: "跑腿任务",
  ERRAND: "跑腿交易",
};

function formatDecimal(value: Prisma.Decimal | null | undefined, isMoney: boolean): string {
  const amount = value ?? new Prisma.Decimal(0);
  // No JS float conversion: Decimal(24,6) can exceed Number.MAX_SAFE_INTEGER.
  return isMoney ? amount.toFixed(2) : amount.toFixed(0);
}

/**
 * Read-only overview with independent fresh authority.
 * UI scope lists are discovery, not trust. A direct service call rechecks live
 * user + active membership before any tenant metadata or analytics query.
 *
 * Event metrics use ONLY current projection version and exact metric versions;
 * this avoids double-counting historical projection generations. All query
 * scope predicates run in PostgreSQL; never fetch multi-campus rows then filter.
 *
 * Current supply is a DIFFERENT domain-state authority from event metrics.
 * Neither is an audit trail or transaction/payment/settlement authority.
 */
export async function loadAuthorizedAnalyticsOverview(input: {
  actorId: string;
  campusId: string;
  periodDays: 7 | 30;
  now?: Date;
}): Promise<AnalyticsOverview> {
  if (!input.actorId || !input.campusId || ![7, 30].includes(input.periodDays)) {
    throw new Error("ANALYTICS_SCOPE_OR_PERIOD_INVALID");
  }

  const access = deriveAnalyticsReadAccess(await loadAuthorizationContext(input.actorId));
  if (!canReadAnalyticsCampus(access, input.campusId)) {
    throw new Error("ANALYTICS_SCOPE_DENIED");
  }

  const campus = await prisma.campus.findUnique({
    where: { id: input.campusId },
    select: { id: true, name: true },
  });
  if (!campus) throw new Error("ANALYTICS_CAMPUS_NOT_FOUND");

  const until = input.now ?? new Date();
  const from = new Date(until.getTime() - input.periodDays * 86_400_000);

  const [supply, aggregates] = await Promise.all([
    getActiveSupplySnapshot(campus.id, { now: until }),
    prisma.metricContribution.groupBy({
      by: ["metricKey", "metricVersion", "dimensionKey"],
      where: {
        projectionKey: ANALYTICS_METRIC_PROJECTION_KEY,
        projectionVersion: ANALYTICS_METRIC_PROJECTION_VERSION,
        campusId: campus.id,
        occurredAt: { gte: from, lte: until },
        OR: METRICS.map(metric => ({
          metricKey: metric.metricKey, metricVersion: metric.metricVersion,
        })),
      },
      _sum: { value: true },
    }),
  ]);

  const metrics: AnalyticsMetricRow[] = METRICS.map(definition => {
    const isMoney = definition.name === "consideration";
    const matches = aggregates.filter(row =>
      row.metricKey === definition.metricKey &&
      row.metricVersion === definition.metricVersion &&
      row.dimensionKey.startsWith(definition.prefix),
    );
    const total = matches.reduce(
      (sum, row) => sum.plus(row._sum.value ?? 0),
      new Prisma.Decimal(0),
    );
    return {
      name: definition.name,
      metricKey: definition.metricKey,
      metricVersion: definition.metricVersion,
      label: definition.label,
      total: formatDecimal(total, isMoney),
      dimensions: matches.map(row => ({
        label: DIMENSION_LABELS[row.dimensionKey.slice(definition.prefix.length)]
          ?? row.dimensionKey.slice(definition.prefix.length),
        value: formatDecimal(row._sum.value, isMoney),
      })).sort((left, right) => left.label.localeCompare(right.label, "zh-CN")),
    };
  });

  return {
    campusId: campus.id,
    campusName: campus.name,
    periodDays: input.periodDays,
    from: from.toISOString(),
    until: until.toISOString(),
    currentSupply: {
      capturedAt: supply.capturedAt.toISOString(),
      product: supply.productListings,
      service: supply.serviceListings,
      rental: supply.rentalListings,
      total: supply.totalListings,
    },
    projectionVersion: ANALYTICS_METRIC_PROJECTION_VERSION,
    metrics,
  };
}
