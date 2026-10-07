import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

import {
  DomainEventOccurrenceConflictError,
  recordDomainEventTx,
} from "@/lib/domain-events/domain-event";
import {
  ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_AGGREGATE_TYPE,
  ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_SCHEMA_VERSION,
  ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_TYPE,
  validateDomainEventIntent,
} from "@/lib/domain-events/domain-event-registry";

const occurredAt = new Date("2026-10-07T00:00:00.000Z");

function buildTx() {
  return {
    domainEvent: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn(),
    },
  };
}

function asTx(tx: ReturnType<typeof buildTx>): Prisma.TransactionClient {
  return tx as unknown as Prisma.TransactionClient;
}

const validInput = {
  eventType: ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_TYPE,
  schemaVersion: ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_SCHEMA_VERSION,
  aggregateType: ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_AGGREGATE_TYPE,
  aggregateId: "order-1",
  campusId: "campus-1",
  occurredAt,
  payload: { orderId: "order-1", errandTaskId: "errand-1" },
};

describe("Phase 10A DomainEvent registry / write boundary", () => {
  it("DE-REG-01: strict payload accepts IDs only and derives stable occurrence identity", () => {
    expect(
      validateDomainEventIntent(
        validInput.eventType,
        validInput.schemaVersion,
        validInput.aggregateType,
        validInput.aggregateId,
        validInput.payload,
      ),
    ).toEqual({
      ok: true,
      payload: validInput.payload,
      occurrenceKey: "ERRAND_ORDER_COMPLETED:order-1",
    });
  });

  it("DE-REG-02: free-text/unknown payload keys fail closed", () => {
    expect(
      validateDomainEventIntent(
        validInput.eventType,
        validInput.schemaVersion,
        validInput.aggregateType,
        validInput.aggregateId,
        {
          ...validInput.payload,
          note: "用户自由文本不得进入 ledger",
        },
      ),
    ).toEqual({ ok: false, reason: "PAYLOAD_INVALID" });
  });

  it("DE-REG-03: aggregate identity mismatch fails closed", () => {
    expect(
      validateDomainEventIntent(
        validInput.eventType,
        validInput.schemaVersion,
        validInput.aggregateType,
        "other-order",
        validInput.payload,
      ),
    ).toEqual({ ok: false, reason: "AGGREGATE_ID_MISMATCH" });
  });

  it("DE-WRITE-01: canonical row is written once with registry-generated occurrenceKey", async () => {
    const tx = buildTx();

    await expect(recordDomainEventTx(asTx(tx), validInput)).resolves.toEqual({
      recorded: true,
      occurrenceKey: "ERRAND_ORDER_COMPLETED:order-1",
    });

    expect(tx.domainEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          ...validInput,
          actorUserId: null,
          subjectUserId: null,
          occurrenceKey: "ERRAND_ORDER_COMPLETED:order-1",
          sourceType: "DOMAIN_TX",
          sourceId: null,
        },
      ],
      skipDuplicates: true,
    });
    expect(tx.domainEvent.findUnique).not.toHaveBeenCalled();
  });

  it("DE-WRITE-02: identical duplicate is idempotent, not a second fact", async () => {
    const tx = buildTx();
    tx.domainEvent.createMany.mockResolvedValue({ count: 0 });
    tx.domainEvent.findUnique.mockResolvedValue({
      eventType: validInput.eventType,
      schemaVersion: validInput.schemaVersion,
      aggregateType: validInput.aggregateType,
      aggregateId: validInput.aggregateId,
      campusId: validInput.campusId,
      actorUserId: null,
      subjectUserId: null,
      payload: validInput.payload,
      occurredAt,
      sourceType: "DOMAIN_TX",
      sourceId: null,
    });

    await expect(recordDomainEventTx(asTx(tx), validInput)).resolves.toEqual({
      recorded: false,
      occurrenceKey: "ERRAND_ORDER_COMPLETED:order-1",
    });
  });

  it("DE-WRITE-03: same occurrenceKey with conflicting history fails closed", async () => {
    const tx = buildTx();
    tx.domainEvent.createMany.mockResolvedValue({ count: 0 });
    tx.domainEvent.findUnique.mockResolvedValue({
      eventType: validInput.eventType,
      schemaVersion: validInput.schemaVersion,
      aggregateType: validInput.aggregateType,
      aggregateId: validInput.aggregateId,
      campusId: "different-campus",
      actorUserId: null,
      subjectUserId: null,
      payload: validInput.payload,
      occurredAt,
      sourceType: "DOMAIN_TX",
      sourceId: null,
    });

    await expect(recordDomainEventTx(asTx(tx), validInput)).rejects.toBeInstanceOf(
      DomainEventOccurrenceConflictError,
    );
  });

  it("DE-WRITE-04: invalid sourceType fails before touching the database", async () => {
    const tx = buildTx();

    await expect(
      recordDomainEventTx(asTx(tx), {
        ...validInput,
        sourceType: "user supplied text",
      }),
    ).rejects.toMatchObject({ code: "DOMAIN_EVENT_ENVELOPE_INVALID" });
    expect(tx.domainEvent.createMany).not.toHaveBeenCalled();
  });
});
