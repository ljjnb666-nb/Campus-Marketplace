import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const dbUrl = process.env.DATABASE_URL ?? integrationDatabaseUrl;

describe.skipIf(!integrationDatabaseUrl)("Phase 10F feature flags (real PostgreSQL)", () => {
  it("P10F-PG-01: scope, CAS, restrictive precedence and revision/audit; fixture rollback", async () => {
    const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    const marker = "P10F_FIXTURE_ROLLBACK";
    const suffix = randomUUID().slice(0, 8);
    try {
      await expect(db.$transaction(async (tx) => {
        const { setFeatureFlagTx } = await import("@/lib/feature-flags/feature-flag-service");
        const { requireNewActivityAllowed } = await import("@/lib/feature-flags/feature-flag-guard");
        const a = await tx.campus.create({data: {
          name: "P10F campus A", schoolName: "大学 A", slug: `p10f-a-${suffix}`,
        }});
        const b = await tx.campus.create({data: {
          name: "P10F campus B", schoolName: "大学 B", slug: `p10f-b-${suffix}`,
        }});
        const actor = await tx.user.create({ data: {
          name: "P10F Operator", email: `p10f-${suffix}@it.local`,
          passwordHash: "test-only", schoolName: "大学 A", campusId: a.id,
        }});
        const role = await tx.role.findUniqueOrThrow({
          where: { key: "PLATFORM_ADMIN" }, select: { id: true },
        });
        await tx.userRoleAssignment.create({data: {
          userId: actor.id, roleId: role.id, scopeKey: "GLOBAL",
        }});

        await requireNewActivityAllowed(tx as Prisma.TransactionClient, {
          kind: "ORDER", campusId: a.id,
        });
        const global = await setFeatureFlagTx(tx as Prisma.TransactionClient, {
          actorId: actor.id, key: "DISABLE_NEW_ORDERS",
          campusId: null, disabled: true, expectedVersion: 0,
        });
        expect(global.version).toBe(1);
        const campus = await setFeatureFlagTx(tx as Prisma.TransactionClient, {
          actorId: actor.id, key: "DISABLE_NEW_ORDERS",
          campusId: a.id, disabled: false, expectedVersion: 0,
        });
        expect(campus.version).toBe(1);
        await expect(requireNewActivityAllowed(tx as Prisma.TransactionClient, {
          kind: "ORDER", campusId: a.id,
        })).rejects.toMatchObject({ code: "NEW_ACTIVITY_DISABLED" });
        await expect(requireNewActivityAllowed(tx as Prisma.TransactionClient, {
          kind: "ORDER", campusId: b.id,
        })).rejects.toMatchObject({ code: "NEW_ACTIVITY_DISABLED" });

        const inherited = await setFeatureFlagTx(tx as Prisma.TransactionClient, {
          actorId: actor.id, key: "DISABLE_NEW_ORDERS",
          campusId: null, disabled: null, expectedVersion: 1,
        });
        expect(inherited.version).toBe(2);
        await requireNewActivityAllowed(tx as Prisma.TransactionClient, {
          kind: "ORDER", campusId: a.id,
        });
        await requireNewActivityAllowed(tx as Prisma.TransactionClient, {
          kind: "ORDER", campusId: b.id,
        });
        await expect(setFeatureFlagTx(tx as Prisma.TransactionClient, {
          actorId: actor.id, key: "DISABLE_NEW_ORDERS",
          campusId: null, disabled: false, expectedVersion: 1,
        })).rejects.toThrow("FEATURE_FLAG_VERSION_CONFLICT");

        const revisions=await tx.featureFlagRevision.findMany({
          where: {flag: { key: "DISABLE_NEW_ORDERS", scopeKey: "GLOBAL" }},
          orderBy: {version: "asc"},
        });
        expect(revisions.map(r=>[r.version,r.previousDisabled,r.nextDisabled]))
          .toEqual([[1,null,true],[2,true,null]]);
        const audits=await tx.adminLog.findMany({
          where: {adminId: actor.id,action:"FEATURE_FLAG_CHANGED"},
        });
        expect(audits).toHaveLength(3);
        throw new Error(marker);
      },{timeout:30_000})).rejects.toThrow(marker);
      expect(await db.campus.count({where: {slug:`p10f-a-${suffix}`}})).toBe(0);
    } finally { await db.$disconnect(); }
  });

  it("P10F-PG-02: schema enforces only registered keys, valid scopes and immutable history", async () => {
    const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    try {
      const [key,scope,trigger]=await Promise.all([
        db.$queryRaw<Array<{n:number}>>`
          SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname='FeatureFlagOverride_key_chk'`,
        db.$queryRaw<Array<{n:number}>>`
          SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname='FeatureFlagOverride_scope_chk'`,
        db.$queryRaw<Array<{n:number}>>`
          SELECT COUNT(*)::int AS n FROM pg_trigger WHERE tgname='FeatureFlagRevision_no_change'`,
      ]);
      expect(key[0]?.n).toBe(1);
      expect(scope[0]?.n).toBe(1);
      expect(trigger[0]?.n).toBe(1);
    } finally {await db.$disconnect();}
  });
});
