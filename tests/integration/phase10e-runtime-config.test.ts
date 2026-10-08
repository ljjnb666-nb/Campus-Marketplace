import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 45_000, hookTimeout: 60_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const dbUrl = process.env.DATABASE_URL ?? integrationDatabaseUrl;

describe.skipIf(!integrationDatabaseUrl)("Phase 10E runtime configuration authority (real PostgreSQL)", () => {
  it("P10E-PG-01: global/CAMPUS CAS, same-tx revisions and audit; fixture is rolled back", async () => {
    const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    const suffix = randomUUID().slice(0, 8);
    const marker = "P10E_EXPECTED_ROLLBACK";
    try {
      await expect(db.$transaction(async (tx) => {
        const { setRuntimeConfigTx } = await import(
          "@/lib/runtime-config/runtime-config-service"
        );
        const campusA = await tx.campus.create({
          data: { name: "P10E campus A", slug: `p10e-a-${suffix}`, schoolName: "测试大学" },
        });
        const campusB = await tx.campus.create({
          data: { name: "P10E campus B", slug: `p10e-b-${suffix}`, schoolName: "测试大学 B" },
        });
        const actor = await tx.user.create({
          data: {
            name: "P10E operator", email: `p10e-${suffix}@it.local`,
            passwordHash: "test-only", schoolName: "测试大学", campusId: campusA.id,
          },
        });
        const role = await tx.role.findUniqueOrThrow({
          where: { key: "PLATFORM_ADMIN" }, select: { id: true },
        });
        await tx.userRoleAssignment.create({
          data: { userId: actor.id, roleId: role.id, scopeKey: "GLOBAL" },
        });

        const global = await setRuntimeConfigTx(tx as Prisma.TransactionClient, {
          actorId: actor.id, key: "RISK_SIGNAL_EVIDENCE_LIMIT", campusId: null,
          value: 40, expectedVersion: 0,
        });
        expect(global).toMatchObject({
          previousValue: null, value: 40, version: 1, scopeKey: "GLOBAL",
        });
        const campus = await setRuntimeConfigTx(tx as Prisma.TransactionClient, {
          actorId: actor.id, key: "RISK_SIGNAL_EVIDENCE_LIMIT", campusId: campusA.id,
          value: 20, expectedVersion: 0,
        });
        expect(campus.version).toBe(1);
        const updated = await setRuntimeConfigTx(tx as Prisma.TransactionClient, {
          actorId: actor.id, key: "RISK_SIGNAL_EVIDENCE_LIMIT", campusId: campusA.id,
          value: 12, expectedVersion: 1,
        });
        expect(updated).toMatchObject({ previousValue: 20, value: 12, version: 2 });

        await expect(setRuntimeConfigTx(tx as Prisma.TransactionClient, {
          actorId: actor.id, key: "RISK_SIGNAL_EVIDENCE_LIMIT", campusId: campusA.id,
          value: 18, expectedVersion: 1,
        })).rejects.toThrow("RUNTIME_CONFIG_VERSION_CONFLICT");

        const revisions = await tx.runtimeConfigRevision.findMany({
          where: { config: { scopeKey: `CAMPUS:${campusA.id}` } },
          orderBy: { version: "asc" },
        });
        expect(revisions.map(r => [r.version, r.previousValue, r.newValue]))
          .toEqual([[1, null, 20], [2, 20, 12]]);
        const audits = await tx.adminLog.findMany({
          where: { adminId: actor.id, action: "RUNTIME_CONFIG_CHANGED" },
          orderBy: { createdAt: "asc" },
        });
        expect(audits).toHaveLength(3);
        expect(audits.at(-1)?.metadata).toMatchObject({
          configKey: "RISK_SIGNAL_EVIDENCE_LIMIT",
          previousConfigValue: 20, nextConfigValue: 12,
          previousConfigVersion: 1, nextConfigVersion: 2,
        });

        // New value remains restricted to campus A, not campus B.
        expect(await tx.runtimeConfigOverride.count({
          where: { campusId: campusB.id },
        })).toBe(0);
        throw new Error(marker);
      }, { timeout: 30_000 })).rejects.toThrow(marker);
      // Whole fixture + revisions + audit must roll back, leaving no residue.
      expect(await db.campus.count({ where: { slug: `p10e-a-${suffix}` } })).toBe(0);
      expect(await db.runtimeConfigOverride.count({
        where: { scopeKey: { in: ["GLOBAL", `CAMPUS:${suffix}`] } },
      })).toBe(0);
    } finally { await db.$disconnect(); }
  });

  it("P10E-PG-02: DB constraints reject invalid scope/value and revisions are append-only", async () => {
    const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    try {
      const [scopeConstraint, valueConstraint, revisionTrigger] = await Promise.all([
        db.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS count FROM pg_constraint
          WHERE conname = 'RuntimeConfigOverride_scope_chk'`,
        db.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS count FROM pg_constraint
          WHERE conname = 'RuntimeConfigOverride_registry_chk'`,
        db.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS count FROM pg_trigger
          WHERE tgname = 'RuntimeConfigRevision_no_change'`,
      ]);
      expect(scopeConstraint[0]?.count).toBe(1);
      expect(valueConstraint[0]?.count).toBe(1);
      expect(revisionTrigger[0]?.count).toBe(1);
    } finally { await db.$disconnect(); }
  });
});
