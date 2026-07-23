-- CreateEnum
CREATE TYPE "RentalPricingUnit" AS ENUM ('PER_DAY', 'PER_WEEK', 'PER_MONTH', 'NEGOTIABLE');

-- CreateEnum
CREATE TYPE "RentalStatus" AS ENUM ('AVAILABLE', 'RENTED', 'PAUSED', 'OFFLINE');

-- CreateTable
CREATE TABLE "RentalCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RentalCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentalListing" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "pricePerUnit" DECIMAL(10,2) NOT NULL,
    "pricingUnit" "RentalPricingUnit" NOT NULL,
    "deposit" DECIMAL(10,2),
    "minRentalDays" INTEGER,
    "maxRentalDays" INTEGER,
    "locationText" TEXT NOT NULL,
    "returnLocation" TEXT NOT NULL,
    "contactNote" TEXT,
    "status" "RentalStatus" NOT NULL DEFAULT 'AVAILABLE',
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "ownerId" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "RentalListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RentalImage" (
    "id" TEXT NOT NULL,
    "rentalListingId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RentalImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RentalCategory_slug_key" ON "RentalCategory"("slug");

-- CreateIndex
CREATE INDEX "RentalListing_campusId_status_createdAt_idx" ON "RentalListing"("campusId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "RentalListing_ownerId_status_idx" ON "RentalListing"("ownerId", "status");

-- CreateIndex
CREATE INDEX "RentalListing_categoryId_status_idx" ON "RentalListing"("categoryId", "status");

-- AddForeignKey
ALTER TABLE "RentalListing" ADD CONSTRAINT "RentalListing_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "RentalCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalListing" ADD CONSTRAINT "RentalListing_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalListing" ADD CONSTRAINT "RentalListing_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalImage" ADD CONSTRAINT "RentalImage_rentalListingId_fkey" FOREIGN KEY ("rentalListingId") REFERENCES "RentalListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
