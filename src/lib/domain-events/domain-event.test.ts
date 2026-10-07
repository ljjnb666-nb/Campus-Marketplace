import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

import {
  DomainEventAppendOnlyViolationError,
  DomainEventOccurrenceConflictError,
  domainEventLedgerExtension,
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
      findUnique: vi.fn().mockResolvedValue({
        id: "event-1",
        eventType: ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_TYPE,
        schemaVersion: ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_SCHEMA_VERSION,
        aggregateType: ERRAND_ORDER_COMPLETED_DOMAIN_EVENT_AGGREGATE_TYPE,
        aggregateId: "order-1",
        campusId: "campus-1",
        actorUserId: null,
        subjectUserId: null,
        payload: { orderId: "order-1", errandTaskId: "errand-1" },
        occurredAt,
        sourceType: "DOMAIN_TX",
        sourceId: null,
      }),
    },
    asyncJob: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
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

function captureLedgerAllOperations() {
  let handler:
    | ((params: {
        model?: string;
        operation: string;
        args: unknown;
        query: (args: unknown) => unknown;
      }) => unknown)
    | undefined;

  const client = {
    $extends: (config: {
      query: {
        $allModels: {
          $allOperations: typeof handler;
        };
      };
    }) => {
      handler = config.query.$allModels.$allOperations;
      return { extended: true };
    },
  };

  domainEventLedgerExtension(client as never);

  if (!handler) {
    throw new Error("DomainEvent ledger extension 未成功挂载");
  }
  return handler;
}

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
    expect(tx.domainEvent.findUnique).toHaveBeenCalledWith({
      where: { occurrenceKey: "ERRAND_ORDER_COMPLETED:order-1" },
      select: expect.objectContaining({ id: true }),
    });
    expect(tx.asyncJob.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          kind: "ANALYTICS_PROJECT_DOMAIN_EVENT",
          schemaVersion: 1,
          dedupeKey: "ANALYTICS_PROJECT_DOMAIN_EVENT:schema1:projection1:event-1",
          payload: { eventId: "event-1" },
          runAt: expect.any(Date),
        }),
      ],
      skipDuplicates: true,
    });
  });

  it("DE-WRITE-02: identical duplicate is idempotent, not a second fact", async () => {
    const tx = buildTx();
    tx.domainEvent.createMany.mockResolvedValue({ count: 0 });
    tx.domainEvent.findUnique.mockResolvedValue({
      id: "event-1",
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
      id: "event-1",
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
    expect(tx.asyncJob.createMany).not.toHaveBeenCalled();
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
    expect(tx.asyncJob.createMany).not.toHaveBeenCalled();
  });

  it("DE-WRITE-05: projection intent failure propagates so the caller transaction can roll back event + job atomically", async () => {
    const tx = buildTx();
    tx.asyncJob.createMany.mockRejectedValue(new Error("queue unavailable"));

    await expect(recordDomainEventTx(asTx(tx), validInput)).rejects.toThrow("queue unavailable");
    expect(tx.domainEvent.createMany).toHaveBeenCalledTimes(1);
    expect(tx.asyncJob.createMany).toHaveBeenCalledTimes(1);
  });

  it("DE-APPEND-01: business client rejects every DomainEvent mutation but passes reads/creates", () => {
    const handler = captureLedgerAllOperations();
    const query = vi.fn((args: unknown) => args);

    for (const operation of [
      "update",
      "updateMany",
      "updateManyAndReturn",
      "delete",
      "deleteMany",
      "upsert",
    ]) {
      expect(() =>
        handler({ model: "DomainEvent", operation, args: {}, query }),
      ).toThrow(DomainEventAppendOnlyViolationError);
    }
    expect(query).not.toHaveBeenCalled();

    expect(
      handler({
        model: "DomainEvent",
        operation: "findMany",
        args: { where: { campusId: "campus-1" } },
        query,
      }),
    ).toEqual({ where: { campusId: "campus-1" } });
    expect(
      handler({
        model: "DomainEvent",
        operation: "createMany",
        args: { data: [] },
        query,
      }),
    ).toEqual({ data: [] });
  });

  it("DE-APPEND-02: guard does not change mutation semantics for other models", () => {
    const handler = captureLedgerAllOperations();
    const query = vi.fn((args: unknown) => args);

    expect(
      handler({
        model: "Order",
        operation: "update",
        args: { where: { id: "o1" } },
        query,
      }),
    ).toEqual({ where: { id: "o1" } });
  });
});
