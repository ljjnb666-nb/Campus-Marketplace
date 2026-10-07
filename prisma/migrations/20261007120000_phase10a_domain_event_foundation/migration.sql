-- Phase 10A — Authoritative Domain Event Foundation.
--
-- DomainEvent is NOT the Phase 9 OutboxEvent:
--   DomainEvent = durable historical domain fact authority for replay/projection.
--   OutboxEvent = transport runtime for derived side effects and may be tombstoned.
--
-- No historical backfill is performed here. Pre-ledger facts do not all have a
-- trustworthy occurredAt/provenance source; Phase 10B+ backfill must be explicit
-- per metric/domain and must never fabricate missing history.

CREATE TABLE "DomainEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "subjectUserId" TEXT,
    "occurrenceKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceType" TEXT NOT NULL DEFAULT 'DOMAIN_TX',
    "sourceId" TEXT,

    CONSTRAINT "DomainEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DomainEvent_occurrenceKey_key"
ON "DomainEvent"("occurrenceKey");

CREATE INDEX "DomainEvent_eventType_occurredAt_id_idx"
ON "DomainEvent"("eventType", "occurredAt", "id");

CREATE INDEX "DomainEvent_aggregateType_aggregateId_occurredAt_idx"
ON "DomainEvent"("aggregateType", "aggregateId", "occurredAt");

CREATE INDEX "DomainEvent_campusId_occurredAt_id_idx"
ON "DomainEvent"("campusId", "occurredAt", "id");

CREATE INDEX "DomainEvent_recordedAt_id_idx"
ON "DomainEvent"("recordedAt", "id");
