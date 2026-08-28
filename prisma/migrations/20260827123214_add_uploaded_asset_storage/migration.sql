-- CreateEnum
CREATE TYPE "AssetAccess" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "AssetCategory" AS ENUM ('AVATAR', 'PRODUCT', 'RENTAL', 'SERVICE', 'VERIFICATION', 'HANDOVER', 'RETURN', 'REPORT');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('UPLOADED', 'ATTACHED', 'PENDING_DELETE', 'DELETED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "storageUsedBytes" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "UploadedAsset" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "category" "AssetCategory" NOT NULL,
    "access" "AssetAccess" NOT NULL,
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "originalFileName" TEXT,
    "status" "AssetStatus" NOT NULL DEFAULT 'UPLOADED',
    "productId" TEXT,
    "rentalListingId" TEXT,
    "serviceListingId" TEXT,
    "rentalOrderId" TEXT,
    "verificationId" TEXT,
    "attachedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UploadedAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UploadedAsset_objectKey_key" ON "UploadedAsset"("objectKey");

-- CreateIndex
CREATE INDEX "UploadedAsset_ownerId_status_idx" ON "UploadedAsset"("ownerId", "status");

-- CreateIndex
CREATE INDEX "UploadedAsset_status_createdAt_idx" ON "UploadedAsset"("status", "createdAt");

-- CreateIndex
CREATE INDEX "UploadedAsset_expiresAt_status_idx" ON "UploadedAsset"("expiresAt", "status");

-- CreateIndex
CREATE INDEX "UploadedAsset_productId_idx" ON "UploadedAsset"("productId");

-- CreateIndex
CREATE INDEX "UploadedAsset_rentalListingId_idx" ON "UploadedAsset"("rentalListingId");

-- CreateIndex
CREATE INDEX "UploadedAsset_serviceListingId_idx" ON "UploadedAsset"("serviceListingId");

-- CreateIndex
CREATE INDEX "UploadedAsset_rentalOrderId_idx" ON "UploadedAsset"("rentalOrderId");

-- AddForeignKey
ALTER TABLE "UploadedAsset" ADD CONSTRAINT "UploadedAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadedAsset" ADD CONSTRAINT "UploadedAsset_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadedAsset" ADD CONSTRAINT "UploadedAsset_rentalListingId_fkey" FOREIGN KEY ("rentalListingId") REFERENCES "RentalListing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadedAsset" ADD CONSTRAINT "UploadedAsset_serviceListingId_fkey" FOREIGN KEY ("serviceListingId") REFERENCES "ServiceListing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadedAsset" ADD CONSTRAINT "UploadedAsset_rentalOrderId_fkey" FOREIGN KEY ("rentalOrderId") REFERENCES "RentalOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadedAsset" ADD CONSTRAINT "UploadedAsset_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "UserVerification"("id") ON DELETE SET NULL ON UPDATE CASCADE;
