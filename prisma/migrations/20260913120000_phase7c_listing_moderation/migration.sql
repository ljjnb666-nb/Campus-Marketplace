-- Phase 7C: Listing Moderation Operations Surface — governance overlay (OPTION B).
--
-- Hard contract (planning + Repair 1 + Repair 2, frozen):
-- - ADDITIVE ONLY: zero existing enum rename/drop, zero destructive column
--   change, zero backfill fabrication. Listing business status enums are
--   UNCHANGED; governance hiding is carried exclusively by this table.
-- - One takedown = one row; restore resolves the SAME row (resolvedAt /
--   resolvedById). Active row (resolvedAt IS NULL) = hidden. At most ONE
--   active row per listing, enforced by four PostgreSQL partial unique
--   indexes (NOT application-only uniqueness). Resolved history persists and
--   never blocks a future takedown.
-- - type ↔ FK exact-pair consistency is enforced by a DB CHECK (Prisma cannot
--   express it): targetType must name the single non-null target FK and all
--   other target FKs must be NULL. NOT a num_nonnulls shortcut.
-- - All FKs are explicit ON DELETE RESTRICT: governance provenance must not
--   vanish silently when a referent is hard-deleted by future tooling.
--   Current production soft-delete / erasure contracts never trigger it.
-- - DDL is idempotent-safe under migrate deploy (fails loudly on partial
--   application via the explicit transaction below).
-- - ModerationKeyword / dead RentalListingStatus values (PENDING_REVIEW /
--   BANNED) are intentionally NOT touched.
--
-- MIGRATION_ATOMICITY = EXPLICIT_POSTGRES_TRANSACTION.

BEGIN;

-- CreateEnum
CREATE TYPE "ListingModerationTargetType" AS ENUM ('PRODUCT', 'SERVICE', 'ERRAND', 'RENTAL');

-- CreateEnum
CREATE TYPE "ListingModerationReasonCode" AS ENUM ('PROHIBITED_ITEM', 'FRAUD_DECEPTION', 'SPAM_ADVERTISEMENT', 'CONTENT_VIOLATION', 'OTHER');

-- CreateTable
CREATE TABLE "ListingModeration" (
    "id" TEXT NOT NULL,
    "targetType" "ListingModerationTargetType" NOT NULL,
    "productId" TEXT,
    "serviceListingId" TEXT,
    "errandTaskId" TEXT,
    "rentalListingId" TEXT,
    "campusId" TEXT NOT NULL,
    "observedStatus" TEXT NOT NULL,
    "reasonCode" "ListingModerationReasonCode" NOT NULL,
    "note" TEXT,
    "moderatorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "ListingModeration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ListingModeration_campusId_resolvedAt_createdAt_idx" ON "ListingModeration"("campusId", "resolvedAt", "createdAt");

-- CreateIndex
CREATE INDEX "ListingModeration_productId_idx" ON "ListingModeration"("productId");

-- CreateIndex
CREATE INDEX "ListingModeration_serviceListingId_idx" ON "ListingModeration"("serviceListingId");

-- CreateIndex
CREATE INDEX "ListingModeration_errandTaskId_idx" ON "ListingModeration"("errandTaskId");

-- CreateIndex
CREATE INDEX "ListingModeration_rentalListingId_idx" ON "ListingModeration"("rentalListingId");

-- AddForeignKey
ALTER TABLE "ListingModeration" ADD CONSTRAINT "ListingModeration_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingModeration" ADD CONSTRAINT "ListingModeration_serviceListingId_fkey" FOREIGN KEY ("serviceListingId") REFERENCES "ServiceListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingModeration" ADD CONSTRAINT "ListingModeration_errandTaskId_fkey" FOREIGN KEY ("errandTaskId") REFERENCES "ErrandTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingModeration" ADD CONSTRAINT "ListingModeration_rentalListingId_fkey" FOREIGN KEY ("rentalListingId") REFERENCES "RentalListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingModeration" ADD CONSTRAINT "ListingModeration_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingModeration" ADD CONSTRAINT "ListingModeration_moderatorId_fkey" FOREIGN KEY ("moderatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingModeration" ADD CONSTRAINT "ListingModeration_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Phase 7C Repair 1（R3）: type ↔ FK exact-pair consistency CHECK.
-- 逻辑等价于"targetType 命名的那一个 target FK 非空、其余三个为空"——
-- 禁止降级为 num_nonnulls(...) = 1（那允许 type/FK 错配）。
ALTER TABLE "ListingModeration" ADD CONSTRAINT "ListingModeration_target_consistency" CHECK (
    ("targetType" = 'PRODUCT'
        AND "productId" IS NOT NULL
        AND "serviceListingId" IS NULL
        AND "errandTaskId" IS NULL
        AND "rentalListingId" IS NULL)
    OR ("targetType" = 'SERVICE'
        AND "serviceListingId" IS NOT NULL
        AND "productId" IS NULL
        AND "errandTaskId" IS NULL
        AND "rentalListingId" IS NULL)
    OR ("targetType" = 'ERRAND'
        AND "errandTaskId" IS NOT NULL
        AND "productId" IS NULL
        AND "serviceListingId" IS NULL
        AND "rentalListingId" IS NULL)
    OR ("targetType" = 'RENTAL'
        AND "rentalListingId" IS NOT NULL
        AND "productId" IS NULL
        AND "serviceListingId" IS NULL
        AND "errandTaskId" IS NULL)
);

-- Phase 7C Repair 1（R3）: per-target partial unique index——同一 listing
-- 至多一个 active moderation（resolvedAt IS NULL）；已 resolve 的历史行
-- 不占用约束，不阻断未来再次 takedown（先例：PrivacyRequest active
-- deletion partial unique，20260902160220）。
CREATE UNIQUE INDEX "ListingModeration_productId_active_key"
ON "ListingModeration"("productId")
WHERE "resolvedAt" IS NULL;

CREATE UNIQUE INDEX "ListingModeration_serviceListingId_active_key"
ON "ListingModeration"("serviceListingId")
WHERE "resolvedAt" IS NULL;

CREATE UNIQUE INDEX "ListingModeration_errandTaskId_active_key"
ON "ListingModeration"("errandTaskId")
WHERE "resolvedAt" IS NULL;

CREATE UNIQUE INDEX "ListingModeration_rentalListingId_active_key"
ON "ListingModeration"("rentalListingId")
WHERE "resolvedAt" IS NULL;

COMMIT;
