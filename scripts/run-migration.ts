import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const prisma = new PrismaClient();

async function main() {
  const sql = readFileSync(
    "prisma/migrations/20260719000000_full_rental_module/migration.sql",
    "utf8",
  );

  // Split on semicolons and execute each statement separately
  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));

  for (const statement of statements) {
    const cleaned = statement.endsWith(";") ? statement : statement + ";";
    try {
      await prisma.$executeRawUnsafe(cleaned);
    } catch (e: unknown) {
      const err = e as { message?: string };
      console.warn(`WARN: ${err?.message?.slice(0, 100)}`);
    }
  }

  console.log("Migration applied successfully.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
