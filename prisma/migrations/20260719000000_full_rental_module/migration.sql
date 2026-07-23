-- CreateEnums
CREATE TYPE "RentalListingStatus" AS ENUM ('AVAILABLE', 'PAUSED', 'FULLY_BOOKED', 'OFFLINE', 'PENDING_REVIEW', 'BANNED');
CREATE TYPE "RentalOrderStatus" AS ENUM ('PENDING_APPROVAL', 'PENDING_PAYMENT', 'PENDING_PICKUP', 'PICKED_UP', 'IN_RENTAL', 'PENDING_RETURN', 'PENDING_INSPECTION', 'COMPLETED', 'REJECTED', 'CANCELLED', 'OVERDUE', 'IN_DISPUTE', 'CLOSED');
CREATE TYPE "RentalDisputeStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'RESOLVED', 'CLOSED');
CREATE TYPE "DepositStatus" AS ENUM ('NOT_REQUIRED', 'PENDING_PAYMENT', 'PAID', 'FROZEN', 'PENDING_REFUND', 'FULLY_REFUNDED', 'PARTIALLY_REFUNDED', 'FULLY_DEDUCTED', 'IN_DISPUTE');
CREATE TYPE "RentalCancellationReason" AS ENUM ('RENTER_CHANGED_PLAN', 'OWNER_CANNOT_PROVIDE', 'CANNOT_CONTACT', 'ITEM_DAMAGED', 'TIME_ERROR', 'FAKE_INFO', 'OTHER');
CREATE TYPE "RentalHandoverCondition" AS ENUM ('EXCELLENT', 'GOOD', 'MINOR_SCRATCHES', 'FAIR', 'POOR');
CREATE TYPE "ExtensionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterEnum
BEGIN;
CREATE TYPE "RentalPricingUnit_new" AS ENUM ('PER_HOUR', 'PER_DAY', 'PER_WEEK', 'PER_MONTH', 'PER_SESSION');
ALTER TABLE "RentalListing" ALTER COLUMN "pricingUnit" TYPE "RentalPricingUnit_new" USING ("pricingUnit"::text::"RentalPricingUnit_new");
ALTER TYPE "RentalPricingUnit" RENAME TO "RentalPricingUnit_old";
ALTER TYPE "RentalPricingUnit_new" RENAME TO "RentalPricingUnit";
DROP TYPE "public"."RentalPricingUnit_old";
COMMIT;

-- AlterEnum
ALTER TYPE "ReportTargetType" ADD VALUE 'RENTAL_LISTING';

-- DropForeignKey
ALTER TABLE "RentalImage" DROP CONSTRAINT "RentalImage_rentalListingId_fkey";

-- AlterTable
ALTER TABLE "RentalListing" DROP COLUMN "contactNote",
DROP COLUMN "deposit",
DROP COLUMN "locationText",
DROP COLUMN "maxRentalDays",
DROP COLUMN "minRentalDays",
DROP COLUMN "pricePerUnit",
ADD COLUMN     "availableFrom" TIMESTAMP(3),
ADD COLUMN     "availableQuantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "availableUntil" TIMESTAMP(3),
ADD COLUMN     "brand" TEXT,
ADD COLUMN     "condition" "ProductCondition" NOT NULL,
ADD COLUMN     "damagePolicy" TEXT,
ADD COLUMN     "depositAmount" DECIMAL(10,2) NOT NULL,
ADD COLUMN     "favoriteCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "maximumDuration" INTEGER NOT NULL,
ADD COLUMN     "minimumDuration" INTEGER NOT NULL,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "overduePolicy" TEXT,
ADD COLUMN     "pickupLocation" TEXT NOT NULL,
ADD COLUMN     "price" DECIMAL(10,2) NOT NULL,
ADD COLUMN     "referenceValue" DECIMAL(10,2),
ADD COLUMN     "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "totalQuantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "usageRules" TEXT,
DROP COLUMN "status",
ADD COLUMN     "status" "RentalListingStatus" NOT NULL DEFAULT 'AVAILABLE';

-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "rentalListingId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "onTimeReturnRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "rentalDisputeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rentalOwnerCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rentalPositiveRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "rentalRenterCount" INTEGER NOT NULL DEFAULT 0;

-- DropTable
DROP TABLE "RentalImage";

-- DropEnum
DROP TYPE "RentalStatus";

-- CreateTable
CREATE TABLE "RentalListingImage" (
    "id" TEXT NOT NULL,
    "rentalListingId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RentalListingImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentalUnavailablePeriod" (
    "id" TEXT NOT NULL,
    "rentalListingId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,

    CONSTRAINT "RentalUnavailablePeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentalOrder" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "rentalListingId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "renterId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "actualReturnTime" TIMESTAMP(3),
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPriceSnapshot" DECIMAL(10,2) NOT NULL,
    "pricingUnitSnapshot" "RentalPricingUnit" NOT NULL,
    "rentalDuration" INTEGER NOT NULL,
    "rentalAmount" DECIMAL(10,2) NOT NULL,
    "depositAmount" DECIMAL(10,2) NOT NULL,
    "serviceFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "overdueFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "depositDeduction" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "finalAmount" DECIMAL(10,2) NOT NULL,
    "cancellationFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "depositStatus" "DepositStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "status" "RentalOrderStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "pickupLocationSnapshot" TEXT NOT NULL,
    "returnLocationSnapshot" TEXT NOT NULL,
    "renterNote" TEXT,
    "cancellationReason" "RentalCancellationReason",
    "cancellationNote" TEXT,
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RentalOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentalOrderStatusLog" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fromStatus" "RentalOrderStatus",
    "toStatus" "RentalOrderStatus" NOT NULL,
    "operatorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RentalOrderStatusLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentalHandoverRecord" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "photos" TEXT[],
    "accessories" TEXT,
    "currentCondition" TEXT,
    "knownIssues" TEXT,
    "renterConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "ownerConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "renterConfirmedAt" TIMESTAMP(3),
    "ownerConfirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RentalHandoverRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentalReturnRecord" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "photos" TEXT[],
    "accessoriesComplete" BOOLEAN NOT NULL DEFAULT true,
    "hasDamage" BOOLEAN NOT NULL DEFAULT false,
    "needsCleaning" BOOLEAN NOT NULL DEFAULT false,
    "isOverdue" BOOLEAN NOT NULL DEFAULT false,
    "overdueDuration" INTEGER,
    "inspectionNote" TEXT,
    "renterConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "ownerConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "renterConfirmedAt" TIMESTAMP(3),
    "ownerConfirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RentalReturnRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentalExtensionRequest" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "newEndTime" TIMESTAMP(3) NOT NULL,
    "additionalFee" DECIMAL(10,2) NOT NULL,
    "status" "ExtensionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "ownerNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RentalExtensionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentalDamageClaim" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "submittedById" TEXT NOT NULL,
    "damageDescription" TEXT NOT NULL,
    "photos" TEXT[],
    "requestedDeduction" DECIMAL(10,2) NOT NULL,
    "approvedDeduction" DECIMAL(10,2),
    "renterAgreed" BOOLEAN,
    "renterNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RentalDamageClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentalDispute" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "initiatorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidencePhotos" TEXT[],
    "status" "RentalDisputeStatus" NOT NULL DEFAULT 'OPEN',
    "adminNote" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RentalDispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentalReview" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "itemMatchDesc" INTEGER,
    "itemWorksWell" INTEGER,
    "ownerResponsive" INTEGER,
    "pickupEasy" INTEGER,
    "attitudeFriendly" INTEGER,
    "returnedOnTime" INTEGER,
    "itemWellKept" INTEGER,
    "accessoriesComplete" INTEGER,
    "goodCommunication" INTEGER,
    "reliable" INTEGER,
    "overallRating" INTEGER NOT NULL,
    "content" TEXT,
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RentalReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RentalUnavailablePeriod_rentalListingId_startDate_endDate_idx" ON "RentalUnavailablePeriod"("rentalListingId", "startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "RentalOrder_orderNumber_key" ON "RentalOrder"("orderNumber");

-- CreateIndex
CREATE INDEX "RentalOrder_rentalListingId_status_idx" ON "RentalOrder"("rentalListingId", "status");

-- CreateIndex
CREATE INDEX "RentalOrder_ownerId_status_createdAt_idx" ON "RentalOrder"("ownerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "RentalOrder_renterId_status_createdAt_idx" ON "RentalOrder"("renterId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "RentalOrder_status_startTime_endTime_idx" ON "RentalOrder"("status", "startTime", "endTime");

-- CreateIndex
CREATE INDEX "RentalOrder_rentalListingId_startTime_endTime_idx" ON "RentalOrder"("rentalListingId", "startTime", "endTime");

-- CreateIndex
CREATE INDEX "RentalOrderStatusLog_orderId_createdAt_idx" ON "RentalOrderStatusLog"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RentalHandoverRecord_orderId_key" ON "RentalHandoverRecord"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "RentalReturnRecord_orderId_key" ON "RentalReturnRecord"("orderId");

-- CreateIndex
CREATE INDEX "RentalExtensionRequest_orderId_createdAt_idx" ON "RentalExtensionRequest"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "RentalDamageClaim_orderId_idx" ON "RentalDamageClaim"("orderId");

-- CreateIndex
CREATE INDEX "RentalDispute_orderId_idx" ON "RentalDispute"("orderId");

-- CreateIndex
CREATE INDEX "RentalDispute_status_createdAt_idx" ON "RentalDispute"("status", "createdAt");

-- CreateIndex
CREATE INDEX "RentalReview_targetUserId_createdAt_idx" ON "RentalReview"("targetUserId", "createdAt");

-- CreateIndex
CREATE INDEX "RentalReview_orderId_idx" ON "RentalReview"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "RentalReview_orderId_authorId_key" ON "RentalReview"("orderId", "authorId");

-- CreateIndex
CREATE INDEX "RentalListing_campusId_status_createdAt_idx" ON "RentalListing"("campusId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "RentalListing_ownerId_status_idx" ON "RentalListing"("ownerId", "status");

-- CreateIndex
CREATE INDEX "RentalListing_categoryId_status_idx" ON "RentalListing"("categoryId", "status");

-- CreateIndex
CREATE INDEX "RentalListing_pricingUnit_status_idx" ON "RentalListing"("pricingUnit", "status");

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_rentalListingId_fkey" FOREIGN KEY ("rentalListingId") REFERENCES "RentalListing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalListingImage" ADD CONSTRAINT "RentalListingImage_rentalListingId_fkey" FOREIGN KEY ("rentalListingId") REFERENCES "RentalListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalUnavailablePeriod" ADD CONSTRAINT "RentalUnavailablePeriod_rentalListingId_fkey" FOREIGN KEY ("rentalListingId") REFERENCES "RentalListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalOrder" ADD CONSTRAINT "RentalOrder_rentalListingId_fkey" FOREIGN KEY ("rentalListingId") REFERENCES "RentalListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalOrder" ADD CONSTRAINT "RentalOrder_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalOrder" ADD CONSTRAINT "RentalOrder_renterId_fkey" FOREIGN KEY ("renterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalOrderStatusLog" ADD CONSTRAINT "RentalOrderStatusLog_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "RentalOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalHandoverRecord" ADD CONSTRAINT "RentalHandoverRecord_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "RentalOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalReturnRecord" ADD CONSTRAINT "RentalReturnRecord_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "RentalOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalExtensionRequest" ADD CONSTRAINT "RentalExtensionRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "RentalOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalDamageClaim" ADD CONSTRAINT "RentalDamageClaim_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "RentalOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalDispute" ADD CONSTRAINT "RentalDispute_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "RentalOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalReview" ADD CONSTRAINT "RentalReview_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "RentalOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalReview" ADD CONSTRAINT "RentalReview_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalReview" ADD CONSTRAINT "RentalReview_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

