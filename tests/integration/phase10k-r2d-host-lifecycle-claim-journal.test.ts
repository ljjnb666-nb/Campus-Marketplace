import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  prepareUnverifiedHostLifecycleClaim,
  recordUnverifiedHostLifecycleClaimTx,
} from "@/lib/analytics/funnel-host-lifecycle-claim-journal";
import type { UnverifiedHostLifecycleObservation } from
  "@/lib/analytics/funnel-host-lifecycle-replay";

const url = process.env.INTEGRATION_DATABASE_URL;
describe.skipIf(!url)("10K-R2d-03B-02B-02A real-PG immutable unverified host claim journal", () => {
  let db: PrismaClient;
  const hostId = "host." + randomUUID();
  const app = { instanceId: "app.01", releaseSha: "a".repeat(40),
    role: "APP" as const };
  const worker = { instanceId: "worker.01", releaseSha: "a".repeat(40),
    role: "ASYNC_WORKER" as const };
  const sample = (): UnverifiedHostLifecycleObservation => ({
    origin: "UNVERIFIED_HOST_OBSERVER", hostId, sessionId: "session.01",
    sequence: 1, observedAt: new Date("2026-09-01T00:00:00.000Z"),
    kind: "BASELINE", instances: [app, worker],
  });

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
    await db.$connect();
  });
  afterAll(async () => { if (db) await db.$disconnect(); });

  it("creates an append-only UNVERIFIED receipt, dedupes same sequence and rolls back", async () => {
    const expected = prepareUnverifiedHostLifecycleClaim(sample());
    await expect(db.$transaction(async tx => {
      expect(await recordUnverifiedHostLifecycleClaimTx(tx, sample()))
        .toEqual({ recorded: true, claimKey: expected.claimKey });
      expect(await recordUnverifiedHostLifecycleClaimTx(tx,
        { ...sample(), instances: [worker, app] }))
        .toEqual({ recorded: false, claimKey: expected.claimKey });
      const row = await tx.hostLifecycleClaim.findUniqueOrThrow({
        where: { claimKey: expected.claimKey },
      });
      expect(row.source).toBe("UNVERIFIED");
      expect(row.sequence).toBe(1n);
      expect(JSON.parse(row.baselineJson!)).toEqual([app, worker]);
      throw new Error("ROLLBACK_HOST_CLAIM");
    })).rejects.toThrow("ROLLBACK_HOST_CLAIM");
    expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
  });

  it("rejects same host/session/sequence with different claimed members atomically", async () => {
    await expect(db.$transaction(async tx => {
      await recordUnverifiedHostLifecycleClaimTx(tx, sample());
      await recordUnverifiedHostLifecycleClaimTx(tx, {
        ...sample(), instances: [app],
      });
    })).rejects.toThrow("HOST_LIFECYCLE_CLAIM_INVALID");
    expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
  });

  it("rejects a forged attested source even if the other fields look correct", async () => {
    const data = prepareUnverifiedHostLifecycleClaim(sample());
    await expect(db.hostLifecycleClaim.create({
      data: { ...data, source: "AUTHENTICATED" },
    })).rejects.toThrow();
    expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
  });

  it("fails DB CHECK constraints for invalid sequence, host or payload shape", async () => {
    const data = prepareUnverifiedHostLifecycleClaim(sample());
    const invalid = [
      { sequence: 0n },
      { hostId: "../spoof" },
      { sessionId: "" },
      { kind: "START", baselineJson: data.baselineJson },
      { kind: "START", baselineJson: null, instanceId: null, releaseSha: null, role: null },
      { kind: "STOP", baselineJson: null, instanceId: null, releaseSha: null, role: null },
      { kind: "BASELINE", baselineJson: "{}" },
      { kind: "BASELINE", baselineJson: "INVALID JSON" },
      { kind: "BASELINE", baselineJson: JSON.stringify(Array(129).fill(app)) },
      { kind: "BASELINE", baselineJson: JSON.stringify([{ ...app, ip: "10.0.0.1" }]) },
      { kind: "BASELINE", baselineJson: JSON.stringify([{ ...app, releaseSha: "bad" }]) },
      { kind: "BASELINE", baselineJson: JSON.stringify([app, app]) },
      { kind: "BASELINE", baselineJson: JSON.stringify([null]) },
      { claimKey: "bad" },
    ];
    for (const delta of invalid) {
      await expect(db.hostLifecycleClaim.create({ data: { ...data, ...delta } }))
        .rejects.toThrow();
    }
    expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
  });

  it("blocks UPDATE and DELETE within rolled-back transactions", async () => {
    const data = prepareUnverifiedHostLifecycleClaim(sample());
    await expect(db.$transaction(async tx => {
      await tx.hostLifecycleClaim.create({ data });
      await tx.hostLifecycleClaim.update({
        where: { claimKey: data.claimKey }, data: { source: "UNVERIFIED" },
      });
    })).rejects.toThrow();
    await expect(db.$transaction(async tx => {
      await tx.hostLifecycleClaim.create({ data });
      await tx.hostLifecycleClaim.delete({ where: { claimKey: data.claimKey } });
    })).rejects.toThrow();
    expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
  });

  it("blocks TRUNCATE including CASCADE, not only row-level DELETE", async () => {
    const data = prepareUnverifiedHostLifecycleClaim(sample());
    await expect(db.$transaction(async tx => {
      await tx.hostLifecycleClaim.create({ data });
      await tx.$executeRawUnsafe('TRUNCATE TABLE "HostLifecycleClaim"');
    })).rejects.toThrow("HOST_LIFECYCLE_CLAIM_APPEND_ONLY");
    expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
  });

  it("server overwrites forged recordedAt and rollback leaves no claims", async () => {
    const data = prepareUnverifiedHostLifecycleClaim(sample());
    const forged = new Date("1999-01-01T00:00:00.000Z");
    await expect(db.$transaction(async tx => {
      const row = await tx.hostLifecycleClaim.create({
        data: { ...data, recordedAt: forged },
      });
      expect(row.recordedAt).not.toEqual(forged);
      expect(row.source).toBe("UNVERIFIED");
      throw new Error("ROLLBACK_HOST_RECORDED_AT");
    })).rejects.toThrow("ROLLBACK_HOST_RECORDED_AT");
    expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
  });

  it("same session key is unique even if an unrelated digest is directly injected", async () => {
    const data = prepareUnverifiedHostLifecycleClaim(sample());
    const other = prepareUnverifiedHostLifecycleClaim({
      ...sample(), instances: [app],
    });
    await expect(db.$transaction(async tx => {
      await tx.hostLifecycleClaim.create({ data });
      await tx.hostLifecycleClaim.create({ data: other });
    })).rejects.toThrow();
    expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
  });
});
