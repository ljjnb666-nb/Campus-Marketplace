-- Phase 10K-R2d-03B-02B-02A: immutable UNVERIFIED host lifecycle
-- candidate journal. NO independent host credential, collector or coverage
-- attestation is created by this migration. No historical backfill.
-- Fully atomic migration ensures integrity triggers exist before the table
-- becomes visible to other transactions.
BEGIN;
CREATE TABLE "HostLifecycleClaim" (
  "claimKey" VARCHAR(64) NOT NULL,
  "hostId" VARCHAR(128) NOT NULL,
  "sessionId" VARCHAR(128) NOT NULL,
  "sequence" BIGINT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "instanceId" VARCHAR(128),
  "releaseSha" VARCHAR(40),
  "role" VARCHAR(16),
  "baselineJson" TEXT,
  "source" TEXT NOT NULL DEFAULT 'UNVERIFIED',
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HostLifecycleClaim_pkey" PRIMARY KEY ("claimKey"),
  CONSTRAINT "HostLifecycleClaim_claim_key_check"
    CHECK ("claimKey" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "HostLifecycleClaim_host_id_check"
    CHECK ("hostId" ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  CONSTRAINT "HostLifecycleClaim_session_id_check"
    CHECK ("sessionId" ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  CONSTRAINT "HostLifecycleClaim_sequence_check"
    CHECK ("sequence" >= 1),
  CONSTRAINT "HostLifecycleClaim_observed_check"
    CHECK ("observedAt" >= TIMESTAMP '1970-01-01 00:00:00'),
  CONSTRAINT "HostLifecycleClaim_source_check"
    CHECK ("source" = 'UNVERIFIED'),
  CONSTRAINT "HostLifecycleClaim_kind_payload_check"
    CHECK (
      (
        "kind" = 'BASELINE'
        AND "instanceId" IS NULL AND "releaseSha" IS NULL AND "role" IS NULL
        AND "baselineJson" IS NOT NULL
        AND char_length("baselineJson") BETWEEN 2 AND 32768
        AND jsonb_typeof("baselineJson"::jsonb) = 'array'
        AND jsonb_array_length("baselineJson"::jsonb) <= 128
      ) OR (
        "kind" IN ('START', 'STOP')
        -- PostgreSQL CHECK treats UNKNOWN/NULL as PASS. Explicit IS NOT NULL
        -- is required before applying regex/IN predicates to nullable columns.
        AND "instanceId" IS NOT NULL AND "releaseSha" IS NOT NULL
        AND "role" IS NOT NULL
        AND "instanceId" ~ '^[A-Za-z0-9_.:-]{1,128}
      ) OR (
        "kind" IN ('HEARTBEAT', 'DISCONNECTED')
        AND "instanceId" IS NULL AND "releaseSha" IS NULL
        AND "role" IS NULL AND "baselineJson" IS NULL
      )
    )
);
CREATE UNIQUE INDEX "HostLifecycleClaim_hostId_sessionId_sequence_key"
  ON "HostLifecycleClaim" ("hostId", "sessionId", "sequence");
CREATE INDEX "HostLifecycleClaim_hostId_sessionId_observedAt_idx"
  ON "HostLifecycleClaim" ("hostId", "sessionId", "observedAt");
CREATE INDEX "HostLifecycleClaim_recordedAt_idx"
  ON "HostLifecycleClaim" ("recordedAt");

CREATE FUNCTION "stamp_host_lifecycle_claim_recorded_at"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The application cannot backdate the receipt timestamp.
  NEW."recordedAt" := statement_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER "HostLifecycleClaim_recorded_at_db"
BEFORE INSERT ON "HostLifecycleClaim"
FOR EACH ROW EXECUTE FUNCTION "stamp_host_lifecycle_claim_recorded_at"();

CREATE FUNCTION "reject_host_lifecycle_claim_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HOST_LIFECYCLE_CLAIM_APPEND_ONLY'
    USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "HostLifecycleClaim_append_only"
BEFORE UPDATE OR DELETE ON "HostLifecycleClaim"
FOR EACH ROW EXECUTE FUNCTION "reject_host_lifecycle_claim_mutation"();
-- DELETE triggers do NOT protect TRUNCATE or TRUNCATE CASCADE.
CREATE TRIGGER "HostLifecycleClaim_no_truncate"
BEFORE TRUNCATE ON "HostLifecycleClaim"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_host_lifecycle_claim_mutation"();
COMMIT;

        AND "releaseSha" ~ '^[0-9a-f]{40}
      ) OR (
        "kind" IN ('HEARTBEAT', 'DISCONNECTED')
        AND "instanceId" IS NULL AND "releaseSha" IS NULL
        AND "role" IS NULL AND "baselineJson" IS NULL
      )
    )
);
CREATE UNIQUE INDEX "HostLifecycleClaim_hostId_sessionId_sequence_key"
  ON "HostLifecycleClaim" ("hostId", "sessionId", "sequence");
CREATE INDEX "HostLifecycleClaim_hostId_sessionId_observedAt_idx"
  ON "HostLifecycleClaim" ("hostId", "sessionId", "observedAt");
CREATE INDEX "HostLifecycleClaim_recordedAt_idx"
  ON "HostLifecycleClaim" ("recordedAt");

CREATE FUNCTION "stamp_host_lifecycle_claim_recorded_at"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The application cannot backdate the receipt timestamp.
  NEW."recordedAt" := statement_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER "HostLifecycleClaim_recorded_at_db"
BEFORE INSERT ON "HostLifecycleClaim"
FOR EACH ROW EXECUTE FUNCTION "stamp_host_lifecycle_claim_recorded_at"();

CREATE FUNCTION "reject_host_lifecycle_claim_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HOST_LIFECYCLE_CLAIM_APPEND_ONLY'
    USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "HostLifecycleClaim_append_only"
BEFORE UPDATE OR DELETE ON "HostLifecycleClaim"
FOR EACH ROW EXECUTE FUNCTION "reject_host_lifecycle_claim_mutation"();
-- DELETE triggers do NOT protect TRUNCATE or TRUNCATE CASCADE.
CREATE TRIGGER "HostLifecycleClaim_no_truncate"
BEFORE TRUNCATE ON "HostLifecycleClaim"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_host_lifecycle_claim_mutation"();
COMMIT;

        AND "role" IN ('APP', 'ASYNC_WORKER')
        AND "baselineJson" IS NULL
      ) OR (
        "kind" IN ('HEARTBEAT', 'DISCONNECTED')
        AND "instanceId" IS NULL AND "releaseSha" IS NULL
        AND "role" IS NULL AND "baselineJson" IS NULL
      )
    )
);
CREATE UNIQUE INDEX "HostLifecycleClaim_hostId_sessionId_sequence_key"
  ON "HostLifecycleClaim" ("hostId", "sessionId", "sequence");
CREATE INDEX "HostLifecycleClaim_hostId_sessionId_observedAt_idx"
  ON "HostLifecycleClaim" ("hostId", "sessionId", "observedAt");
CREATE INDEX "HostLifecycleClaim_recordedAt_idx"
  ON "HostLifecycleClaim" ("recordedAt");

CREATE FUNCTION "stamp_host_lifecycle_claim_recorded_at"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The application cannot backdate the receipt timestamp.
  NEW."recordedAt" := statement_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER "HostLifecycleClaim_recorded_at_db"
BEFORE INSERT ON "HostLifecycleClaim"
FOR EACH ROW EXECUTE FUNCTION "stamp_host_lifecycle_claim_recorded_at"();

CREATE FUNCTION "reject_host_lifecycle_claim_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HOST_LIFECYCLE_CLAIM_APPEND_ONLY'
    USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "HostLifecycleClaim_append_only"
BEFORE UPDATE OR DELETE ON "HostLifecycleClaim"
FOR EACH ROW EXECUTE FUNCTION "reject_host_lifecycle_claim_mutation"();
-- DELETE triggers do NOT protect TRUNCATE or TRUNCATE CASCADE.
CREATE TRIGGER "HostLifecycleClaim_no_truncate"
BEFORE TRUNCATE ON "HostLifecycleClaim"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_host_lifecycle_claim_mutation"();
COMMIT;
