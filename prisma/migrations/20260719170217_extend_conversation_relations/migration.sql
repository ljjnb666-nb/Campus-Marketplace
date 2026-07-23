-- AlterEnum
ALTER TYPE "ModerationTargetType" ADD VALUE 'RENTAL';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'RENTAL';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "conversationKey" TEXT,
ADD COLUMN     "orderId" TEXT,
ADD COLUMN     "rentalListingId" TEXT,
ADD COLUMN     "rentalOrderId" TEXT;

-- AlterTable
ALTER TABLE "ErrandTask" ADD COLUMN     "favoriteCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ServiceListing" ADD COLUMN     "favoriteCount" INTEGER NOT NULL DEFAULT 0;

-- DropEnum
DROP TYPE "RentalHandoverCondition";

-- CreateTable
CREATE TABLE "RentalFavorite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rentalListingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RentalFavorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErrandFavorite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "errandTaskId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErrandFavorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceFavorite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serviceListingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceFavorite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_conversationKey_key" ON "Conversation"("conversationKey");

-- CreateIndex
CREATE INDEX "RentalFavorite_rentalListingId_idx" ON "RentalFavorite"("rentalListingId");

-- CreateIndex
CREATE UNIQUE INDEX "RentalFavorite_userId_rentalListingId_key" ON "RentalFavorite"("userId", "rentalListingId");

-- CreateIndex
CREATE INDEX "ErrandFavorite_errandTaskId_idx" ON "ErrandFavorite"("errandTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "ErrandFavorite_userId_errandTaskId_key" ON "ErrandFavorite"("userId", "errandTaskId");

-- CreateIndex
CREATE INDEX "ServiceFavorite_serviceListingId_idx" ON "ServiceFavorite"("serviceListingId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceFavorite_userId_serviceListingId_key" ON "ServiceFavorite"("userId", "serviceListingId");

-- AddForeignKey
ALTER TABLE "RentalFavorite" ADD CONSTRAINT "RentalFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentalFavorite" ADD CONSTRAINT "RentalFavorite_rentalListingId_fkey" FOREIGN KEY ("rentalListingId") REFERENCES "RentalListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErrandFavorite" ADD CONSTRAINT "ErrandFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErrandFavorite" ADD CONSTRAINT "ErrandFavorite_errandTaskId_fkey" FOREIGN KEY ("errandTaskId") REFERENCES "ErrandTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceFavorite" ADD CONSTRAINT "ServiceFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceFavorite" ADD CONSTRAINT "ServiceFavorite_serviceListingId_fkey" FOREIGN KEY ("serviceListingId") REFERENCES "ServiceListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_rentalListingId_fkey" FOREIGN KEY ("rentalListingId") REFERENCES "RentalListing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_rentalOrderId_fkey" FOREIGN KEY ("rentalOrderId") REFERENCES "RentalOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
