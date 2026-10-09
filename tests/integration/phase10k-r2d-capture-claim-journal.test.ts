import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  prepareUnverifiedCaptureClaim, recordUnverifiedCaptureClaimTx,
} from "@/lib/analytics/funnel-capture-claim-journal";

const url = process.env.INTEGRATION_DATABASE_URL;
describe.skipIf(!url)("10K-R2d-03B-01 real-PG immutable capture claim journal", () => {
  let db: PrismaClient;
  const campusId = "journal-" + randomUUID();
  const sample = () => ({
    campusId, stream: "LISTING_CREATED" as const,
    instanceId: "app.01", releaseSha: "a".repeat(40),
    from: new Date("2026-09-01T00:00:00.000Z"),
    until: new Date("2026-09-02T00:00:00.000Z"),
    captureEnabled: true,
  });
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
    await db.$connect();
  });
  afterAll(async () => { if (db) await db.$disconnect(); });

  it("writes only UNVERIFIED immutable claims, transactionally idempotent; rolls back fixture", async () => {
    const prepared = prepareUnverifiedCaptureClaim(sample());
    await expect(db.$transaction(async tx => {
      expect(await recordUnverifiedCaptureClaimTx(tx, sample()))
        .toEqual({ claimKey: prepared.claimKey, recorded: true });
      expect(await recordUnverifiedCaptureClaimTx(tx, sample()))
        .toEqual({ claimKey: prepared.claimKey, recorded: false });
      const rows = await tx.funnelCaptureClaim.findMany({ where: { campusId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        campusId, source: "UNVERIFIED", captureEnabled: true,
        claimKey: prepared.claimKey,
      });
      throw new Error("ROLLBACK_CLAIM_FIXTURE");
    })).rejects.toThrow("ROLLBACK_CLAIM_FIXTURE");
    expect(await db.funnelCaptureClaim.count({ where: { campusId } })).toBe(0);
  });

  it("PostgreSQL rejects a forged DEPLOY_LOG attestation; no fixture persists", async () => {
    const c = prepareUnverifiedCaptureClaim(sample());
    await expect(db.funnelCaptureClaim.create({
      data: { ...c, source: "DEPLOY_LOG" },
    })).rejects.toThrow();
    expect(await db.funnelCaptureClaim.count({ where: { campusId } })).toBe(0);
  });

  it("PostgreSQL rejects inverted claim windows", async () => {
    const c = prepareUnverifiedCaptureClaim(sample());
    await expect(db.funnelCaptureClaim.create({
      data: { ...c, claimedFrom: c.claimedUntil, claimedUntil: c.claimedFrom },
    })).rejects.toThrow();
    expect(await db.funnelCaptureClaim.count({ where: { campusId } })).toBe(0);
  });

  it("database trigger rejects UPDATE and DELETE even when attempted inside a tx", async () => {
    const c = prepareUnverifiedCaptureClaim(sample());
    await expect(db.$transaction(async tx => {
      await tx.funnelCaptureClaim.create({ data: c });
      await tx.funnelCaptureClaim.update({
        where: { claimKey: c.claimKey }, data: { captureEnabled: false },
      });
    })).rejects.toThrow();
    await expect(db.$transaction(async tx => {
      await tx.funnelCaptureClaim.create({ data: c });
      await tx.funnelCaptureClaim.delete({ where: { claimKey: c.claimKey } });
    })).rejects.toThrow();
    expect(await db.funnelCaptureClaim.count({ where: { campusId } })).toBe(0);
  });

  it("PostgreSQL statement trigger rejects TRUNCATE, including an ordinary transactional truncation", async () => {
    const c = prepareUnverifiedCaptureClaim(sample());
    await expect(db.$transaction(async tx => {
      await tx.funnelCaptureClaim.create({ data: c });
      // DELETE row triggers cannot intercept TRUNCATE; this must fail on its own.
      await tx.$executeRawUnsafe('TRUNCATE TABLE "FunnelCaptureClaim"');
    })).rejects.toThrow("FUNNEL_CAPTURE_CLAIM_APPEND_ONLY");
    expect(await db.funnelCaptureClaim.count({ where: { campusId } })).toBe(0);
  });

  it("real PostgreSQL detects a conflicting row sharing a claimKey rather than silently deduping", async () => {
    const c = prepareUnverifiedCaptureClaim(sample());
    await expect(db.$transaction(async tx => {
      await tx.funnelCaptureClaim.create({
        data: { ...c, campusId: campusId + "-conflict" },
      });
      await recordUnverifiedCaptureClaimTx(tx, sample());
    })).rejects.toThrow("FUNNEL_CAPTURE_CLAIM_INVALID");
    expect(await db.funnelCaptureClaim.count({
      where: { claimKey: c.claimKey },
    })).toBe(0);
  });

  it("database constraints reject invalid streams, instance IDs and release SHAs", async () => {
    const c = prepareUnverifiedCaptureClaim(sample());
    for (const invalid of [
      { stream: "NOT_A_CAPTURE_STREAM" },
      { instanceId: "../unsafe" },
      { releaseSha: "INVALID" },
      { campusId: "" },
      { claimKey: "bad" },
    ]) {
      await expect(db.funnelCaptureClaim.create({
        data: { ...c, ...invalid },
      })).rejects.toThrow();
    }
    expect(await db.funnelCaptureClaim.count({ where: { campusId } })).toBe(0);
  });

});
