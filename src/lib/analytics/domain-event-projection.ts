import { Prisma } from "@prisma/client";

import { PermanentJobFailure } from "@/lib/async/job-types";
import {
  ANALYTICS_METRIC_PROJECTION_KEY,
  ANALYTICS_METRIC_PROJECTION_VERSION,
} from "@/lib/analytics/projection-contract";
import { resolveMetricContributions } from "@/lib/analytics/metric-registry";
import { validateDomainEventIntent } from "@/lib/domain-events/domain-event-registry";

type ProjectedEffect = {
  metricKey: string;
  metricVersion: number;
  dimensionKey: string;
  campusId: string;
  occurredAt: Date;
  value: string;
};

function normalizeMetricValue(value: string): string {
  try {
    const decimal = new Prisma.Decimal(value);
    if (!decimal.isFinite()) {
      throw new Error("non-finite metric value");
    }
    // Decimal(24,6) persistence may normalize lexical scale ("15.00" -> "15").
    // Projection corruption checks compare numeric value, never presentation scale.
    return decimal.toString();
  } catch {
    throw new PermanentJobFailure(
      "ANALYTICS_PROJECTION_EFFECT_CORRUPT",
      "projection metric value 无法按 Decimal 数值规范化",
    );
  }
}

function effectSignature(effect: ProjectedEffect): string {
  return [
    effect.metricKey,
    effect.metricVersion,
    effect.dimensionKey,
    effect.campusId,
    effect.occurredAt.toISOString(),
    normalizeMetricValue(effect.value),
  ].join("|");
}

async function assertProjectionEffectMatches(
  tx: Prisma.TransactionClient,
  eventId: string,
  expected: ProjectedEffect[],
): Promise<void> {
  const rows = await tx.metricContribution.findMany({
    where: {
      projectionKey: ANALYTICS_METRIC_PROJECTION_KEY,
      projectionVersion: ANALYTICS_METRIC_PROJECTION_VERSION,
      eventId,
    },
    select: {
      metricKey: true,
      metricVersion: true,
      dimensionKey: true,
      campusId: true,
      occurredAt: true,
      value: true,
    },
  });

  const actualSignatures = rows
    .map((row) =>
      effectSignature({
        metricKey: row.metricKey,
        metricVersion: row.metricVersion,
        dimensionKey: row.dimensionKey,
        campusId: row.campusId,
        occurredAt: row.occurredAt,
        value: row.value.toString(),
      }),
    )
    .sort();
  const expectedSignatures = expected.map(effectSignature).sort();

  if (
    actualSignatures.length !== expectedSignatures.length ||
    actualSignatures.some((signature, index) => signature !== expectedSignatures[index])
  ) {
    throw new PermanentJobFailure(
      "ANALYTICS_PROJECTION_EFFECT_CORRUPT",
      `projection effect 与 receipt/registry 不一致：eventId=${eventId}`,
    );
  }
}

/**
 * ProjectionReceipt 与 MetricContribution 在同一 job execution transaction
 * 内提交。receipt 唯一键是 effect gate：worker crash after commit 后 job
 * replay 只能验证并 no-op，绝不会第二次贡献 metric value。
 */
export async function projectDomainEventTx(
  tx: Prisma.TransactionClient,
  eventId: string,
): Promise<{ projected: boolean; contributionCount: number }> {
  const event = await tx.domainEvent.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      eventType: true,
      schemaVersion: true,
      aggregateType: true,
      aggregateId: true,
      campusId: true,
      payload: true,
      occurredAt: true,
    },
  });
  if (!event) {
    throw new PermanentJobFailure(
      "ANALYTICS_DOMAIN_EVENT_NOT_FOUND",
      `DomainEvent 不存在：eventId=${eventId}`,
    );
  }

  const validated = validateDomainEventIntent(
    event.eventType,
    event.schemaVersion,
    event.aggregateType,
    event.aggregateId,
    event.payload,
  );
  if (!validated.ok) {
    throw new PermanentJobFailure(
      "ANALYTICS_DOMAIN_EVENT_CONTRACT_INVALID",
      `DomainEvent contract 非法：eventId=${eventId} reason=${validated.reason}`,
    );
  }

  const specs = resolveMetricContributions({
    eventType: event.eventType,
    schemaVersion: event.schemaVersion,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: validated.payload,
  });
  const expected: ProjectedEffect[] = specs.map((spec) => ({
    metricKey: spec.metricKey,
    metricVersion: spec.metricVersion,
    dimensionKey: spec.dimensionKey,
    campusId: event.campusId,
    occurredAt: event.occurredAt,
    value: spec.value,
  }));

  const receipt = await tx.projectionReceipt.createMany({
    data: [
      {
        projectionKey: ANALYTICS_METRIC_PROJECTION_KEY,
        projectionVersion: ANALYTICS_METRIC_PROJECTION_VERSION,
        eventId,
      },
    ],
    skipDuplicates: true,
  });

  if (receipt.count === 0) {
    await assertProjectionEffectMatches(tx, eventId, expected);
    return { projected: false, contributionCount: expected.length };
  }

  if (expected.length > 0) {
    await tx.metricContribution.createMany({
      data: expected.map((effect) => ({
        projectionKey: ANALYTICS_METRIC_PROJECTION_KEY,
        projectionVersion: ANALYTICS_METRIC_PROJECTION_VERSION,
        eventId,
        metricKey: effect.metricKey,
        metricVersion: effect.metricVersion,
        campusId: effect.campusId,
        occurredAt: effect.occurredAt,
        dimensionKey: effect.dimensionKey,
        value: effect.value,
      })),
      skipDuplicates: true,
    });
  }

  await assertProjectionEffectMatches(tx, eventId, expected);
  return { projected: true, contributionCount: expected.length };
}
