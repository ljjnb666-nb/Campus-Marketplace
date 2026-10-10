import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  recordContiguousUnverifiedHostClaimTx,
} from "@/lib/analytics/funnel-host-lifecycle-contiguous-unverified";
import {
  recordUnverifiedHostLifecycleClaimTx,
} from "@/lib/analytics/funnel-host-lifecycle-claim-journal";
import type { UnverifiedHostLifecycleObservation } from
  "@/lib/analytics/funnel-host-lifecycle-replay";

const url = process.env.INTEGRATION_DATABASE_URL;
describe.skipIf(!url)(
  "10K-R2d-03B-02B-02B-12A real-PG unverified sequence guard", () => {
    let db: PrismaClient;
    const hostId = "host." + randomUUID();
    const origin = new Date("2026-10-09T00:00:00.000Z");
    const member = { instanceId: "app.01", releaseSha: "a".repeat(40), role: "APP" as const };
    const observation = (
      sequence = 1,
      kind: "BASELINE" | "HEARTBEAT" | "DISCONNECTED" = "BASELINE",
      offsetMs = 0,
    ): UnverifiedHostLifecycleObservation => ({
      origin: "UNVERIFIED_HOST_OBSERVER", hostId,
      sessionId: "boot.01", sequence,
      observedAt: new Date(origin.getTime() + offsetMs), kind,
      ...(kind === "BASELINE" ? { instances: [member] } : {}),
    });
    beforeAll(async () => {
      db = new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
      await db.$connect();
    });
    afterAll(async () => { if (db) await db.$disconnect(); });

    it("accepts genesis, exact retries and contiguous claims; rolls back all fixtures", async () => {
      await expect(db.$transaction(async tx => {
        const a = await recordContiguousUnverifiedHostClaimTx(tx, observation());
        expect(a).toMatchObject({
          recorded: true, source: "UNVERIFIED",
          independentProvisioningVerified: false,
          independentHostAuthenticated: false,
          deploymentMembershipComplete: false,
          captureContinuityProven: false,
          canPublish: false,
        });
        expect(await recordContiguousUnverifiedHostClaimTx(tx, observation()))
          .toMatchObject({ recorded: false, claimKey: a.claimKey });
        const b = await recordContiguousUnverifiedHostClaimTx(
          tx, observation(2, "HEARTBEAT", 1000),
        );
        expect(b.recorded).toBe(true);
        // A lost commit response may be safely retried even after later rows.
        expect(await recordContiguousUnverifiedHostClaimTx(tx, observation()))
          .toMatchObject({ recorded: false, claimKey: a.claimKey });
        expect(await tx.hostLifecycleClaim.count({ where: { hostId } })).toBe(2);
        throw new Error("ROLLBACK_12A");
      })).rejects.toThrow("ROLLBACK_12A");
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    });

    it("refuses genesis without BASELINE/sequence 1", async () => {
      for (const item of [observation(2), observation(1, "HEARTBEAT")]) {
        await expect(db.$transaction(async tx =>
          recordContiguousUnverifiedHostClaimTx(tx, item),
        )).rejects.toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
      }
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    });

    it("denies missing sequence and same-slot conflicting content", async () => {
      await expect(db.$transaction(async tx => {
        await recordContiguousUnverifiedHostClaimTx(tx, observation());
        await expect(recordContiguousUnverifiedHostClaimTx(
          tx, observation(3, "HEARTBEAT", 1000),
        )).rejects.toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
        await expect(recordContiguousUnverifiedHostClaimTx(
          tx, observation(1, "BASELINE", 200),
        )).rejects.toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
        throw new Error("ROLLBACK_GAP");
      })).rejects.toThrow("ROLLBACK_GAP");
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    });

    it("refuses clock rollback and more than 15 minutes of silence", async () => {
      await expect(db.$transaction(async tx => {
        await recordContiguousUnverifiedHostClaimTx(tx, observation());
        for (const offset of [-1, 15 * 60_000 + 1]) {
          await expect(recordContiguousUnverifiedHostClaimTx(
            tx, observation(2, "HEARTBEAT", offset),
          )).rejects.toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
        }
        throw new Error("ROLLBACK_CLOCK");
      })).rejects.toThrow("ROLLBACK_CLOCK");
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    });

    it("treats DISCONNECTED as terminal within the same session", async () => {
      await expect(db.$transaction(async tx => {
        await recordContiguousUnverifiedHostClaimTx(tx, observation());
        await recordContiguousUnverifiedHostClaimTx(
          tx, observation(2, "DISCONNECTED", 1000),
        );
        await expect(recordContiguousUnverifiedHostClaimTx(
          tx, observation(3, "HEARTBEAT", 2000),
        )).rejects.toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
        throw new Error("ROLLBACK_DISCONNECT");
      })).rejects.toThrow("ROLLBACK_DISCONNECT");
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    });

    it("does not accept a silent second BASELINE or promote an old direct writer", async () => {
      await expect(db.$transaction(async tx => {
        await recordContiguousUnverifiedHostClaimTx(tx, observation());
        await expect(recordContiguousUnverifiedHostClaimTx(
          tx, observation(2, "BASELINE", 1000),
        )).rejects.toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
        // The old internal seam still exists; this opt-in guard cannot claim
        // a database-wide invariant against a bypassing/privileged writer.
        await recordUnverifiedHostLifecycleClaimTx(tx, observation(4, "HEARTBEAT", 4000));
        await expect(recordContiguousUnverifiedHostClaimTx(
          tx, observation(2, "HEARTBEAT", 1000),
        )).rejects.toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
        throw new Error("ROLLBACK_BYPASS");
      })).rejects.toThrow("ROLLBACK_BYPASS");
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    });

    it("refuses non-READ-COMMITTED transactions instead of trusting stale snapshots", async () => {
      await expect(db.$transaction(async tx => {
        await recordContiguousUnverifiedHostClaimTx(tx, observation());
      }, { isolationLevel: "RepeatableRead" })).rejects
        .toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    });

    it("serializes competing writers with a bounded PG advisory lock", async () => {
      let ready!: () => void;
      const firstReady = new Promise<void>(resolve => { ready = resolve; });
      let release!: () => void;
      const unblock = new Promise<void>(resolve => { release = resolve; });
      const first = db.$transaction(async tx => {
        await recordContiguousUnverifiedHostClaimTx(tx, observation());
        ready();
        await unblock;
        throw new Error("ROLLBACK_LOCK_OWNER");
      }, { timeout: 10_000 }).then(
        () => "UNEXPECTED_FIRST_COMMIT",
        (e: unknown) => String(e),
      );
      await firstReady;
      try {
        const second = await db.$transaction(async tx =>
          recordContiguousUnverifiedHostClaimTx(tx, observation()),
          { timeout: 8_000 },
        ).then(
          () => "UNEXPECTED_SECOND_SUCCESS",
          (e: unknown) => String(e),
        );
        expect(second).toContain("UNVERIFIED_HOST_SEQUENCE_REFUSED");
      } finally {
        release();
      }
      expect(await first).toContain("ROLLBACK_LOCK_OWNER");
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    }, 20_000);
  },
);
