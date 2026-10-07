import { z } from "zod";

/**
 * Phase 10A：authoritative DomainEvent registry。
 *
 * DomainEvent 是历史事实 authority，不是 telemetry，也不是 Outbox transport。
 * 每个 eventType/schemaVersion 必须显式注册 strict payload schema、aggregate
 * type、aggregate identity 与 occurrence identity。未知 type/version、未知字段、
 * aggregate 不一致一律 fail closed，禁止猜测写入。
 */

export const ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_TYPE = "ERRAND_ORDER_COMPLETED";
export const ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_SCHEMA_VERSION = 1;
export const ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_AGGREGATE_TYPE = "ORDER";

const boundedId = z.string().min(1).max(191);

const errandOrderCompletedPayloadSchema = z
  .object({
    orderId: boundedId,
    errandTaskId: boundedId,
  })
  .strict();

type DomainEventDefinition = {
  aggregateType: string;
  payloadSchema: z.ZodTypeAny;
  aggregateIdFromPayload: (payload: Record<string, unknown>) => string;
  occurrenceKey: (aggregateId: string, payload: Record<string, unknown>) => string;
};

const DOMAIN_EVENT_DEFINITIONS = new Map<string, Map<number, DomainEventDefinition>>([
  [
    ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_TYPE,
    new Map([
      [
        ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_SCHEMA_VERSION,
        {
          aggregateType: ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_AGGREGATE_TYPE,
          payloadSchema: errandOrderCompletedPayloadSchema,
          aggregateIdFromPayload: (payload) => payload.orderId as string,
          // occurrence identity 刻意不包含 schemaVersion：schema 升级不能把
          // 同一业务事实变成第二次 occurrence。
          occurrenceKey: (aggregateId) =>
            `${ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_TYPE}:${aggregateId}`,
        },
      ],
    ]),
  ],
]);

export type DomainEventIntentFailureReason =
  | "UNKNOWN_EVENT_TYPE"
  | "UNKNOWN_SCHEMA_VERSION"
  | "AGGREGATE_TYPE_MISMATCH"
  | "PAYLOAD_INVALID"
  | "AGGREGATE_ID_MISMATCH";

export type ValidatedDomainEventIntent =
  | {
      ok: true;
      payload: Record<string, unknown>;
      occurrenceKey: string;
    }
  | {
      ok: false;
      reason: DomainEventIntentFailureReason;
    };

export class DomainEventIntentContractError extends Error {
  readonly code = "DOMAIN_EVENT_INTENT_CONTRACT_INVALID";

  constructor(
    readonly reason: DomainEventIntentFailureReason,
    readonly eventType: string,
    readonly schemaVersion: number,
  ) {
    super(
      `DOMAIN_EVENT_INTENT_CONTRACT_INVALID: ${reason} (${eventType}@${schemaVersion})`,
    );
    this.name = "DomainEventIntentContractError";
  }
}

export function validateDomainEventIntent(
  eventType: string,
  schemaVersion: number,
  aggregateType: string,
  aggregateId: string,
  payload: unknown,
): ValidatedDomainEventIntent {
  const versions = DOMAIN_EVENT_DEFINITIONS.get(eventType);
  if (!versions) {
    return { ok: false, reason: "UNKNOWN_EVENT_TYPE" };
  }

  const definition = versions.get(schemaVersion);
  if (!definition) {
    return { ok: false, reason: "UNKNOWN_SCHEMA_VERSION" };
  }

  if (definition.aggregateType !== aggregateType) {
    return { ok: false, reason: "AGGREGATE_TYPE_MISMATCH" };
  }

  const parsed = definition.payloadSchema.safeParse(payload);
  if (!parsed.success || !parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    return { ok: false, reason: "PAYLOAD_INVALID" };
  }

  const canonicalPayload = parsed.data as Record<string, unknown>;
  if (definition.aggregateIdFromPayload(canonicalPayload) !== aggregateId) {
    return { ok: false, reason: "AGGREGATE_ID_MISMATCH" };
  }

  return {
    ok: true,
    payload: canonicalPayload,
    occurrenceKey: definition.occurrenceKey(aggregateId, canonicalPayload),
  };
}
