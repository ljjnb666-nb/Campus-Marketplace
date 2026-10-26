import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;

describe.skipIf(!databaseUrl)("rental evidence upgrade (real PostgreSQL SQL)", () => {
  it("preserves unattributed evidence and money, archives duplicates, keeps a restorable dispute claim", async () => {
    const schema = `rental_upgrade_${randomUUID().replaceAll("-", "")}`;
    const raw = new PrismaClient({ datasourceUrl: databaseUrl });
    const execute = (sql: string) => {
      const result = spawnSync(process.execPath,
        [join("node_modules", "prisma", "build", "index.js"), "db", "execute", "--url", databaseUrl!, "--stdin"],
        { input: `SET search_path TO "${schema}";\n${sql}`, encoding: "utf8", env: { ...process.env, DATABASE_URL: databaseUrl } });
      expect(result.status, result.stderr || result.stdout).toBe(0);
    };
    try {
      await raw.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      // These are isolated pre-upgrade table shapes containing only columns
      // touched by the three real migration files; no production data is read.
      execute(`
        CREATE TYPE "DepositStatus" AS ENUM ('NOT_REQUIRED', 'PAID', 'PENDING_REFUND', 'PARTIALLY_REFUNDED');
        CREATE TABLE "RentalOrder" ("id" TEXT PRIMARY KEY, "status" TEXT, "depositAmount" NUMERIC(10,2),
          "depositDeduction" NUMERIC(10,2), "paymentStatus" TEXT, "depositStatus" "DepositStatus");
        CREATE TABLE "RentalHandoverRecord" ("id" TEXT PRIMARY KEY, "photos" TEXT[], "currentCondition" TEXT, "knownIssues" TEXT);
        CREATE TABLE "RentalReturnRecord" ("id" TEXT PRIMARY KEY, "photos" TEXT[], "inspectionNote" TEXT,
          "hasDamage" BOOLEAN, "ownerConfirmedAt" TIMESTAMP(3), "needsCleaning" BOOLEAN, "accessoriesComplete" BOOLEAN);
        CREATE TABLE "RentalDamageClaim" ("id" TEXT PRIMARY KEY, "orderId" TEXT, "createdAt" TIMESTAMP(3),
          "resolvedAt" TIMESTAMP(3), "renterAgreed" BOOLEAN, "damageDescription" TEXT, "photos" TEXT[]);
        CREATE TABLE "RentalDispute" ("orderId" TEXT, "status" TEXT, "openedFromOrderStatus" TEXT);
        INSERT INTO "RentalOrder" VALUES
          ('inspection','PENDING_INSPECTION',50,7,'OFFLINE_PENDING','PENDING_REFUND'),
          ('dispute','IN_DISPUTE',50,7,'UNPAID','PARTIALLY_REFUNDED'),
          ('completed','COMPLETED',50,7,'OFFLINE_PENDING','PAID'),
          ('zero','COMPLETED',0,0,'OFFLINE_PENDING','PAID');
        INSERT INTO "RentalHandoverRecord" VALUES ('handover',ARRAY['asset:legacy'],'legacy condition','legacy issue');
        INSERT INTO "RentalReturnRecord" VALUES ('return',ARRAY['asset:legacy-return'],'unattributed note',true,'2026-10-01',true,false);
        INSERT INTO "RentalDamageClaim" VALUES
          ('inspection-first','inspection','2026-10-01',NULL,NULL,'first',ARRAY['asset:first']),
          ('inspection-second','inspection','2026-10-02',NULL,NULL,'second',ARRAY['asset:second']),
          ('dispute-first','dispute','2026-10-01',NULL,NULL,'first',ARRAY['asset:first']),
          ('dispute-second','dispute','2026-10-02',NULL,NULL,'second',ARRAY['asset:second']),
          ('closed-orphan','completed','2026-10-01',NULL,NULL,'orphan',ARRAY['asset:orphan']),
          ('already-resolved','completed','2026-09-01','2026-09-02',false,'resolved',ARRAY['asset:resolved']);
        INSERT INTO "RentalDispute" VALUES ('dispute','OPEN','PENDING_INSPECTION');
      `);
      for (const migration of ["202610230001_rental_evidence_authority", "202610230002_rental_offline_status", "202610240002_rental_legacy_evidence"]) {
        execute(readFileSync(join("prisma", "migrations", migration, "migration.sql"), "utf8"));
      }
      execute(`INSERT INTO "RentalReturnRecord" ("id", "inspectionNote", "ownerInspectionRecordedAt")
        VALUES ('new-owner', 'attributed owner note', CURRENT_TIMESTAMP);`);
      execute(readFileSync(join("prisma", "migrations", "202610250001_rental_legacy_inspection_snapshot", "migration.sql"), "utf8"));
      const claims = await raw.$queryRawUnsafe<{ id: string; resolvedAt: Date | null; supersededAt: Date | null; renterAgreed: boolean | null; photos: string[] }[]>(
        `SELECT * FROM "${schema}"."RentalDamageClaim" ORDER BY "id"`);
      expect(claims.filter(claim => !claim.resolvedAt && !claim.supersededAt).map(claim => claim.id))
        .toEqual(["dispute-first", "inspection-first"]);
      expect(claims.filter(claim => claim.id !== "already-resolved").every(claim => claim.resolvedAt === null && claim.renterAgreed === null)).toBe(true);
      expect(claims.find(claim => claim.id === "inspection-second")?.photos).toEqual(["asset:second"]);
      expect(claims.find(claim => claim.id === "already-resolved")).toMatchObject({ renterAgreed: false, supersededAt: null, resolvedAt: expect.any(Date) });
      const [handover] = await raw.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "${schema}"."RentalHandoverRecord"`);
      expect(handover).toMatchObject({ photos: ["asset:legacy"], currentCondition: "legacy condition", knownIssues: "legacy issue",
        ownerPhotos: [], renterPhotos: [], ownerCurrentCondition: null, renterCurrentCondition: null });
      const [returned] = await raw.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "${schema}"."RentalReturnRecord" WHERE "id" = 'return'`);
      expect(returned).toMatchObject({ photos: ["asset:legacy-return"], inspectionNote: "unattributed note", hasDamage: true,
        ownerInspectionRecordedAt: null, ownerPhotos: [], renterPhotos: [], renterHasDamage: null,
        legacyInspectionNote: "unattributed note", legacyHasDamage: true, legacyNeedsCleaning: true, legacyAccessoriesComplete: false });
      const [newOwner] = await raw.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "${schema}"."RentalReturnRecord" WHERE "id" = 'new-owner'`);
      expect(newOwner).toMatchObject({ legacyInspectionNote: null, legacyHasDamage: null });
      const money = await raw.$queryRawUnsafe<{ id: string; depositStatus: string; depositDeduction: unknown }[]>(`SELECT * FROM "${schema}"."RentalOrder"`);
      for (const row of money) {
        expect(row.depositStatus).toBe(row.id === "zero" ? "NOT_REQUIRED" : "OFFLINE_UNVERIFIED");
        expect(String(row.depositDeduction)).toBe(row.id === "zero" ? "0" : "7");
      }
      await expect(raw.$executeRawUnsafe(`INSERT INTO "${schema}"."RentalDamageClaim"
        ("id","orderId","createdAt") VALUES ('duplicate','inspection',CURRENT_TIMESTAMP)`)).rejects.toMatchObject({ code: "P2010", meta: { code: "23505" } });
    } finally {
      // Constant-prefix random schema created by this test only.
      if (!/^rental_upgrade_[a-f0-9]{32}$/.test(schema)) throw new Error("unexpected cleanup scope");
      await raw.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await raw.$disconnect();
    }
  }, 60_000);
});
