-- A confirmation timestamp predates independent evidence and cannot prove the
-- author of legacy shared inspection fields. Only new owner submissions set it.
ALTER TABLE "RentalReturnRecord" ADD COLUMN "ownerInspectionRecordedAt" TIMESTAMP(3);

-- An active dispute can restore PENDING_INSPECTION. Preserve its oldest pending
-- request rather than leaving the restored inspection without its prior claim.
-- No response, agreement or resolvedAt is fabricated; duplicates stay archived.
WITH candidates AS (
  SELECT c."id", ROW_NUMBER() OVER (
    PARTITION BY c."orderId" ORDER BY c."createdAt", c."id"
  ) AS position
  FROM "RentalDamageClaim" c JOIN "RentalOrder" o ON o."id" = c."orderId"
  WHERE c."resolvedAt" IS NULL AND o."status" = 'IN_DISPUTE'
    AND EXISTS (
      SELECT 1 FROM "RentalDispute" d WHERE d."orderId" = o."id"
        AND d."status" IN ('OPEN', 'IN_REVIEW')
        AND d."openedFromOrderStatus" = 'PENDING_INSPECTION'
    )
    AND NOT EXISTS (
      SELECT 1 FROM "RentalDamageClaim" active WHERE active."orderId" = o."id"
        AND active."resolvedAt" IS NULL AND active."supersededAt" IS NULL
    )
)
UPDATE "RentalDamageClaim" c SET "supersededAt" = NULL
FROM candidates eligible WHERE c."id" = eligible."id" AND eligible.position = 1;
