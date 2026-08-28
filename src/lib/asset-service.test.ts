import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  putObject,
  deleteObject,
  getSignedReadUrl,
  executeRaw,
  assetCreate,
  assetFindFirst,
  assetUpdateMany,
  userFindUnique,
} = vi.hoisted(() => ({
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  getSignedReadUrl: vi.fn(),
  executeRaw: vi.fn(),
  assetCreate: vi.fn(),
  assetFindFirst: vi.fn(),
  assetUpdateMany: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    getStorage: () => ({
      putObject,
      deleteObject,
      getSignedReadUrl,
    }),
  };
});

vi.mock("@/lib/image-processing", () => ({
  processUploadedImage: vi.fn(async () => ({
    buffer: Buffer.alloc(1024),
    mimeType: "image/webp",
    width: 64,
    height: 48,
    format: "webp" as const,
  })),
  ImageValidationError: class ImageValidationError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $executeRaw: executeRaw,
    uploadedAsset: {
      create: assetCreate,
      findFirst: assetFindFirst,
      updateMany: assetUpdateMany,
    },
    user: { findUnique: userFindUnique },
  },
}));

import {
  AssetServiceError,
  attachAssetsToEntity,
  createPrivateAssetSignedUrl,
  markAssetPendingDelete,
  markAssetsForValuesPendingDelete,
  purgePendingDeleteAsset,
  quotaBytes,
  resolveImageTokens,
  resolvePrivateAssetAccess,
  uploadImageAsset,
} from "@/lib/asset-service";

function buildImageFile(size = 16) {
  // jsdom 的 File 缺少 arrayBuffer()，构造带桩的 File 形状
  const bytes = new Uint8Array(size);
  return {
    name: "photo.png",
    size,
    type: "image/png",
    arrayBuffer: vi.fn().mockResolvedValue(bytes.buffer),
  } as unknown as File;
}

/** 事务客户端桩：attachAssetsToEntity 直接在 tx 上操作 */
const txStub = {
  uploadedAsset: { updateMany: assetUpdateMany, findFirst: assetFindFirst },
} as unknown as Parameters<typeof attachAssetsToEntity>[0];

const baseAsset = {
  id: "asset-1",
  ownerId: "user-1",
  category: "VERIFICATION",
  access: "PRIVATE",
  bucket: "campus-private",
  objectKey: "private/verification/user-1/abcd1234.webp",
  mimeType: "image/webp",
  sizeBytes: 1024,
  status: "ATTACHED",
  expiresAt: null,
  rentalOrder: null,
};

describe("uploadImageAsset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeRaw.mockResolvedValue(1);
    putObject.mockResolvedValue(undefined);
    deleteObject.mockResolvedValue(undefined);
    assetCreate.mockResolvedValue({ id: "asset-1" });
  });

  it("uploads a public image and returns the public url", async () => {
    const result = await uploadImageAsset({
      userId: "user-1",
      category: "product",
      file: buildImageFile(),
    });

    expect(result.assetId).toBe("asset-1");
    expect(result.access).toBe("PUBLIC");
    expect(result.url).toMatch(/^http:\/\/localhost:9100\/campus-public\/public\/products\//);
    expect(result.sizeBytes).toBe(1024);
    // 配额预留 = 条件原子 UPDATE
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(putObject).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "campus-public", contentType: "image/webp" }),
    );
  });

  it("uploads a private image without any permanent url", async () => {
    const result = await uploadImageAsset({
      userId: "user-1",
      category: "verification",
      file: buildImageFile(),
    });

    expect(result.access).toBe("PRIVATE");
    expect(result.url).toBeNull();
    // 私有对象必须落在 private bucket，key 在 private/ 前缀下
    expect(putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "campus-private",
        objectKey: expect.stringMatching(/^private\/verification\//),
      }),
    );
  });

  it("rejects invalid categories and unsupported mime types", async () => {
    await expect(
      uploadImageAsset({
        userId: "user-1",
        category: "constructor" as "product",
        file: buildImageFile(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_CATEGORY" });

    await expect(
      uploadImageAsset({
        userId: "user-1",
        category: "product",
        file: new File([new Uint8Array(8)], "x.gif", { type: "image/gif" }),
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_MIME" });
  });

  it("rejects files beyond the category size limit", async () => {
    const big = buildImageFile(8);
    Object.defineProperty(big, "size", { value: 6 * 1024 * 1024 });

    await expect(
      uploadImageAsset({ userId: "user-1", category: "avatar", file: big }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE", status: 413 });
  });

  it("rejects with QUOTA_EXCEEDED when the reservation update matches no row", async () => {
    executeRaw.mockResolvedValue(0);

    await expect(
      uploadImageAsset({ userId: "user-1", category: "product", file: buildImageFile() }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", status: 413 });
    expect(putObject).not.toHaveBeenCalled();
    expect(assetCreate).not.toHaveBeenCalled();
  });

  it("releases the quota when the S3 upload fails (CASE A)", async () => {
    putObject.mockRejectedValue(new Error("connection reset"));

    await expect(
      uploadImageAsset({ userId: "user-1", category: "product", file: buildImageFile() }),
    ).rejects.toMatchObject({ code: "STORAGE_UPLOAD_FAILED", status: 500 });

    // 预留(1) + 释放(1)，无资源登记
    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(assetCreate).not.toHaveBeenCalled();
  });

  it("deletes the uploaded object and releases quota when the DB insert fails (CASE B)", async () => {
    assetCreate.mockRejectedValue(new Error("db down"));

    await expect(
      uploadImageAsset({ userId: "user-1", category: "product", file: buildImageFile() }),
    ).rejects.toMatchObject({ code: "ASSET_RECORD_FAILED", status: 500 });

    expect(deleteObject).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "campus-public" }),
    );
    // 预留(1) + 释放(1)
    expect(executeRaw).toHaveBeenCalledTimes(2);
  });

  it("reflects the configured default quota (500MB)", () => {
    expect(quotaBytes()).toBe(500 * 1024 * 1024);
  });
});

describe("attachAssetsToEntity and resolveImageTokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("claims only the owner's UPLOADED assets (conditional update)", async () => {
    assetUpdateMany.mockResolvedValue({ count: 1 });

    const attached = await attachAssetsToEntity(txStub, {
      ownerId: "user-1",
      assetIds: ["asset-1"],
      target: { type: "product", id: "product-9" },
    });

    expect(attached).toBe(1);
    expect(assetUpdateMany).toHaveBeenCalledWith({
      where: { id: "asset-1", ownerId: "user-1", status: "UPLOADED" },
      data: expect.objectContaining({
        status: "ATTACHED",
        productId: "product-9",
        attachedAt: expect.any(Date),
      }),
    });
  });

  it("resolves asset tokens of the owner and keeps foreign urls untouched", async () => {
    assetFindFirst.mockResolvedValue({ ...baseAsset, access: "PUBLIC", status: "UPLOADED" });
    assetUpdateMany.mockResolvedValue({ count: 1 });

    const resolved = await resolveImageTokens({
      ownerId: "user-1",
      tokens: ["asset:asset-1", "https://cdn.example.com/external.jpg", "  "],
      target: { type: "avatar" },
    });

    // 公开资源 → 公开 URL；外链透传；空 token 丢弃
    expect(resolved).toEqual([
      "http://localhost:9100/campus-public/private/verification/user-1/abcd1234.webp",
      "https://cdn.example.com/external.jpg",
    ]);
  });

  it("resolves private tokens into asset references without urls", async () => {
    assetFindFirst.mockResolvedValue(baseAsset);

    const [resolved] = await resolveImageTokens({
      ownerId: "user-1",
      tokens: ["asset:asset-1"],
      target: { type: "verification", id: "verification-1" },
    });

    expect(resolved).toBe("asset:asset-1");
  });

  it("rejects tokens that belong to another user", async () => {
    assetFindFirst.mockResolvedValue(null);

    await expect(
      resolveImageTokens({
        ownerId: "user-2",
        tokens: ["asset:asset-1"],
        target: { type: "avatar" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ASSET_REFERENCE" });
  });

  it("rejects deleted or pending-delete assets", async () => {
    assetFindFirst.mockResolvedValue({ ...baseAsset, status: "DELETED" });

    await expect(
      resolveImageTokens({
        ownerId: "user-1",
        tokens: ["asset:asset-1"],
        target: { type: "avatar" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ASSET_REFERENCE" });
  });
});

describe("delete lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteObject.mockResolvedValue(undefined);
    assetUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("marks pending delete idempotently", async () => {
    assetUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    expect(await markAssetPendingDelete("asset-1")).toBe(true);
    expect(await markAssetPendingDelete("asset-1")).toBe(false);
  });

  it("purges the object, completes the transition and releases quota exactly once", async () => {
    const purged = await purgePendingDeleteAsset({
      id: "asset-1",
      ownerId: "user-1",
      bucket: "campus-private",
      objectKey: baseAsset.objectKey,
      sizeBytes: 1024,
    });

    expect(purged).toBe(true);
    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(assetUpdateMany).toHaveBeenCalledWith({
      where: { id: "asset-1", status: "PENDING_DELETE" },
      data: { status: "DELETED", expiresAt: null },
    });
    // 释放配额的原子 UPDATE
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it("keeps PENDING_DELETE when object deletion fails (retry later)", async () => {
    deleteObject.mockRejectedValue(new Error("s3 down"));

    const purged = await purgePendingDeleteAsset({
      id: "asset-1",
      ownerId: "user-1",
      bucket: "campus-private",
      objectKey: baseAsset.objectKey,
      sizeBytes: 1024,
    });

    expect(purged).toBe(false);
    expect(assetUpdateMany).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("does not release quota twice when the transition already completed", async () => {
    // 第二次条件转移匹配 0 行（已是 DELETED）
    assetUpdateMany.mockResolvedValue({ count: 0 });

    await purgePendingDeleteAsset({
      id: "asset-1",
      ownerId: "user-1",
      bucket: "campus-private",
      objectKey: baseAsset.objectKey,
      sizeBytes: 1024,
    });

    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("marks assets by asset id and by public url value", async () => {
    assetUpdateMany.mockResolvedValue({ count: 2 });

    const marked = await markAssetsForValuesPendingDelete("user-1", [
      "asset:asset-1",
      "http://localhost:9100/campus-public/public/products/user-1/xyz.webp",
      "https://external.example.com/none.jpg",
    ]);

    expect(marked).toBe(2);
    const where = assetUpdateMany.mock.calls[0][0].where;
    expect(where.ownerId).toBe("user-1");
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { id: { in: ["asset-1"] } },
        { objectKey: { in: ["public/products/user-1/xyz.webp"] } },
      ]),
    );
  });
});

describe("resolvePrivateAssetAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns not_found for missing, deleted or pending-delete assets", async () => {
    assetFindFirst.mockResolvedValueOnce(null);
    assetFindFirst.mockResolvedValueOnce({ ...baseAsset, status: "DELETED" });
    assetFindFirst.mockResolvedValueOnce({ ...baseAsset, status: "PENDING_DELETE" });

    const stranger = { id: "user-2", role: "STUDENT" };
    for (let i = 0; i < 3; i += 1) {
      expect(await resolvePrivateAssetAccess("asset-1", stranger)).toEqual({
        ok: false,
        reason: "not_found",
      });
    }
  });

  it("returns not_private for public assets", async () => {
    assetFindFirst.mockResolvedValue({ ...baseAsset, access: "PUBLIC" });

    expect(await resolvePrivateAssetAccess("asset-1", { id: "user-2", role: "STUDENT" })).toEqual({
      ok: false,
      reason: "not_private",
    });
  });

  it("returns expired when the retention deadline has passed", async () => {
    assetFindFirst.mockResolvedValue({
      ...baseAsset,
      expiresAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect(await resolvePrivateAssetAccess("asset-1", { id: "user-1", role: "STUDENT" })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("allows the owner and admins regardless of category", async () => {
    assetFindFirst.mockResolvedValue(baseAsset);

    const owner = await resolvePrivateAssetAccess("asset-1", { id: "user-1", role: "STUDENT" });
    expect(owner.ok).toBe(true);

    assetFindFirst.mockResolvedValue(baseAsset);
    const admin = await resolvePrivateAssetAccess("asset-1", { id: "admin-1", role: "ADMIN" });
    expect(admin.ok).toBe(true);
  });

  it("forbids strangers from verification material", async () => {
    assetFindFirst.mockResolvedValue({ ...baseAsset, category: "VERIFICATION" });

    expect(
      await resolvePrivateAssetAccess("asset-1", { id: "user-2", role: "STUDENT" }),
    ).toEqual({ ok: false, reason: "forbidden" });
  });

  it("allows rental order participants for handover/return/report evidence", async () => {
    const orderAsset = {
      ...baseAsset,
      category: "HANDOVER",
      rentalOrder: { renterId: "user-renter", ownerId: "user-owner" },
    };
    assetFindFirst.mockResolvedValue(orderAsset);

    const renter = await resolvePrivateAssetAccess("asset-1", { id: "user-renter", role: "STUDENT" });
    expect(renter.ok).toBe(true);

    assetFindFirst.mockResolvedValue(orderAsset);
    const owner = await resolvePrivateAssetAccess("asset-1", { id: "user-owner", role: "STUDENT" });
    expect(owner.ok).toBe(true);
  });

  it("forbids order participants from unrelated private categories", async () => {
    assetFindFirst.mockResolvedValue({
      ...baseAsset,
      category: "VERIFICATION",
      rentalOrder: { renterId: "user-renter", ownerId: "user-owner" },
    });

    // 订单参与关系不能打开别人的学生证材料
    expect(
      await resolvePrivateAssetAccess("asset-1", { id: "user-renter", role: "STUDENT" }),
    ).toEqual({ ok: false, reason: "forbidden" });
  });

  it("signs a short-lived read url with the configured ttl", async () => {
    getSignedReadUrl.mockResolvedValue("http://localhost:9100/campus-private/signed?token=x");

    const result = await createPrivateAssetSignedUrl({
      bucket: "campus-private",
      objectKey: baseAsset.objectKey,
    });

    expect(result.url).toContain("token=x");
    expect(result.expiresIn).toBe(300);
    expect(getSignedReadUrl).toHaveBeenCalledWith(
      { bucket: "campus-private", objectKey: baseAsset.objectKey },
      300,
    );
  });
});

describe("AssetServiceError", () => {
  it("carries a stable code and http status", () => {
    const error = new AssetServiceError("QUOTA_EXCEEDED", "配额不足", 413);
    expect(error.code).toBe("QUOTA_EXCEEDED");
    expect(error.status).toBe(413);
    expect(error.message).toBe("配额不足");
  });
});
