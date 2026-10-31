-- Preserve shared evidence before a previously unconfirmed owner submits a new
-- inspection. Never infer the author from the old confirmation timestamps.
ALTER TABLE "RentalReturnRecord"
  ADD COLUMN "legacyInspectionNote" TEXT,
  ADD COLUMN "legacyHasDamage" BOOLEAN,
  ADD COLUMN "legacyNeedsCleaning" BOOLEAN,
  ADD COLUMN "legacyAccessoriesComplete" BOOLEAN;

UPDATE "RentalReturnRecord"
SET "legacyInspectionNote" = "inspectionNote",
    "legacyHasDamage" = "hasDamage",
    "legacyNeedsCleaning" = "needsCleaning",
    "legacyAccessoriesComplete" = "accessoriesComplete"
WHERE "ownerInspectionRecordedAt" IS NULL;
