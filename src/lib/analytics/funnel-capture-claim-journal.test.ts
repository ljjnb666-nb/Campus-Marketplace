import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import {
  CaptureClaimContractError, asUnverifiedCaptureInterval,
  prepareUnverifiedCaptureClaim, recordUnverifiedCaptureClaimTx,
} from "@/lib/analytics/funnel-capture-claim-journal";

const now = new Date("2026-10-01T00:00:00.000Z");
const later = new Date("2026-10-02T00:00:00.000Z");
const sha = "a".repeat(40);
const valid = () => ({
  campusId: "campus-a", stream: "LISTING_CREATED" as const,
  instanceId: "app.01", releaseSha: sha,
  from: now, until: later, captureEnabled: true,
});

describe("10K-R2d-03B-01 unverified capture claim journal", () => {
  it("deterministically keys the complete immutable claim", () => {
    const x = prepareUnverifiedCaptureClaim(valid());
    const y = prepareUnverifiedCaptureClaim({ ...valid() });
    expect(x).toEqual(y);
    expect(x.claimKey).toMatch(/^[a-f0-9]{64}$/);
    expect(x.source).toBe("UNVERIFIED");
    expect(x.claimedFrom).not.toBe(now);
    expect(x.claimedUntil).not.toBe(later);
  });

  it("changes key for any business dimension; does not treat independent streams as duplicates", () => {
    const prior = prepareUnverifiedCaptureClaim(valid()).claimKey;
    const changes = [
      { ...valid(), campusId: "campus-b" },
      { ...valid(), stream: "FIRST_REPLY" as const },
      { ...valid(), instanceId: "app.02" },
      { ...valid(), releaseSha: "b".repeat(40) },
      { ...valid(), from: new Date(now.getTime() + 1) },
      { ...valid(), until: new Date(later.getTime() + 1) },
      { ...valid(), captureEnabled: false },
    ];
    for (const c of changes) {
      expect(prepareUnverifiedCaptureClaim(c).claimKey).not.toBe(prior);
    }
  });

  it("denies forged stream, instance, release, tenant and clock inputs", () => {
    const cases: unknown[] = [
      { ...valid(), campusId: "" },
      { ...valid(), campusId: "x".repeat(192) },
      { ...valid(), stream: "USER_EMAIL" },
      { ...valid(), instanceId: "../secret" },
      { ...valid(), instanceId: "" },
      { ...valid(), releaseSha: "unknown" },
      { ...valid(), releaseSha: "A".repeat(40) },
      { ...valid(), captureEnabled: "true" },
      { ...valid(), from: "2026-10-01" },
      { ...valid(), from: new Date("invalid") },
      { ...valid(), until: now },
      { ...valid(), until: new Date("invalid") },
    ];
    for (const c of cases) {
      expect(() => prepareUnverifiedCaptureClaim(c as ReturnType<typeof valid>))
        .toThrow(CaptureClaimContractError);
    }
  });

  it("cannot elevate stored source to DEPLOY_LOG through evaluation adapter", () => {
    const x = asUnverifiedCaptureInterval(prepareUnverifiedCaptureClaim(valid()));
    expect(x).toEqual({
      campusId: "campus-a", stream: "LISTING_CREATED",
      instanceId: "app.01", releaseSha: sha, from: now, until: later,
      captureEnabled: true, source: "UNVERIFIED",
    });
    expect(x.source).not.toBe("DEPLOY_LOG");
  });

  it("inserts once and returns only key + dedupe status", async () => {
    const expected = prepareUnverifiedCaptureClaim(valid());
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi.fn().mockResolvedValue(expected);
    const tx = { funnelCaptureClaim: { createMany, findUnique } } as unknown as Prisma.TransactionClient;
    expect(await recordUnverifiedCaptureClaimTx(tx, valid()))
      .toEqual({ recorded: true, claimKey: expected.claimKey });
    expect(createMany).toHaveBeenCalledWith({ data: [expected], skipDuplicates: true });
    expect(findUnique).toHaveBeenCalledWith({
      where: { claimKey: expected.claimKey },
      select: {
        claimKey: true, campusId: true, stream: true, instanceId: true,
        releaseSha: true, claimedFrom: true, claimedUntil: true,
        captureEnabled: true, source: true,
      },
    });
  });

  it("accepts only a semantically identical idempotent replay", async () => {
    const row = prepareUnverifiedCaptureClaim(valid());
    const tx = { funnelCaptureClaim: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      findUnique: vi.fn().mockResolvedValue(row),
    } } as unknown as Prisma.TransactionClient;
    expect(await recordUnverifiedCaptureClaimTx(tx, valid()))
      .toEqual({ recorded: false, claimKey: row.claimKey });
  });

  it("fails closed if duplicate identity resolves to different source or interval", async () => {
    const row = prepareUnverifiedCaptureClaim(valid());
    for (const altered of [
      null, { ...row, source: "DEPLOY_LOG" },
      { ...row, claimedUntil: new Date(row.claimedUntil.getTime() + 1) },
      { ...row, campusId: "other" },
      { ...row, claimKey: "f".repeat(64) },
    ]) {
      const tx = { funnelCaptureClaim: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue(altered),
      } } as unknown as Prisma.TransactionClient;
      await expect(recordUnverifiedCaptureClaimTx(tx, valid()))
        .rejects.toThrow("FUNNEL_CAPTURE_CLAIM_INVALID");
    }
  });

  it("does not open any public ingress, enable any capture switch or attest real fleet membership", () => {
    const x = prepareUnverifiedCaptureClaim(valid());
    expect(Object.keys(x).sort()).toEqual([
      "campusId", "captureEnabled", "claimKey", "claimedFrom",
      "claimedUntil", "instanceId", "releaseSha", "source", "stream",
    ].sort());
    expect("captureContinuityProven" in x).toBe(false);
  });
});
