-- Phase 10K-R2d-03B-01 — append-only UNVERIFIED capture claims.
-- This is NOT a rollout/instance-completeness authority; never authorize
-- public KPI publication from these records. No historical backfill.
CREATE TABLE "FunnelCaptureClaim" (
  "claimKey" VARCHAR(64) NOT NULL,
  "campusId" TEXT NOT NULL,
  "stream" TEXT NOT NULL,
  "instanceId" TEXT NOT NULL,
  "releaseSha" VARCHAR(40) NOT NULL,
  "claimedFrom" TIMESTAMP(3) NOT NULL,
  "claimedUntil" TIMESTAMP(3) NOT NULL,
  "captureEnabled" BOOLEAN NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'UNVERIFIED',
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FunnelCaptureClaim_pkey" PRIMARY KEY ("claimKey"),
  CONSTRAINT "FunnelCaptureClaim_key_check" CHECK ("claimKey" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "FunnelCaptureClaim_campus_check"
    CHECK (char_length("campusId") BETWEEN 1 AND 191),
  CONSTRAINT "FunnelCaptureClaim_stream_check" CHECK (
    "stream" IN (
      'LISTING_CREATED', 'CONVERSATION_CREATED', 'FIRST_REPLY',
      'ORDER_ATTRIBUTION', 'PROJECTION_WORKER'
    )
  ),
  CONSTRAINT "FunnelCaptureClaim_instance_check"
    CHECK ("instanceId" ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  CONSTRAINT "FunnelCaptureClaim_release_check"
    CHECK ("releaseSha" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "FunnelCaptureClaim_interval_check"
    CHECK ("claimedFrom" < "claimedUntil"),
  CONSTRAINT "FunnelCaptureClaim_source_check"
    CHECK ("source" = 'UNVERIFIED')
);

CREATE INDEX "FunnelCaptureClaim_campusId_stream_claimedFrom_claimedUntil_idx"
  ON "FunnelCaptureClaim"("campusId", "stream", "claimedFrom", "claimedUntil");
CREATE INDEX "FunnelCaptureClaim_recordedAt_idx"
  ON "FunnelCaptureClaim"("recordedAt");

-- A normal application transaction cannot rewrite or erase observations.
-- This trigger is DB integrity defense, not tamper-proof against a superuser.
CREATE FUNCTION "reject_funnel_capture_claim_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FUNNEL_CAPTURE_CLAIM_APPEND_ONLY'
    USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "FunnelCaptureClaim_append_only"
BEFORE UPDATE OR DELETE ON "FunnelCaptureClaim"
FOR EACH ROW EXECUTE FUNCTION "reject_funnel_capture_claim_mutation"();
