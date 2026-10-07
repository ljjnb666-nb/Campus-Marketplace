-- Phase 10B — Projection & Metric Foundation.
--
-- Correctness authority:
--   DomainEvent = historical domain fact authority
--   ProjectionReceipt(projectionKey,eventId,projectionVersion) = projection effect gate
--   MetricContribution = derived/rebuildable event-level metric projection
--   AsyncJob = delivery/execution intent only (NOT correctness authority)
--
-- No watermark is created. Commit order is not event order and watermark-based
-- correctness can skip older transactions that commit later.

CREATE TABLE "ProjectionReceipt" (
    "id" TEXT NOT NULL,
    "projectionKey" TEXT NOT NULL,
    "projectionVersion" INTEGER NOT NULL,
    "eventId" TEXT NOT NULL,
    "projectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectionReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MetricContribution" (
    "id" TEXT NOT NULL,
    "projectionKey" TEXT NOT NULL,
    "projectionVersion" INTEGER NOT NULL,
    "eventId" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "metricVersion" INTEGER NOT NULL,
    "campusId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "dimensionKey" TEXT NOT NULL,
    "value" DECIMAL(24,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetricContribution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectionReceipt_projectionKey_eventId_projectionVersion_key"
ON "ProjectionReceipt"("projectionKey", "eventId", "projectionVersion");

CREATE INDEX "ProjectionReceipt_eventId_projectionKey_projectionVersion_idx"
ON "ProjectionReceipt"("eventId", "projectionKey", "projectionVersion");

CREATE INDEX "ProjectionReceipt_projectionKey_projectionVersion_projectedAt_idx"
ON "ProjectionReceipt"("projectionKey", "projectionVersion", "projectedAt");

CREATE UNIQUE INDEX "MetricContribution_projectionKey_projectionVersion_eventId_metricKey_metricVersion_dimensionKey_key"
ON "MetricContribution"(
  "projectionKey",
  "projectionVersion",
  "eventId",
  "metricKey",
  "metricVersion",
  "dimensionKey"
);

CREATE INDEX "MetricContribution_metricKey_metricVersion_campusId_occurredAt_idx"
ON "MetricContribution"("metricKey", "metricVersion", "campusId", "occurredAt");

CREATE INDEX "MetricContribution_eventId_projectionKey_projectionVersion_idx"
ON "MetricContribution"("eventId", "projectionKey", "projectionVersion");

ALTER TABLE "ProjectionReceipt"
ADD CONSTRAINT "ProjectionReceipt_eventId_fkey"
FOREIGN KEY ("eventId") REFERENCES "DomainEvent"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MetricContribution"
ADD CONSTRAINT "MetricContribution_eventId_fkey"
FOREIGN KEY ("eventId") REFERENCES "DomainEvent"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
