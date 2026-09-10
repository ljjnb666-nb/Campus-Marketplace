-- Phase 6C-1A: EnforcementAction provenance foundation
--
-- previousState = exact operational state immediately before this action
--   (same snapshot encoding as resultState, e.g. "USER:ACTIVE" /
--   "CAMPUS_MEMBERSHIP:ACTIVE" / "RISK_STATE:NORMAL@CAMPUS:<id>").
--   Existing rows stay NULL: the historical before-state cannot be reliably
--   reconstructed, so NO BACKFILL and no inference from type/resultState.
--   The column deliberately stays nullable (no NOT NULL / no CHECK) so a
--   rollback image can still insert EnforcementAction rows; such rows are
--   classified CAUSALLY_ORDERED but REVERSAL_PROVENANCE_INCOMPLETE.
--
-- enforcementSeq = causal order for the post-migration enforcement epoch.
--   Migration-existing rows receive arbitrary deterministic values 1..N that
--   exist ONLY for uniqueness / epoch classification.
--   DO NOT INTERPRET LEGACY BACKFILL ORDER AS HISTORICAL CAUSAL ORDER.
--
-- createdAt / id remain DISPLAY / WALL-CLOCK AUDIT ONLY — they are never a
-- causal order source.
--
-- MIGRATION_ATOMICITY = EXPLICIT_POSTGRES_TRANSACTION：整个迁移显式包在
-- BEGIN/COMMIT 中，不依赖 Prisma Migrate 的自动事务包装。

BEGIN;

ALTER TABLE "EnforcementAction" ADD COLUMN "previousState" TEXT;

ALTER TABLE "EnforcementAction" ADD COLUMN "enforcementSeq" BIGINT;

-- Legacy epoch backfill: deterministic single-statement CTE in stable id
-- order. Values are arbitrary; their relative order is NON_AUTHORITATIVE.
DO $$
DECLARE
  legacy_row_count BIGINT;
BEGIN
  SELECT count(*) INTO legacy_row_count FROM "EnforcementAction";

  IF legacy_row_count >= 1000000000 THEN
    RAISE EXCEPTION 'ENFORCEMENT_SEQ_LEGACY_EPOCH_OVERFLOW: % existing rows do not fit below the 1000000000 boundary', legacy_row_count;
  END IF;
END $$;

WITH legacy_order AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "id" ASC) AS legacy_seq
  FROM "EnforcementAction"
)
UPDATE "EnforcementAction"
SET "enforcementSeq" = legacy_order.legacy_seq
FROM legacy_order
WHERE "EnforcementAction"."id" = legacy_order."id";

-- Post-migration enforcement epoch sequence: starts at 1_000_000_000
-- (LEGACY_SEQ_BOUNDARY), CACHE 1 so sequence values are granted in strict
-- commit-independent allocation order (no client-side batching gaps that
-- would invert allocation vs commit order under concurrency).
CREATE SEQUENCE "EnforcementAction_enforcementSeq_seq"
  AS BIGINT
  START WITH 1000000000
  INCREMENT BY 1
  CACHE 1;

ALTER SEQUENCE "EnforcementAction_enforcementSeq_seq"
  OWNED BY "EnforcementAction"."enforcementSeq";

ALTER TABLE "EnforcementAction"
  ALTER COLUMN "enforcementSeq"
  SET DEFAULT nextval('"EnforcementAction_enforcementSeq_seq"');

ALTER TABLE "EnforcementAction"
  ALTER COLUMN "enforcementSeq" SET NOT NULL;

CREATE UNIQUE INDEX "EnforcementAction_enforcementSeq_key" ON "EnforcementAction"("enforcementSeq");

COMMIT;
