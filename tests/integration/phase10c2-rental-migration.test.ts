import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const TARGET_MIGRATION = "20261007140000_phase10c2_rental_quantity_accounting";
const TEMP_DB = `p10c2mig_${randomUUID().slice(0, 8)}`;

function swapDatabaseName(databaseUrl: string, name: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${name}`;
  parsed.search = "";
  return parsed.toString();
}

function runPrismaCli(
  args: string[],
  databaseUrl: string,
  input?: string,
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [join("node_modules", "prisma", "build", "index.js"), ...args],
    {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
      input,
    },
  );
}

function executeSql(sql: string, databaseUrl: string): void {
  const result = runPrismaCli(
    ["db", "execute", "--schema", "prisma/schema.prisma", "--stdin"],
    databaseUrl,
    sql,
  );
  if (result.status !== 0) {
    throw new Error(`prisma db execute failed: ${result.stderr}`);
  }
}

function replayPreTargetMigrations(tempUrl: string): void {
  const migrationsDir = join(process.cwd(), "prisma", "migrations");
  const sql = readdirSync(migrationsDir)
    .filter((name) => /^\d{14}_/.test(name) && name < TARGET_MIGRATION)
    .sort()
    .map((name) => readFileSync(join(migrationsDir, name, "migration.sql"), "utf8"))
    .join("\n\n");
  executeSql(sql, tempUrl);
}

function targetMigrationSql(): string {
  return readFileSync(
    join(process.cwd(), "prisma", "migrations", TARGET_MIGRATION, "migration.sql"),
    "utf8",
  );
}

describe.skipIf(!integrationDatabaseUrl)(
  "Phase 10C-2 rental quantity repair migration (real PostgreSQL)",
  () => {
    let tempUrl = "";

    afterAll(() => {
      if (!integrationDatabaseUrl) return;
      const maintenanceUrl = swapDatabaseName(integrationDatabaseUrl, "postgres");
      try {
        executeSql(`DROP DATABASE IF EXISTS "${TEMP_DB}" WITH (FORCE);`, maintenanceUrl);
      } catch {
        // best-effort cleanup only
      }
    });

    it("P10C2-MIG-01: failure rolls back money rewrite; committed repair is raw-replay safe", async () => {
      const maintenanceUrl = swapDatabaseName(integrationDatabaseUrl!, "postgres");
      executeSql(`DROP DATABASE IF EXISTS "${TEMP_DB}";`, maintenanceUrl);
      executeSql(`CREATE DATABASE "${TEMP_DB}";`, maintenanceUrl);
      tempUrl = swapDatabaseName(integrationDatabaseUrl!, TEMP_DB);
      replayPreTargetMigrations(tempUrl);

      const db = new PrismaClient({
        datasources: { db: { url: tempUrl } },
        log: ["error"],
      });
      try {
        const suffix = randomUUID().slice(0, 8);
        const campus = await db.campus.create({
          data: {
            name: "P10C2 migration campus",
            slug: `p10c2-mig-${suffix}`,
            schoolName: "集成测试大学",
          },
        });
        const [owner, renter] = await Promise.all([
          db.user.create({
            data: {
              name: "owner",
              email: `p10c2-mig-owner-${suffix}@it.local`,
              passwordHash: "test-only",
              schoolName: "集成测试大学",
              campusId: campus.id,
            },
          }),
          db.user.create({
            data: {
              name: "renter",
              email: `p10c2-mig-renter-${suffix}@it.local`,
              passwordHash: "test-only",
              schoolName: "集成测试大学",
              campusId: campus.id,
            },
          }),
        ]);
        const category = await db.rentalCategory.create({
          data: { name: `P10C2 mig ${suffix}`, slug: `p10c2-mig-${suffix}` },
        });
        const listing = await db.rentalListing.create({
          data: {
            ownerId: owner.id,
            categoryId: category.id,
            campusId: campus.id,
            title: "migration rental",
            description: "migration fixture",
            condition: "LIKE_NEW",
            price: "15.00",
            pricingUnit: "PER_DAY",
            depositAmount: "50.00",
            minimumDuration: 1,
            maximumDuration: 30,
            totalQuantity: 2,
            availableQuantity: 2,
            pickupLocation: "A",
            returnLocation: "A",
          },
        });
        const order = await db.rentalOrder.create({
          data: {
            orderNumber: `P10C2MIG-${suffix}`,
            rentalListingId: listing.id,
            ownerId: owner.id,
            renterId: renter.id,
            startTime: new Date("2026-10-01T00:00:00Z"),
            endTime: new Date("2026-10-02T00:00:00Z"),
            quantity: 2,
            unitPriceSnapshot: "15.00",
            pricingUnitSnapshot: "PER_DAY",
            rentalDuration: 1,
            rentalAmount: "15.00",
            depositAmount: "50.00",
            finalAmount: "65.00",
            pickupLocationSnapshot: "A",
            returnLocationSnapshot: "A",
          },
        });

        const sql = targetMigrationSql();
        expect(sql).toContain("BEGIN;");
        expect(sql).toContain("COMMIT;");

        const sentinel =
          "RAISE EXCEPTION 'PHASE10C2_TEST_FAILURE_AFTER_VALUE_REWRITE';";
        const failingSql = sql.replace(
          "  EXECUTE 'ALTER TABLE",
          `  ${sentinel}\n\n  EXECUTE 'ALTER TABLE`,
        );
        expect(failingSql).toContain(sentinel);

        const failed = runPrismaCli(
          ["db", "execute", "--schema", "prisma/schema.prisma", "--stdin"],
          tempUrl,
          failingSql,
        );
        expect(failed.status).not.toBe(0);
        expect(`${failed.stderr}\n${failed.stdout}`).toContain(
          "PHASE10C2_TEST_FAILURE_AFTER_VALUE_REWRITE",
        );

        const afterFailure = await db.rentalOrder.findUniqueOrThrow({
          where: { id: order.id },
        });
        expect(afterFailure.rentalAmount.toFixed(2)).toBe("15.00");
        expect(afterFailure.finalAmount.toFixed(2)).toBe("65.00");

        executeSql(sql, tempUrl);
        const afterSuccess = await db.rentalOrder.findUniqueOrThrow({
          where: { id: order.id },
        });
        expect(afterSuccess.rentalAmount.toFixed(2)).toBe("30.00");
        expect(afterSuccess.finalAmount.toFixed(2)).toBe("80.00");

        // Raw SQL replay simulates a commit-but-before-migration-ledger
        // acknowledgement window. Constraint marker must prevent ×quantity twice.
        executeSql(sql, tempUrl);
        const afterReplay = await db.rentalOrder.findUniqueOrThrow({
          where: { id: order.id },
        });
        expect(afterReplay.rentalAmount.toFixed(2)).toBe("30.00");
        expect(afterReplay.finalAmount.toFixed(2)).toBe("80.00");

        const constraintRows = await db.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS count
          FROM pg_constraint
          WHERE conname = 'RentalOrder_quantity_positive_chk'
            AND conrelid = '"RentalOrder"'::regclass
        `;
        expect(constraintRows[0]?.count).toBe(1);
      } finally {
        await db.$disconnect();
      }
    });
  },
);
