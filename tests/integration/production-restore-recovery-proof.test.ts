// @vitest-environment node
// Isolated real PostgreSQL proof of the EXACT credential-invalidation SQL that
// production restore executes before reporting success or restarting writers.
// This is not an offsite backup/restore rehearsal and never touches shared rows.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

const integrationUrl = process.env.INTEGRATION_DATABASE_URL;
const restoreScript = readFileSync(
  path.join(process.cwd(), "scripts/ops/restore-production-postgres.sh"), "utf8",
);

function productionRestoreSecuritySql(): string {
  // Extract rather than copy SQL: a passing test must exercise the same SQL
  // that the production script passes to psql via its SECURITY_SQL heredoc.
  const match = restoreScript.match(/<<'SECURITY_SQL'\r?\n([\s\S]*?)\r?\nSECURITY_SQL(?:\r?\n|$)/);
  if (!match) throw new Error("production restore security SQL was not found");
  const [begin, block, commit] = [
    match[1].includes("BEGIN;"),
    match[1].match(/DO \$recovery_security\$[\s\S]*?\$recovery_security\$;/)?.[0],
    match[1].includes("COMMIT;"),
  ];
  if (!begin || !block || !commit) throw new Error("production restore security transaction is incomplete");
  return block;
}

describe.skipIf(!integrationUrl)("post-restore authentication replay gate (isolated real PostgreSQL)", () => {
  it("revokes every recovered live session and challenge atomically, preserving old revocations and failing closed on broken schema", async () => {
    if (!integrationUrl || process.env.DATABASE_URL !== integrationUrl) {
      throw new Error("recovery proof requires the same explicitly isolated integration database");
    }
    const source = new URL(integrationUrl);
    // Never modify existing fixtures: create an entirely new, disposable DB.
    const name = `campus_recovery_${randomUUID().replace(/-/g, "")}`;
    const isolatedUrl = new URL(integrationUrl);
    isolatedUrl.pathname = `/${name}`;
    isolatedUrl.searchParams.set("schema", "public");
    const admin = new PrismaClient({ datasources: { db: { url: source.toString() } } });
    let probe: PrismaClient | undefined;
    let created = false;
    try {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
      created = true;
      probe = new PrismaClient({ datasources: { db: { url: isolatedUrl.toString() } } });
      await probe.$executeRawUnsafe('CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "passwordHash" TEXT NOT NULL, "credentialRecoveryRequired" BOOLEAN NOT NULL DEFAULT FALSE)');
      await probe.$executeRawUnsafe(`INSERT INTO "User" ("id", "passwordHash") VALUES ('restored-user', 'OLD_PASSWORD_HASH_FROM_T0')`);
      await probe.$executeRawUnsafe('CREATE TABLE "AccountSession" ("id" TEXT PRIMARY KEY, "revokedAt" TIMESTAMP(3))');
      await probe.$executeRawUnsafe('CREATE TABLE "AccountChallenge" ("id" TEXT PRIMARY KEY, "consumedAt" TIMESTAMP(3))');
      await probe.$executeRawUnsafe(
        `INSERT INTO "AccountSession" ("id", "revokedAt") VALUES ('live-session', NULL), ('already-revoked', TIMESTAMP '2026-01-01 00:00:00')`,
      );
      await probe.$executeRawUnsafe(
        `INSERT INTO "AccountChallenge" ("id", "consumedAt") VALUES ('live-link', NULL), ('already-consumed', TIMESTAMP '2026-01-01 00:00:00')`,
      );

      const sql = productionRestoreSecuritySql();
      expect(restoreScript).toContain("fail \"恢复后的登录会话或账号恢复链接未能全部失效");
      await probe.$transaction(async (tx) => { await tx.$executeRawUnsafe(sql); });
      const sessions = await probe.$queryRawUnsafe<Array<{ id: string; revokedAt: Date | null }>>(
        'SELECT "id", "revokedAt" FROM "AccountSession" ORDER BY "id"',
      );
      const challenges = await probe.$queryRawUnsafe<Array<{ id: string; consumedAt: Date | null }>>(
        'SELECT "id", "consumedAt" FROM "AccountChallenge" ORDER BY "id"',
      );
      const credentials = await probe.$queryRawUnsafe<Array<{ passwordHash: string; credentialRecoveryRequired: boolean }>>(
        'SELECT "passwordHash", "credentialRecoveryRequired" FROM "User" WHERE "id" = \'restored-user\'',
      );
      expect(credentials).toEqual([{ passwordHash: "OLD_PASSWORD_HASH_FROM_T0", credentialRecoveryRequired: true }]);
      expect(sessions).toHaveLength(2);
      expect(sessions.every((row) => row.revokedAt instanceof Date)).toBe(true);
      expect(sessions.find((row) => row.id === "already-revoked")?.revokedAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(challenges).toHaveLength(2);
      expect(challenges.every((row) => row.consumedAt instanceof Date)).toBe(true);
      expect(challenges.find((row) => row.id === "already-consumed")?.consumedAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");

      // Idempotence must not resurrect credentials.
      await probe.$transaction(async (tx) => { await tx.$executeRawUnsafe(sql); });
      expect(await probe.$queryRawUnsafe<Array<{ active: bigint }>>(
        'SELECT COUNT(*)::bigint AS active FROM "AccountSession" WHERE "revokedAt" IS NULL',
      )).toEqual([{ active: BigInt(0) }]);

      // Simulate schema damage *after* session UPDATE: challenge UPDATE fails.
      // The entire transaction must roll back, not leave partially revoked state
      // while the caller might be tempted to reopen app traffic.
      await probe.$executeRawUnsafe('UPDATE "User" SET "credentialRecoveryRequired" = FALSE');
      await probe.$executeRawUnsafe(`UPDATE "AccountSession" SET "revokedAt" = NULL WHERE "id" = 'live-session'`);
      await probe.$executeRawUnsafe('ALTER TABLE "AccountChallenge" DROP COLUMN "consumedAt"');
      await expect(probe.$transaction(async (tx) => { await tx.$executeRawUnsafe(sql); })).rejects.toThrow();
      expect(await probe.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "AccountSession" WHERE "id" = 'live-session' AND "revokedAt" IS NULL`,
      )).toHaveLength(1);
      expect(await probe.$queryRawUnsafe<Array<{ credentialRecoveryRequired: boolean }>>(
        'SELECT "credentialRecoveryRequired" FROM "User"',
      )).toEqual([{ credentialRecoveryRequired: false }]);

      // A backup from a pre-AccountSession era cannot establish JWT revocation:
      // failing closed is safer than opening an unverifiable old session state.
      await probe.$executeRawUnsafe('DROP TABLE "AccountSession"');
      await expect(probe.$transaction(async (tx) => { await tx.$executeRawUnsafe(sql); }))
        .rejects.toThrow(/RECOVERY_ACCOUNT_SESSION_SCHEMA_MISSING/);
      // An old backup without the credential-hold column must fail closed.
      await probe.$executeRawUnsafe('CREATE TABLE "AccountSession" ("id" TEXT PRIMARY KEY, "revokedAt" TIMESTAMP(3))');
      await probe.$executeRawUnsafe('ALTER TABLE "User" DROP COLUMN "credentialRecoveryRequired"');
      await expect(probe.$transaction(async (tx) => { await tx.$executeRawUnsafe(sql); }))
        .rejects.toThrow(/RECOVERY_CREDENTIAL_HOLD_SCHEMA_MISSING/);
    } finally {
      if (probe) await probe.$disconnect();
      if (created) await admin.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.$disconnect();
    }
  }, 120_000);
});
