import { Prisma } from "@prisma/client";

import {
  DomainEventIntentContractError,
  validateDomainEventIntent,
} from "@/lib/domain-events/domain-event-registry";
import { enqueueAsyncJobTx } from "@/lib/async/job-repository";
import {
  ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_KIND,
  ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_SCHEMA_VERSION,
} from "@/lib/async/job-types";
import { buildLiveDomainEventProjectionDedupeKey } from "@/lib/analytics/projection-contract";

const MACHINE_SOURCE_TYPE = /^[A-Z][A-Z0-9_]{0,63}$/;

export type RecordDomainEventInput = {
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  campusId: string;
  actorUserId?: string | null;
  subjectUserId?: string | null;
  payload: unknown;
  occurredAt: Date;
  sourceType?: string;
  sourceId?: string | null;
};

export class DomainEventEnvelopeContractError extends Error {
  readonly code = "DOMAIN_EVENT_ENVELOPE_INVALID";

  constructor(readonly field: string) {
    super(`DOMAIN_EVENT_ENVELOPE_INVALID: ${field}`);
    this.name = "DomainEventEnvelopeContractError";
  }
}

export class DomainEventOccurrenceConflictError extends Error {
  readonly code = "DOMAIN_EVENT_OCCURRENCE_CONFLICT";

  constructor(readonly occurrenceKey: string) {
    super(`DOMAIN_EVENT_OCCURRENCE_CONFLICT: ${occurrenceKey}`);
    this.name = "DomainEventOccurrenceConflictError";
  }
}

export class DomainEventAppendOnlyViolationError extends Error {
  readonly code = "DOMAIN_EVENT_APPEND_ONLY";

  constructor(readonly operation: string) {
    super(`DOMAIN_EVENT_APPEND_ONLY: ${operation}`);
    this.name = "DomainEventAppendOnlyViolationError";
  }
}

const FORBIDDEN_DOMAIN_EVENT_MUTATIONS = new Set([
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
  "upsert",
]);

export function isForbiddenDomainEventMutation(operation: string): boolean {
  return FORBIDDEN_DOMAIN_EVENT_MUTATIONS.has(operation);
}

/**
 * Business Prisma client 的 append-only runtime guard。
 *
 * raw/base PrismaClient 不挂本 extension：迁移/测试 fixture cleanup/未来受控
 * maintenance seam 可显式使用 raw authority；普通业务代码只能 create/read
 * DomainEvent，任何 update/delete/upsert 立即 fail closed。
 */
export const domainEventLedgerExtension = Prisma.defineExtension((client) =>
  client.$extends({
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (model === "DomainEvent" && isForbiddenDomainEventMutation(operation)) {
            throw new DomainEventAppendOnlyViolationError(operation);
          }
          return query(args);
        },
      },
    },
  }),
);

function assertId(value: string | null | undefined, field: string, optional = false): void {
  if (optional && (value === null || value === undefined)) {
    return;
  }
  if (typeof value !== "string" || value.length < 1 || value.length > 191) {
    throw new DomainEventEnvelopeContractError(field);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function validateEnvelope(input: RecordDomainEventInput): {
  sourceType: string;
  actorUserId: string | null;
  subjectUserId: string | null;
  sourceId: string | null;
} {
  assertId(input.aggregateId, "aggregateId");
  assertId(input.campusId, "campusId");
  assertId(input.actorUserId, "actorUserId", true);
  assertId(input.subjectUserId, "subjectUserId", true);
  assertId(input.sourceId, "sourceId", true);

  if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime())) {
    throw new DomainEventEnvelopeContractError("occurredAt");
  }

  const sourceType = input.sourceType ?? "DOMAIN_TX";
  if (!MACHINE_SOURCE_TYPE.test(sourceType)) {
    throw new DomainEventEnvelopeContractError("sourceType");
  }

  return {
    sourceType,
    actorUserId: input.actorUserId ?? null,
    subjectUserId: input.subjectUserId ?? null,
    sourceId: input.sourceId ?? null,
  };
}

/**
 * Phase 10A authoritative ledger write boundary。
 *
 * - 必须在产生该事实的 canonical domain transaction 内调用；
 * - occurrenceKey 由 registry 生成，业务调用方无权自填；
 * - createMany(skipDuplicates) 提供并发 dedupe；
 * - dedupe 命中后必须读取既有行并做完整语义一致性校验，禁止同 key
 *   不同 payload/tenant/time 被静默吞掉。
 *
 * Phase 10B：写入/命中 canonical DomainEvent 后，同事务确保 current-version
 * projection AsyncJob intent 存在；真正 projection effect 的 correctness authority
 * 是 ProjectionReceipt，不是 AsyncJob COMPLETED。
 */
export async function recordDomainEventTx(
  tx: Prisma.TransactionClient,
  input: RecordDomainEventInput,
): Promise<{ recorded: boolean; occurrenceKey: string }> {
  const envelope = validateEnvelope(input);
  const validated = validateDomainEventIntent(
    input.eventType,
    input.schemaVersion,
    input.aggregateType,
    input.aggregateId,
    input.payload,
  );
  if (!validated.ok) {
    throw new DomainEventIntentContractError(
      validated.reason,
      input.eventType,
      input.schemaVersion,
    );
  }

  const canonicalPayload = validated.payload as Prisma.InputJsonObject;
  const row = {
    eventType: input.eventType,
    schemaVersion: input.schemaVersion,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    campusId: input.campusId,
    actorUserId: envelope.actorUserId,
    subjectUserId: envelope.subjectUserId,
    occurrenceKey: validated.occurrenceKey,
    payload: canonicalPayload,
    occurredAt: input.occurredAt,
    sourceType: envelope.sourceType,
    sourceId: envelope.sourceId,
  };

  const inserted = await tx.domainEvent.createMany({
    data: [row],
    skipDuplicates: true,
  });

  // 10B 起即使 first insert 也必须读回 eventId：projection AsyncJob payload
  // 只携带 eventId。读回仍在当前 domain transaction 内，不跨 authority。
  const existing = await tx.domainEvent.findUnique({
    where: { occurrenceKey: validated.occurrenceKey },
    select: {
      id: true,
      eventType: true,
      schemaVersion: true,
      aggregateType: true,
      aggregateId: true,
      campusId: true,
      actorUserId: true,
      subjectUserId: true,
      payload: true,
      occurredAt: true,
      sourceType: true,
      sourceId: true,
    },
  });

  const semanticallyIdentical =
    existing !== null &&
    existing.eventType === row.eventType &&
    existing.schemaVersion === row.schemaVersion &&
    existing.aggregateType === row.aggregateType &&
    existing.aggregateId === row.aggregateId &&
    existing.campusId === row.campusId &&
    existing.actorUserId === row.actorUserId &&
    existing.subjectUserId === row.subjectUserId &&
    existing.occurredAt.getTime() === row.occurredAt.getTime() &&
    existing.sourceType === row.sourceType &&
    existing.sourceId === row.sourceId &&
    stableJson(existing.payload) === stableJson(row.payload);

  if (!semanticallyIdentical || !existing) {
    throw new DomainEventOccurrenceConflictError(validated.occurrenceKey);
  }

  // Phase 10B realtime chain：domain mutation + DomainEvent + projection intent
  // 同事务原子落盘。AsyncJob 只是 future-action intent；projection effect 的
  // exactly-once authority 仍是 ProjectionReceipt。
  await enqueueAsyncJobTx(tx, {
    kind: ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_KIND,
    schemaVersion: ANALYTICS_PROJECT_DOMAIN_EVENT_JOB_SCHEMA_VERSION,
    dedupeKey: buildLiveDomainEventProjectionDedupeKey(existing.id),
    payload: { eventId: existing.id },
    runAt: new Date(),
  });

  return {
    recorded: inserted.count > 0,
    occurrenceKey: validated.occurrenceKey,
  };
}
