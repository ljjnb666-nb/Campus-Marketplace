import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  assetCount,
  assetUpdateMany,
  assetFindMany,
  purgePendingDeleteAsset,
} = vi.hoisted(() => ({
  assetCount: vi.fn(),
  assetUpdateMany: vi.fn(),
  assetFindMany: vi.fn(),
  purgePendingDeleteAsset: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    uploadedAsset: {
      count: assetCount,
      updateMany: assetUpdateMany,
      findMany: assetFindMany,
    },
  },
}));

vi.mock("@/lib/asset-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/asset-service")>();
  return {
    ...actual,
    purgePendingDeleteAsset,
  };
});

import { runStorageCleanup } from "@/lib/asset-cleanup";

const now = new Date("2026-08-27T12:00:00.000Z");

const pendingAsset = {
  id: "asset-1",
  ownerId: "user-1",
  bucket: "campus-private",
  objectKey: "private/verification/user-1/x.webp",
  sizeBytes: 1024,
};

describe("runStorageCleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assetUpdateMany.mockResolvedValue({ count: 0 });
    assetFindMany.mockResolvedValue([]);
    purgePendingDeleteAsset.mockResolvedValue(true);
  });

  it("marks orphan uploads past the ttl as pending delete", async () => {
    assetUpdateMany.mockResolvedValue({ count: 3 });

    const summary = await runStorageCleanup({ now });

    expect(summary.orphansMarked).toBe(3);
    const orphanCall = assetUpdateMany.mock.calls.find(
      (call) => "status" in call[0].where && call[0].where.status === "UPLOADED",
    );
    expect(orphanCall).toBeDefined();
    expect(orphanCall![0].where.createdAt.lt).toEqual(
      new Date("2026-08-26T12:00:00.000Z"),
    );
    expect(orphanCall![0].data).toEqual({ status: "PENDING_DELETE" });
  });

  it("marks retention-expired sensitive assets as pending delete", async () => {
    assetUpdateMany.mockResolvedValue({ count: 2 });

    const summary = await runStorageCleanup({ now });

    expect(summary.retentionExpiredMarked).toBe(2);
    const expiredCall = assetUpdateMany.mock.calls.find(
      (call) => call[0].where.expiresAt !== undefined,
    );
    expect(expiredCall).toBeDefined();
    expect(expiredCall![0].where.expiresAt.lt).toEqual(now);
    expect(expiredCall![0].where.status.in).toEqual(["UPLOADED", "ATTACHED"]);
  });

  it("purges pending deletes and reports released quota", async () => {
    assetFindMany.mockResolvedValue([pendingAsset, { ...pendingAsset, id: "asset-2", sizeBytes: 512 }]);

    const summary = await runStorageCleanup({ now });

    expect(summary.objectsDeleted).toBe(2);
    expect(summary.quotaReleasedBytes).toBe(1536);
    expect(summary.failures).toBe(0);
    expect(purgePendingDeleteAsset).toHaveBeenCalledTimes(2);
  });

  it("keeps going when a single purge fails (retry next run)", async () => {
    assetFindMany.mockResolvedValue([
      pendingAsset,
      { ...pendingAsset, id: "asset-2", sizeBytes: 512 },
    ]);
    purgePendingDeleteAsset
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("s3 down"));

    const summary = await runStorageCleanup({ now });

    expect(summary.objectsDeleted).toBe(0);
    expect(summary.failures).toBe(2);
  });

  it("dry-run reports counts without mutating anything", async () => {
    assetCount.mockResolvedValue(2);

    const summary = await runStorageCleanup({ now, dryRun: true });

    expect(summary.dryRun).toBe(true);
    expect(summary.orphansMarked).toBe(2);
    expect(summary.retentionExpiredMarked).toBe(2);
    expect(assetUpdateMany).not.toHaveBeenCalled();
    expect(purgePendingDeleteAsset).not.toHaveBeenCalled();
  });

  it("is idempotent: a second run finds nothing to do", async () => {
    assetUpdateMany.mockResolvedValueOnce({ count: 1 });
    assetFindMany.mockResolvedValueOnce([pendingAsset]);
    const first = await runStorageCleanup({ now });

    assetUpdateMany.mockResolvedValue({ count: 0 });
    assetFindMany.mockResolvedValue([]);
    const second = await runStorageCleanup({ now });

    expect(first.objectsDeleted).toBe(1);
    expect(second.orphansMarked).toBe(0);
    expect(second.retentionExpiredMarked).toBe(0);
    expect(second.objectsDeleted).toBe(0);
  });
});
