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
      expect(row.sequence).toBe(BigInt(1));
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
      { sequence: BigInt(0) },
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

  it("never persists shadowed duplicate JSON keys with sensitive values", async () => {
    const data = prepareUnverifiedHostLifecycleClaim({
      ...sample(), instances: [app],
    });
    // Direct SQL/ORM callers can bypass the TypeScript JSON allowlist.
    // jsonb validation discards duplicate keys, so never store raw TEXT.
    const injected = `[{"instanceId":"secret-user@example.com","instanceId":"${app.instanceId}","releaseSha":"${app.releaseSha}","role":"APP"}]`;
    await expect(db.$transaction(async tx => {
      const row = await tx.hostLifecycleClaim.create({
        data: { ...data, baselineJson: injected },
      });
      expect(row.baselineJson).not.toContain("secret-user@example.com");
      expect(JSON.parse(row.baselineJson!)).toEqual([app]);
      // Canonical ORM writes remain retriable against JSONB-normalized text.
      expect(await recordUnverifiedHostLifecycleClaimTx(tx, {
        ...sample(), instances: [app],
      })).toEqual({ recorded: false, claimKey: data.claimKey });
      throw new Error("ROLLBACK_SHADOWED_BASELINE");
    })).rejects.toThrow("ROLLBACK_SHADOWED_BASELINE");
    expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
  });

  it("rejects PostgreSQL infinite timestamps at the raw SQL boundary", async () => {
    for (const value of ["infinity", "-infinity"]) {
      await expect(db.$executeRawUnsafe(
        `INSERT INTO "HostLifecycleClaim"
           ("claimKey","hostId","sessionId","sequence","observedAt","kind")
           VALUES ($1,$2,'session.02',2,$3::timestamp,'HEARTBEAT')`,
        "f".repeat(64), hostId, value,
      )).rejects.toThrow();
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

  it("blocks both ordinary TRUNCATE and TRUNCATE CASCADE", async () => {
    const data = prepareUnverifiedHostLifecycleClaim(sample());
    for (const sql of [
      'TRUNCATE TABLE "HostLifecycleClaim"',
      'TRUNCATE TABLE "HostLifecycleClaim" CASCADE',
    ]) {
      await expect(db.$transaction(async tx => {
        await tx.hostLifecycleClaim.create({ data });
        await tx.$executeRawUnsafe(sql);
      })).rejects.toThrow("HOST_LIFECYCLE_CLAIM_APPEND_ONLY");
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    }
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

  it("handles competing same-sequence inserts after an uncommitted writer rollback", async () => {
    const key = prepareUnverifiedHostLifecycleClaim(sample()).claimKey;
    let firstInserted!: () => void;
    const firstReady = new Promise<void>(resolve => { firstInserted = resolve; });
    let releaseFirst!: () => void;
    const release = new Promise<void>(resolve => { releaseFirst = resolve; });

    const first = db.$transaction(async tx => {
      expect(await recordUnverifiedHostLifecycleClaimTx(tx, sample()))
        .toEqual({ recorded: true, claimKey: key });
      firstInserted();
      await release;
      throw new Error("ROLLBACK_FIRST_HOST_WRITER");
    }, { timeout: 10_000 }).then(
      () => "UNEXPECTED_FIRST_COMMIT",
      (error: unknown) => String(error),
    );
    await firstReady;

    let secondStarted!: () => void;
    const secondReady = new Promise<void>(resolve => { secondStarted = resolve; });
    const second = db.$transaction(async tx => {
      secondStarted();
      // No lost idempotency marker: after A's rollback the exact event is
      // newly inserted by B, never treated as already durably recorded.
      expect(await recordUnverifiedHostLifecycleClaimTx(tx, sample()))
        .toEqual({ recorded: true, claimKey: key });
      throw new Error("ROLLBACK_SECOND_HOST_WRITER");
    }, { timeout: 10_000 }).then(
      () => "UNEXPECTED_SECOND_COMMIT",
      (error: unknown) => String(error),
    );
    await secondReady;
    releaseFirst();
    const [one, two] = await Promise.all([first, second]);
    expect(one).toContain("ROLLBACK_FIRST_HOST_WRITER");
    expect(two).toContain("ROLLBACK_SECOND_HOST_WRITER");
    expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
  }, 20_000);

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
