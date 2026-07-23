import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const sql = `
CREATE TABLE "RentalFavorite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rentalListingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RentalFavorite_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RentalFavorite_rentalListingId_idx" ON "RentalFavorite"("rentalListingId");

CREATE UNIQUE INDEX "RentalFavorite_userId_rentalListingId_key" ON "RentalFavorite"("userId", "rentalListingId");

ALTER TABLE "RentalFavorite" ADD CONSTRAINT "RentalFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RentalFavorite" ADD CONSTRAINT "RentalFavorite_rentalListingId_fkey" FOREIGN KEY ("rentalListingId") REFERENCES "RentalListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
`;

async function main() {
  const statements = sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    try {
      await prisma.$executeRawUnsafe(stmt);
      console.log("✅", stmt.slice(0, 60));
    } catch (e: unknown) {
      if (e instanceof Error && e.message?.includes("already exists")) {
        console.log("⚠️  Already exists, skipping:", stmt.slice(0, 60));
      } else {
        throw e;
      }
    }
  }
  console.log("Migration complete.");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
