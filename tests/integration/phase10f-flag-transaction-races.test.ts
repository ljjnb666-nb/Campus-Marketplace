import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { lockFeatureFlagExclusive, requireNewActivityAllowed } from "@/lib/feature-flags/feature-flag-guard";
import { setFeatureFlag } from "@/lib/feature-flags/feature-flag-service";
import { withTransaction } from "@/lib/prisma";

vi.setConfig({ testTimeout: 35_000, hookTimeout: 50_000 });

const dbUrl = process.env.DATABASE_URL ?? process.env.INTEGRATION_DATABASE_URL;
const enabled = !!process.env.INTEGRATION_DATABASE_URL;

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * All committed tests use their OWN campus and flag scope, never GLOBAL.
 * Concurrent lock tests use a reversible test-only flag row, WITHOUT writing
 * revision/audit history. This is deliberate: real admin writes are proven by
 * phase10f-feature-flags.test.ts, while this suite proves the shared/exclusive
 * lock barrier on independent DB connections and committed-state visibility.
 *
 * The immutable revision trigger must NEVER be disabled/deleted for cleanup.
 * The real service is exercised here separately for audit-failure rollback.
 */
async function withIsolatedCampus(
  run: (input: { db: PrismaClient; campusId: string; actorId: string }) => Promise<void>,
) {
  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  const suffix = randomUUID().slice(0, 10);
  let campusId = "";
  let actorId = "";
  try {
    const campus = await db.campus.create({ data: {
      name: "P10F race", slug: `p10f-race-${suffix}`, schoolName: "测试大学",
    } });
    campusId = campus.id;
    const actor = await db.user.create({ data: {
      name: "P10F race admin", email: `p10f-race-${suffix}@it.local`,
      passwordHash: "test-only", schoolName: "测试大学", campusId,
    } });
    actorId = actor.id;
    const role = await db.role.findUniqueOrThrow({
      where: { key: "PLATFORM_ADMIN" }, select: { id: true },
    });
    await db.userRoleAssignment.create({ data: {
      userId: actorId, roleId: role.id, scopeKey: "GLOBAL",
    } });
    await run({ db, campusId, actorId });
  } finally {
    try {
      if (campusId) {
        const committedRevisions = await db.featureFlagRevision.count({
          where: { flag: { campusId } },
        });
        if (committedRevisions !== 0) {
          throw new Error("P10F_TEST_FIXTURE_IMMUTABLE_HISTORY_LEAK");
        }
        // Fixture-only flag rows have no revision; NEVER bypass the
        // FEATURE_FLAG_REVISION_APPEND_ONLY trigger to clean up tests.
        await db.featureFlagOverride.deleteMany({ where: { campusId } });
      }
      if (actorId) {
        await db.adminLog.deleteMany({
          where: { adminId: actorId, action: "FEATURE_FLAG_CHANGED" },
        });
        await db.userRoleAssignment.deleteMany({ where: { userId: actorId } });
        await db.user.deleteMany({ where: { id: actorId } });
      }
      if (campusId) await db.campus.deleteMany({ where: { id: campusId } });
    } finally {
      await db.$disconnect();
    }
  }
}

describe.skipIf(!enabled)("P10F real PostgreSQL transaction-race acceptance", () => {
  it("P10F-RACE-01: business takes SHARED first; emergency disable waits until commit", async () => {
    await withIsolatedCampus(async ({ db, campusId }) => {
      const guarded = latch();
      const releaseBusiness = latch();
      const writerStarted = latch();
      const sequence: string[] = [];

      const business = withTransaction(async (tx) => {
        await requireNewActivityAllowed(tx, { kind: "ORDER", campusId });
        guarded.resolve();
        await releaseBusiness.promise;
      }, { timeout: 15_000 }).then(() => { sequence.push("business"); });

      await guarded.promise;
      // Reversible, isolated fixture writer: same exclusive lock primitive
      // used by setFeatureFlagTx, but without durable immutable revisions.
      // CAS/audit correctness of setFeatureFlagTx is tested in PG-01.
      const writer = withTransaction(async (tx) => {
        writerStarted.resolve();
        await lockFeatureFlagExclusive(tx, "DISABLE_NEW_ORDERS", `CAMPUS:${campusId}`);
        await tx.featureFlagOverride.create({ data: {
          key: "DISABLE_NEW_ORDERS", scopeKey: `CAMPUS:${campusId}`,
          campusId, disabled: true, version: 1,
        } });
      }).then(() => { sequence.push("writer"); });

      try {
        await writerStarted.promise;
        await sleep(100);
        expect(sequence).toEqual([]); // writer is blocked at the exclusive flag barrier
      } finally {
        releaseBusiness.resolve();
      }

      await Promise.all([business, writer]);
      expect(sequence).toEqual(["business", "writer"]);
      const flag = await db.featureFlagOverride.findUniqueOrThrow({
        where: { key_scopeKey: {
          key: "DISABLE_NEW_ORDERS", scopeKey: `CAMPUS:${campusId}`,
        } },
      });
      expect(flag.disabled).toBe(true);
      await expect(withTransaction((tx) =>
        requireNewActivityAllowed(tx, { kind: "ORDER", campusId }),
      )).rejects.toMatchObject({ code: "NEW_ACTIVITY_DISABLED" });
    });
  });

  it("P10F-RACE-02: disable takes EXCLUSIVE first; later business fails closed", async () => {
    await withIsolatedCampus(async ({ campusId }) => {
      const writerHoldingLock = latch();
      const releaseWriter = latch();
      // Reversible fixture writer: committed DB state and advisory locks
      // are real, but no immutable admin history is created by the fixture.
      const writer = withTransaction(async (tx) => {
        await lockFeatureFlagExclusive(tx, "DISABLE_NEW_ORDERS", `CAMPUS:${campusId}`);
        await tx.featureFlagOverride.create({ data: {
          key: "DISABLE_NEW_ORDERS", scopeKey: `CAMPUS:${campusId}`,
          campusId, disabled: true, version: 1,
        } });
        writerHoldingLock.resolve();
        await releaseWriter.promise;
      }, { timeout: 15_000 });
      await writerHoldingLock.promise;

      let readerFinished = false;
      // Catch synchronously: a future rejection must never become unhandled.
      const reading = withTransaction((tx) =>
        requireNewActivityAllowed(tx, { kind: "ORDER", campusId }),
      ).then(
        () => { readerFinished = true; return { allowed: true }; },
        (error: unknown) => { readerFinished = true; return error; },
      );

      try {
        await sleep(100);
        expect(readerFinished).toBe(false);
      } finally {
        releaseWriter.resolve();
      }
      await writer;
      expect(await reading).toMatchObject({ code: "NEW_ACTIVITY_DISABLED" });
    });
  });

  it("P10F-ROLLBACK-01: injected audit failure rolls back current flag and revision", async () => {
    await withIsolatedCampus(async ({ db, campusId, actorId }) => {
      await expect(setFeatureFlag({
        actorId, key: "DISABLE_NEW_ORDERS", campusId,
        disabled: true, expectedVersion: 0,
        seams: {
          beforeAudit: async () => {
            throw new Error("P10F_INJECTED_AUDIT_ABORT");
          },
        },
      })).rejects.toThrow("P10F_INJECTED_AUDIT_ABORT");

      expect(await db.featureFlagOverride.count({
        where: { campusId, key: "DISABLE_NEW_ORDERS" },
      })).toBe(0);
      expect(await db.featureFlagRevision.count({
        where: { flag: { campusId } },
      })).toBe(0);
      expect(await db.adminLog.count({
        where: { adminId: actorId, action: "FEATURE_FLAG_CHANGED" },
      })).toBe(0);
      // The rejected write must not poison business activity on this campus.
      await withTransaction((tx) =>
        requireNewActivityAllowed(tx, { kind: "ORDER", campusId }),
      );
    });
  });
});
