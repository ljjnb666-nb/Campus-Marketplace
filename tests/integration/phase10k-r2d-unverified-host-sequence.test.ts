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

    it("refuses to append after a legacy writer left a hidden historical sequence hole", async () => {
      await expect(db.$transaction(async tx => {
        await recordUnverifiedHostLifecycleClaimTx(tx, observation());
        await recordUnverifiedHostLifecycleClaimTx(tx, observation(4, "HEARTBEAT", 4000));
        await expect(recordContiguousUnverifiedHostClaimTx(
          tx, observation(5, "HEARTBEAT", 5000),
        )).rejects.toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
        // Exact replay must not disguise a broken prefix either.
        await expect(recordContiguousUnverifiedHostClaimTx(
          tx, observation(4, "HEARTBEAT", 4000),
        )).rejects.toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
        expect(await tx.hostLifecycleClaim.count({ where: { hostId } })).toBe(2);
        throw new Error("ROLLBACK_CORRUPT_PREFIX");
      })).rejects.toThrow("ROLLBACK_CORRUPT_PREFIX");
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    });

    it("rejects historical prefix without a BASELINE at sequence one", async () => {
      await expect(db.$transaction(async tx => {
        await recordUnverifiedHostLifecycleClaimTx(tx, observation(1, "HEARTBEAT"));
        await recordUnverifiedHostLifecycleClaimTx(tx, observation(2, "HEARTBEAT", 1000));
        await expect(recordContiguousUnverifiedHostClaimTx(
          tx, observation(3, "HEARTBEAT", 2000),
        )).rejects.toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
        throw new Error("ROLLBACK_NO_GENESIS");
      })).rejects.toThrow("ROLLBACK_NO_GENESIS");
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    });

    it("accepts a valid legacy prefix without promoting its authority", async () => {
      await expect(db.$transaction(async tx => {
        await recordUnverifiedHostLifecycleClaimTx(tx, observation());
        await recordUnverifiedHostLifecycleClaimTx(tx, observation(2, "HEARTBEAT", 1000));
        expect(await recordContiguousUnverifiedHostClaimTx(
          tx, observation(3, "HEARTBEAT", 2000),
        )).toMatchObject({
          recorded: true, source: "UNVERIFIED",
          independentProvisioningVerified: false,
          independentHostAuthenticated: false,
          deploymentMembershipComplete: false,
          captureContinuityProven: false,
          canPublish: false,
        });
        expect(await recordContiguousUnverifiedHostClaimTx(tx, observation()))
          .toMatchObject({ recorded: false, source: "UNVERIFIED", canPublish: false });
        throw new Error("ROLLBACK_VALID_PREFIX");
      })).rejects.toThrow("ROLLBACK_VALID_PREFIX");
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    });

    it("denies legacy repeated BASELINE in an otherwise contiguous historical prefix", async () => {
      await expect(db.$transaction(async tx => {
        await recordUnverifiedHostLifecycleClaimTx(tx, observation());
        await recordUnverifiedHostLifecycleClaimTx(tx, observation(2, "BASELINE", 1000));
        await expect(recordContiguousUnverifiedHostClaimTx(
          tx, observation(3, "HEARTBEAT", 2000),
        )).rejects.toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
        await expect(recordContiguousUnverifiedHostClaimTx(
          tx, observation(),
        )).rejects.toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
        throw new Error("ROLLBACK_REPEAT_BASELINE");
      })).rejects.toThrow("ROLLBACK_REPEAT_BASELINE");
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    });

    it("denies a legacy historical clock rollback even when the next timestamp increases", async () => {
      await expect(db.$transaction(async tx => {
        await recordUnverifiedHostLifecycleClaimTx(tx, observation());
        await recordUnverifiedHostLifecycleClaimTx(tx, observation(2, "HEARTBEAT", -1000));
        await expect(recordContiguousUnverifiedHostClaimTx(
          tx, observation(3, "HEARTBEAT", 2000),
        )).rejects.toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
        throw new Error("ROLLBACK_CLOCK_PREFIX");
      })).rejects.toThrow("ROLLBACK_CLOCK_PREFIX");
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    });

    it("denies a legacy historical silence over 15 minutes", async () => {
      await expect(db.$transaction(async tx => {
        await recordUnverifiedHostLifecycleClaimTx(tx, observation());
        await recordUnverifiedHostLifecycleClaimTx(
          tx, observation(2, "HEARTBEAT", 15 * 60_000 + 1),
        );
        await expect(recordContiguousUnverifiedHostClaimTx(
          tx, observation(3, "HEARTBEAT", 15 * 60_000 + 1000),
        )).rejects.toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
        throw new Error("ROLLBACK_SILENCE_PREFIX");
      })).rejects.toThrow("ROLLBACK_SILENCE_PREFIX");
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    });

    it("denies an older writer's continuation after a historical DISCONNECTED", async () => {
      await expect(db.$transaction(async tx => {
        await recordUnverifiedHostLifecycleClaimTx(tx, observation());
        await recordUnverifiedHostLifecycleClaimTx(
          tx, observation(2, "DISCONNECTED", 1000),
        );
        await recordUnverifiedHostLifecycleClaimTx(
          tx, observation(3, "HEARTBEAT", 2000),
        );
        await expect(recordContiguousUnverifiedHostClaimTx(
          tx, observation(4, "HEARTBEAT", 3000),
        )).rejects.toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
        throw new Error("ROLLBACK_DISCONNECTED_PREFIX");
      })).rejects.toThrow("ROLLBACK_DISCONNECTED_PREFIX");
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    });

    it("denies a legacy duplicate START hidden inside a contiguous prefix", async () => {
      const start = (sequence: number, offsetMs: number) => ({
        ...observation(sequence, "HEARTBEAT", offsetMs),
        kind: "START" as const, instance: member,
      });
      await expect(db.$transaction(async tx => {
        await recordUnverifiedHostLifecycleClaimTx(tx, observation());
        await recordUnverifiedHostLifecycleClaimTx(tx, start(2, 1000));
        await expect(recordContiguousUnverifiedHostClaimTx(
          tx, observation(3, "HEARTBEAT", 2000),
        )).rejects.toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
        await expect(recordContiguousUnverifiedHostClaimTx(
          tx, observation(),
        )).rejects.toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
        throw new Error("ROLLBACK_DUPLICATE_START");
      })).rejects.toThrow("ROLLBACK_DUPLICATE_START");
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    });

    it("rejects a legacy orphan STOP or mismatched release identity", async () => {
      const bad = [
        { instanceId: "worker.99", releaseSha: "b".repeat(40), role: "ASYNC_WORKER" as const },
        { ...member, releaseSha: "b".repeat(40) },
      ];
      for (const instance of bad) {
        await expect(db.$transaction(async tx => {
          await recordUnverifiedHostLifecycleClaimTx(tx, observation());
          await recordUnverifiedHostLifecycleClaimTx(tx, {
            ...observation(2, "HEARTBEAT", 1000),
            kind: "STOP", instance,
          });
          await expect(recordContiguousUnverifiedHostClaimTx(
            tx, observation(3, "HEARTBEAT", 2000),
          )).rejects.toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
          throw new Error("ROLLBACK_BAD_STOP");
        })).rejects.toThrow("ROLLBACK_BAD_STOP");
      }
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    });

    it("checks proposed STOP/START state without producing trusted authority", async () => {
      await expect(db.$transaction(async tx => {
        await recordContiguousUnverifiedHostClaimTx(tx, observation());
        await expect(recordContiguousUnverifiedHostClaimTx(tx, {
          ...observation(2, "HEARTBEAT", 1000),
          kind: "START", instance: member,
        })).rejects.toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
        await expect(recordContiguousUnverifiedHostClaimTx(tx, {
          ...observation(2, "HEARTBEAT", 1000),
          kind: "STOP", instance: { ...member, releaseSha: "b".repeat(40) },
        })).rejects.toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
        const stop = await recordContiguousUnverifiedHostClaimTx(tx, {
          ...observation(2, "HEARTBEAT", 1000), kind: "STOP", instance: member,
        });
        expect(stop).toMatchObject({ recorded: true, source: "UNVERIFIED", canPublish: false });
        const start = await recordContiguousUnverifiedHostClaimTx(tx, {
          ...observation(3, "HEARTBEAT", 2000), kind: "START", instance: member,
        });
        expect(start).toMatchObject({
          recorded: true, source: "UNVERIFIED",
          independentProvisioningVerified: false,
          independentHostAuthenticated: false,
          deploymentMembershipComplete: false,
          captureContinuityProven: false, canPublish: false,
        });
        expect(await recordContiguousUnverifiedHostClaimTx(tx, {
          ...observation(2, "HEARTBEAT", 1000), kind: "STOP", instance: member,
        })).toMatchObject({ recorded: false, claimKey: stop.claimKey, canPublish: false });
        throw new Error("ROLLBACK_VALID_TRANSITIONS");
      })).rejects.toThrow("ROLLBACK_VALID_TRANSITIONS");
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    });

    it("accepts a clean legacy START/STOP state prefix as UNVERIFIED only", async () => {
      const worker = {
        instanceId: "worker.01", releaseSha: "c".repeat(40), role: "ASYNC_WORKER" as const,
      };
      await expect(db.$transaction(async tx => {
        await recordUnverifiedHostLifecycleClaimTx(tx, observation());
        await recordUnverifiedHostLifecycleClaimTx(tx, {
          ...observation(2, "HEARTBEAT", 1000), kind: "START", instance: worker,
        });
        await recordUnverifiedHostLifecycleClaimTx(tx, {
          ...observation(3, "HEARTBEAT", 2000), kind: "STOP", instance: member,
        });
        expect(await recordContiguousUnverifiedHostClaimTx(
          tx, observation(4, "HEARTBEAT", 3000),
        )).toMatchObject({ recorded: true, source: "UNVERIFIED", canPublish: false });
        throw new Error("ROLLBACK_LEGACY_VALID_TRANSITIONS");
      })).rejects.toThrow("ROLLBACK_LEGACY_VALID_TRANSITIONS");
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    });

    it("refuses non-READ-COMMITTED transactions instead of trusting stale snapshots", async () => {
      await expect(db.$transaction(async tx => {
        await recordContiguousUnverifiedHostClaimTx(tx, observation());
      }, { isolationLevel: "RepeatableRead" })).rejects
        .toThrow("UNVERIFIED_HOST_SEQUENCE_REFUSED");
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    });

    it("preserves caller transaction lock_timeout after a successful guarded write", async () => {
      await expect(db.$transaction(async tx => {
        // Existing caller policy must not be relaxed or shortened by this seam.
        await tx.$executeRaw`SET LOCAL lock_timeout = '7s'`;
        const before = await tx.$queryRaw<Array<{ setting: string }>>`
          SELECT current_setting('lock_timeout') AS setting
        `;
        expect(before).toEqual([{ setting: "7s" }]);
        const result = await recordContiguousUnverifiedHostClaimTx(tx, observation());
        expect(result).toMatchObject({ recorded: true, source: "UNVERIFIED", canPublish: false });
        const after = await tx.$queryRaw<Array<{ setting: string }>>`
          SELECT current_setting('lock_timeout') AS setting
        `;
        expect(after).toEqual(before);
        throw new Error("ROLLBACK_LOCK_TIMEOUT_OWNER");
      })).rejects.toThrow("ROLLBACK_LOCK_TIMEOUT_OWNER");
      expect(await db.hostLifecycleClaim.count({ where: { hostId } })).toBe(0);
    });

    it("does not serialize an unrelated host behind another scope's held lock", async () => {
      let ready!: () => void;
      const firstReady = new Promise<void>(resolve => { ready = resolve; });
      let release!: () => void;
      const unblock = new Promise<void>(resolve => { release = resolve; });
      const otherHostId = hostId + ".other";
      const first = db.$transaction(async tx => {
        await recordContiguousUnverifiedHostClaimTx(tx, observation());
        ready();
        await unblock;
        throw new Error("ROLLBACK_FIRST_SCOPE");
      }, { timeout: 10_000 }).then(
        () => "UNEXPECTED_FIRST_COMMIT",
        (error: unknown) => String(error),
      );
      await firstReady;
      try {
        await expect(db.$transaction(async tx => {
          const other = { ...observation(), hostId: otherHostId };
          const result = await recordContiguousUnverifiedHostClaimTx(tx, other);
          expect(result).toMatchObject({
            recorded: true, source: "UNVERIFIED", canPublish: false,
          });
          throw new Error("ROLLBACK_OTHER_SCOPE");
        }, { timeout: 8_000 })).rejects.toThrow("ROLLBACK_OTHER_SCOPE");
      } finally {
        release();
      }
      expect(await first).toContain("ROLLBACK_FIRST_SCOPE");
      expect(await db.hostLifecycleClaim.count({
        where: { hostId: { in: [hostId, otherHostId] } },
      })).toBe(0);
    }, 20_000);

    it("refuses contended writers without modifying caller SQL timeouts", async () => {
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
