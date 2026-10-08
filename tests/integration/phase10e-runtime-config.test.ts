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
    let campusIdA = "";
    try {
      await expect(db.$transaction(async (tx) => {
        const { setRuntimeConfigTx } = await import(
          "@/lib/runtime-config/runtime-config-service"
        );
        const campusA = await tx.campus.create({
          data: { name: "P10E campus A", slug: `p10e-a-${suffix}`, schoolName: "测试大学" },
        });
        campusIdA = campusA.id;
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
        const inherited = await setRuntimeConfigTx(tx as Prisma.TransactionClient, {
          actorId: actor.id, key: "RISK_SIGNAL_EVIDENCE_LIMIT", campusId: campusA.id,
          value: null, expectedVersion: 2,
        });
        expect(inherited).toMatchObject({ previousValue: 12, value: null, version: 3 });

        await expect(setRuntimeConfigTx(tx as Prisma.TransactionClient, {
          actorId: actor.id, key: "RISK_SIGNAL_EVIDENCE_LIMIT", campusId: campusA.id,
          value: 18, expectedVersion: 2,
        })).rejects.toThrow("RUNTIME_CONFIG_VERSION_CONFLICT");

        const revisions = await tx.runtimeConfigRevision.findMany({
          where: { config: { scopeKey: `CAMPUS:${campusA.id}` } },
          orderBy: { version: "asc" },
        });
        expect(revisions.map(r => [r.version, r.previousValue, r.newValue]))
          .toEqual([[1, null, 20], [2, 20, 12], [3, 12, null]]);
        const audits = await tx.adminLog.findMany({
          where: { adminId: actor.id, action: "RUNTIME_CONFIG_CHANGED" },
          orderBy: { createdAt: "asc" },
        });
        expect(audits).toHaveLength(4);
        expect(audits.at(-1)?.metadata).toMatchObject({
          configKey: "RISK_SIGNAL_EVIDENCE_LIMIT",
          previousConfigValue: 12, nextConfigValue: null,
          previousConfigVersion: 2, nextConfigVersion: 3,
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
        where: { scopeKey: `CAMPUS:${campusIdA}` },
      })).toBe(0);
    } finally { await db.$disconnect(); }
  });


  it("P10E-PG-03: audit failure rolls back configuration, revision and audit atomically", async () => {
    const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    const suffix = randomUUID().slice(0, 8);
    const { setRuntimeConfig } = await import("@/lib/runtime-config/runtime-config-service");
    const campus = await db.campus.create({
      data: { name: "P10E audit rollback", slug: `p10e-rb-${suffix}`, schoolName: "测试大学" },
    });
    const actor = await db.user.create({
      data: {
        name: "P10E rollback operator", email: `p10e-rb-${suffix}@it.local`,
        passwordHash: "test-only", schoolName: "测试大学", campusId: campus.id,
      },
    });
    try {
      const role = await db.role.findUniqueOrThrow({
        where: { key: "PLATFORM_ADMIN" }, select: { id: true },
      });
      await db.userRoleAssignment.create({
        data: { userId: actor.id, roleId: role.id, scopeKey: "GLOBAL" },
      });
      await expect(setRuntimeConfig({
        actorId: actor.id,
        key: "RISK_SIGNAL_EVIDENCE_LIMIT",
        campusId: campus.id,
        value: 15,
        expectedVersion: 0,
        seams: {
          beforeAudit: async () => { throw new Error("P10E_INJECTED_AUDIT_FAILURE"); },
        },
      })).rejects.toThrow("P10E_INJECTED_AUDIT_FAILURE");

      expect(await db.runtimeConfigOverride.count({
        where: { scopeKey: `CAMPUS:${campus.id}` },
      })).toBe(0);
      expect(await db.runtimeConfigRevision.count({
        where: { config: { scopeKey: `CAMPUS:${campus.id}` } },
      })).toBe(0);
      expect(await db.adminLog.count({
        where: { adminId: actor.id, action: "RUNTIME_CONFIG_CHANGED" },
      })).toBe(0);
    } finally {
      await db.userRoleAssignment.deleteMany({ where: { userId: actor.id } });
      await db.user.delete({ where: { id: actor.id } });
      await db.campus.delete({ where: { id: campus.id } });
      await db.$disconnect();
    }
  });

  it("P10E-PG-04: campus-only permission never escalates to GLOBAL/another campus", async () => {
    const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    const suffix = randomUUID().slice(0, 8);
    const { setRuntimeConfig } = await import("@/lib/runtime-config/runtime-config-service");
    const a = await db.campus.create({
      data: { name: "P10E scope A", slug: `p10e-scope-a-${suffix}`, schoolName: "A大学" },
    });
    const b = await db.campus.create({
      data: { name: "P10E scope B", slug: `p10e-scope-b-${suffix}`, schoolName: "B大学" },
    });
    const user = await db.user.create({
      data: {
        name: "P10E campus operator", email: `p10e-scope-${suffix}@it.local`,
        passwordHash: "test-only", schoolName: "A大学", campusId: a.id,
      },
    });
    const role = await db.role.create({
      data: {
        key: `P10E_SCOPED_${suffix}`, name: "P10E scoped test role",
        scope: "CAMPUS", isSystem: false,
        rolePermissions: { create: [{
          permission: { connect: { key: "runtime.config.manage" } },
        }] },
      },
    });
    try {
      await db.campusMembership.create({
        data: { userId: user.id, campusId: a.id, status: "ACTIVE" },
      });
      await db.userRoleAssignment.create({
        data: {
          userId: user.id, roleId: role.id,
          campusId: a.id, scopeKey: `CAMPUS:${a.id}`,
        },
      });
      for (const campusId of [null, b.id]) {
        await expect(setRuntimeConfig({
          actorId: user.id, key: "RISK_SIGNAL_EVIDENCE_LIMIT",
          campusId, value: 15, expectedVersion: 0,
        })).rejects.toThrow();
      }
      // Exact authorized campus proceeds past permission gate; test aborts
      // intentionally so no revision-history fixture is committed.
      await expect(setRuntimeConfig({
        actorId: user.id, key: "RISK_SIGNAL_EVIDENCE_LIMIT",
        campusId: a.id, value: 15, expectedVersion: 0,
        seams: {
          beforeAudit: async () => { throw new Error("P10E_AUTHORIZED_BUT_ROLLED_BACK"); },
        },
      })).rejects.toThrow("P10E_AUTHORIZED_BUT_ROLLED_BACK");
      expect(await db.runtimeConfigOverride.count({
        where: { scopeKey: { in: ["GLOBAL", `CAMPUS:${a.id}`, `CAMPUS:${b.id}`] } },
      })).toBe(0);
      expect(await db.adminLog.count({
        where: { adminId: user.id, action: "RUNTIME_CONFIG_CHANGED" },
      })).toBe(0);
    } finally {
      await db.userRoleAssignment.deleteMany({ where: { userId: user.id } });
      await db.campusMembership.deleteMany({ where: { userId: user.id } });
      await db.rolePermission.deleteMany({ where: { roleId: role.id } });
      await db.role.delete({ where: { id: role.id } });
      await db.user.delete({ where: { id: user.id } });
      await db.campus.deleteMany({ where: { id: { in: [a.id, b.id] } } });
      await db.$disconnect();
    }
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
