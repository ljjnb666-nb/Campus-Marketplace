import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  assetCount,
  assetUpdateMany,
  assetFindMany,
  dataHoldFindMany,
  purgePendingDeleteAsset,
  markRetentionExpiredAssetPendingDelete,
} = vi.hoisted(() => ({
  assetCount: vi.fn(),
  assetUpdateMany: vi.fn(),
  assetFindMany: vi.fn(),
  dataHoldFindMany: vi.fn(),
  purgePendingDeleteAsset: vi.fn(),
  markRetentionExpiredAssetPendingDelete: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    uploadedAsset: {
      count: assetCount,
      updateMany: assetUpdateMany,
      findMany: assetFindMany,
    },
    dataHold: { findMany: dataHoldFindMany },
  },
  withTransaction: vi.fn(),
}));

vi.mock("@/lib/asset-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/asset-service")>();
  return {
    ...actual,
    purgePendingDeleteAsset,
    markRetentionExpiredAssetPendingDelete,
  };
});

import { runStorageCleanup } from "@/lib/asset-cleanup";

const now = new Date("2026-08-27T12:00:00.000Z");

describe("runStorageCleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dataHoldFindMany.mockResolvedValue([]);
    assetUpdateMany.mockResolvedValue({ count: 0 });
    assetFindMany.mockResolvedValue([]);
    purgePendingDeleteAsset.mockResolvedValue({ outcome: "PURGED", releasedQuotaBytes: 1024 });
    markRetentionExpiredAssetPendingDelete.mockResolvedValue("MARKED");
  });

  it("marks stale UPLOADING and orphan UPLOADED past the ttl as pending delete", async () => {
    assetUpdateMany.mockResolvedValue({ count: 3 });

    const summary = await runStorageCleanup({ now });

    expect(summary.orphansMarked).toBe(3);
    const orphanCall = assetUpdateMany.mock.calls.find(
      (call) =>
        call[0].where.status &&
        typeof call[0].where.status === "object" &&
        "in" in (call[0].where.status as Record<string, unknown>),
    );
    expect(orphanCall).toBeDefined();
    // 孤儿扫描同时覆盖：UPLOADING（预留后崩溃）与 UPLOADED（未绑定业务）
    expect(orphanCall![0].where.status.in).toEqual(["UPLOADING", "UPLOADED"]);
    expect(orphanCall![0].where.createdAt.lt).toEqual(
      new Date("2026-08-26T12:00:00.000Z"),
    );
    expect(orphanCall![0].data).toEqual({ status: "PENDING_DELETE" });
  });

  it("advances retention-expired candidates via the locked authoritative transition (id 线索，非快照)", async () => {
    assetFindMany
      .mockResolvedValueOnce([{ id: "asset-1" }, { id: "asset-2" }]) // retention discovery
      .mockResolvedValueOnce([]); // purge discovery

    const summary = await runStorageCleanup({ now });

    expect(summary.retentionExpiredMarked).toBe(2);
    expect(summary.retentionHoldBlocked).toBe(0);
    expect(markRetentionExpiredAssetPendingDelete).toHaveBeenCalledTimes(2);
    expect(markRetentionExpiredAssetPendingDelete).toHaveBeenNthCalledWith(1, "asset-1", now);
    expect(markRetentionExpiredAssetPendingDelete).toHaveBeenNthCalledWith(2, "asset-2", now);
  });

  it("counts in-lock retention hold blocks as hold-blocked, not failures", async () => {
    assetFindMany
      .mockResolvedValueOnce([{ id: "asset-1" }])
      .mockResolvedValueOnce([]);
    markRetentionExpiredAssetPendingDelete.mockResolvedValue("HOLD_BLOCKED");

    const summary = await runStorageCleanup({ now });

    expect(summary.retentionExpiredMarked).toBe(0);
    expect(summary.retentionHoldBlocked).toBe(1);
    expect(summary.failures).toBe(0);
  });

  it("keeps retention discovery batch bounded", async () => {
    assetFindMany.mockResolvedValueOnce([{ id: "asset-1" }]).mockResolvedValueOnce([]);

    await runStorageCleanup({ now, batchLimit: 1 });

    // discovery take = batchLimit（authoritative transition 逐条执行）
    expect(assetFindMany.mock.calls[0][0].take).toBe(1);
    expect(assetFindMany.mock.calls[1][0].take).toBe(1);
  });

  it("distinguishes PURGED / HOLD_BLOCKED / NOOP / RETRYABLE_FAILURE in the summary", async () => {
    assetUpdateMany.mockResolvedValue({ count: 0 });
    assetFindMany
      .mockResolvedValueOnce([]) // retention discovery
      .mockResolvedValueOnce([{ id: "purged" }, { id: "held" }, { id: "raced" }, { id: "failed" }]);
    purgePendingDeleteAsset
      .mockResolvedValueOnce({ outcome: "PURGED", releasedQuotaBytes: 1024 })
      .mockResolvedValueOnce({ outcome: "HOLD_BLOCKED", releasedQuotaBytes: 0 })
      .mockResolvedValueOnce({ outcome: "NOOP", releasedQuotaBytes: 0 })
      .mockResolvedValueOnce({ outcome: "RETRYABLE_FAILURE", releasedQuotaBytes: 0 });

    const summary = await runStorageCleanup({ now });

    expect(summary.objectsDeleted).toBe(1);
    expect(summary.quotaReleasedBytes).toBe(1024);
    expect(summary.purgeHoldBlocked).toBe(1);
    expect(summary.failures).toBe(1);
    // destructive boundary 只消费 discovery 的 id（fresh 行在锁内重读）
    expect(purgePendingDeleteAsset).toHaveBeenCalledWith("purged");
  });

  it("prefilters ACTIVE-held owners out of discovery and reports skipped rows", async () => {
    dataHoldFindMany.mockResolvedValue([{ subjectId: "held-user" }]);
    assetFindMany
      .mockResolvedValueOnce([{ id: "free-expired" }]) // retention discovery
      .mockResolvedValueOnce([{ id: "free-pending" }]); // purge discovery
    purgePendingDeleteAsset.mockResolvedValue({ outcome: "PURGED", releasedQuotaBytes: 512 });
    markRetentionExpiredAssetPendingDelete.mockResolvedValue("NOT_CANDIDATE");
    assetCount.mockResolvedValue(2); // held 行计数（retention + pending 预过滤）

    const summary = await runStorageCleanup({ now });

    // 公平性预过滤：discovery 不包含 held owner（NOT EXISTS 语义的 notIn 形式）
    expect(assetFindMany.mock.calls[0][0].where.ownerId).toEqual({ notIn: ["held-user"] });
    expect(assetFindMany.mock.calls[1][0].where.ownerId).toEqual({ notIn: ["held-user"] });
    expect(purgePendingDeleteAsset).toHaveBeenCalledTimes(1);
    // 预过滤跳过的 held 行计入 hold-blocked 观测（不是 failure）
    expect(summary.retentionHoldBlocked).toBe(2);
    expect(summary.purgeHoldBlocked).toBe(2);
    expect(summary.objectsDeleted).toBe(1);
    expect(summary.failures).toBe(0);
  });

  it("keeps going when a single purge throws (retry next run)", async () => {
    assetUpdateMany.mockResolvedValue({ count: 0 });
    assetFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "purged" }, { id: "thrown" }]);
    purgePendingDeleteAsset
      .mockResolvedValueOnce({ outcome: "PURGED", releasedQuotaBytes: 1024 })
      .mockRejectedValueOnce(new Error("s3 down"));

    const summary = await runStorageCleanup({ now });

    expect(summary.objectsDeleted).toBe(1);
    expect(summary.failures).toBe(1);
  });

  it("dry-run reports candidate and hold-blocked counts without mutating anything", async () => {
    dataHoldFindMany.mockResolvedValue([{ subjectId: "held-user" }]);
    assetCount
      .mockResolvedValueOnce(2) // orphans
      .mockResolvedValueOnce(2) // expired（非 held，将被推进）
      .mockResolvedValueOnce(1) // expired（held，将保留）
      .mockResolvedValueOnce(3) // pending（非 held，将被删除）
      .mockResolvedValueOnce(1); // pending（held，将跳过）

    const summary = await runStorageCleanup({ now, dryRun: true });

    expect(summary.dryRun).toBe(true);
    expect(summary.orphansMarked).toBe(2);
    expect(summary.retentionExpiredMarked).toBe(2);
    expect(summary.retentionHoldBlocked).toBe(1);
    expect(summary.objectsDeleted).toBe(3);
    expect(summary.purgeHoldBlocked).toBe(1);
    expect(assetUpdateMany).not.toHaveBeenCalled();
    expect(assetFindMany).not.toHaveBeenCalled();
    expect(purgePendingDeleteAsset).not.toHaveBeenCalled();
    expect(markRetentionExpiredAssetPendingDelete).not.toHaveBeenCalled();
  });

  it("is idempotent: a second run finds nothing to do", async () => {
    assetUpdateMany.mockResolvedValueOnce({ count: 1 });
    assetFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "asset-1" }]);
    const first = await runStorageCleanup({ now });
    expect(first.objectsDeleted).toBe(1);

    assetUpdateMany.mockResolvedValue({ count: 0 });
    assetFindMany.mockResolvedValue([]);
    const second = await runStorageCleanup({ now });

    expect(second.orphansMarked).toBe(0);
    expect(second.retentionExpiredMarked).toBe(0);
    expect(second.retentionHoldBlocked).toBe(0);
    expect(second.objectsDeleted).toBe(0);
    expect(second.purgeHoldBlocked).toBe(0);
  });
});
