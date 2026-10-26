-- Preserve legacy shared evidence without inventing participant attribution.
ALTER TYPE "DepositStatus" ADD VALUE IF NOT EXISTS 'OFFLINE_UNVERIFIED';

ALTER TABLE "RentalHandoverRecord"
  ADD COLUMN "ownerPhotos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "renterPhotos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "ownerCurrentCondition" TEXT,
  ADD COLUMN "renterCurrentCondition" TEXT,
  ADD COLUMN "ownerKnownIssues" TEXT,
  ADD COLUMN "renterKnownIssues" TEXT;

ALTER TABLE "RentalReturnRecord"
  ADD COLUMN "ownerPhotos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "renterPhotos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "renterHasDamage" BOOLEAN,
  ADD COLUMN "renterNeedsCleaning" BOOLEAN,
  ADD COLUMN "renterAccessoriesComplete" BOOLEAN,
  ADD COLUMN "renterInspectionNote" TEXT;

ALTER TABLE "RentalDamageClaim" ADD COLUMN "supersededAt" TIMESTAMP(3);

-- Never fabricate resolvedAt/renterAgreed or discard a prior claim/evidence.
-- Only an inspection episode can have an actionable claim; duplicate episodes
-- retain the oldest request (stable createdAt/id ordering) as the active one.
WITH ranked AS (
  SELECT c."id", o."status", ROW_NUMBER() OVER (
    PARTITION BY c."orderId" ORDER BY c."createdAt", c."id"
  ) AS position
  FROM "RentalDamageClaim" c JOIN "RentalOrder" o ON o."id" = c."orderId"
  WHERE c."resolvedAt" IS NULL
)
UPDATE "RentalDamageClaim" c SET "supersededAt" = CURRENT_TIMESTAMP
FROM ranked r WHERE c."id" = r."id"
  AND (r.position > 1 OR r."status" <> 'PENDING_INSPECTION');

CREATE UNIQUE INDEX "RentalDamageClaim_one_pending_per_order"
  ON "RentalDamageClaim" ("orderId")
  WHERE "resolvedAt" IS NULL AND "supersededAt" IS NULL;
