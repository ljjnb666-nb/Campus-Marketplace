-- CreateTable
CREATE TABLE "ErrandCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErrandCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ErrandCategory_slug_key" ON "ErrandCategory"("slug");

-- Seed default categories for existing and future errands
INSERT INTO "ErrandCategory" ("id", "name", "slug", "description", "sortOrder", "isActive", "createdAt", "updatedAt")
VALUES
  ('errand-cat-pickup-delivery', '代取快递', 'pickup-delivery', NULL, 0, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('errand-cat-takeout', '代拿外卖', 'takeout', NULL, 1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('errand-cat-printing', '代打印', 'printing', NULL, 2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('errand-cat-queue', '代排队', 'queue', NULL, 3, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('errand-cat-purchase', '代买物品', 'purchase', NULL, 4, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('errand-cat-moving', '搬运帮忙', 'moving', NULL, 5, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('errand-cat-delivery', '物品送达', 'delivery', NULL, 6, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('errand-cat-other', '其他校园任务', 'other-errand', NULL, 7, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- AlterTable
ALTER TABLE "ErrandTask" ADD COLUMN "categoryId" TEXT;

-- Backfill existing errands
UPDATE "ErrandTask"
SET "categoryId" = 'errand-cat-other'
WHERE "categoryId" IS NULL;

-- Make the new column required after backfill
ALTER TABLE "ErrandTask" ALTER COLUMN "categoryId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "ErrandTask_categoryId_status_idx" ON "ErrandTask"("categoryId", "status");

-- AddForeignKey
ALTER TABLE "ErrandTask" ADD CONSTRAINT "ErrandTask_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ErrandCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_errandTaskId_fkey" FOREIGN KEY ("errandTaskId") REFERENCES "ErrandTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_serviceListingId_fkey" FOREIGN KEY ("serviceListingId") REFERENCES "ServiceListing"("id") ON DELETE SET NULL ON UPDATE CASCADE;
