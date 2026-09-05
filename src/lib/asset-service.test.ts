import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  putObject,
  deleteObject,
  getObject,
  getSignedReadUrl,
  headBucket,
  executeRaw,
  assetCreate,
  assetFindFirst,
  assetUpdateMany,
  assetDeleteMany,
  userFindUnique,
  transactionMock,
  loadAuthorizationContextMock,
  campusMembershipFindFirstMock,
} = vi.hoisted(() => ({
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  getObject: vi.fn(),
  getSignedReadUrl: vi.fn(),
  headBucket: vi.fn(),
  executeRaw: vi.fn(),
  assetCreate: vi.fn(),
  assetFindFirst: vi.fn(),
  assetUpdateMany: vi.fn(),
  assetDeleteMany: vi.fn(),
  userFindUnique: vi.fn(),
  transactionMock: vi.fn(),
  loadAuthorizationContextMock: vi.fn(),
  campusMembershipFindFirstMock: vi.fn(),
}));

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    getStorage: () => ({
      putObject,
      deleteObject,
      getSignedReadUrl,
      getObject,
      headBucket,
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
    $transaction: transactionMock,
    uploadedAsset: {
      create: assetCreate,
      findFirst: assetFindFirst,
      updateMany: assetUpdateMany,
      deleteMany: assetDeleteMany,
    },
    user: { findUnique: userFindUnique },
    campusMembership: { findFirst: campusMembershipFindFirstMock },
  },
}));

// hasPermission 用真实实现（纯函数），只替换 context 加载——权限路径测试基于
// 真实 DEFAULT_DENY 语义而不是 mock 的结论
vi.mock("@/lib/rbac/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rbac/service")>();
  return {
    ...actual,
    loadAuthorizationContext: loadAuthorizationContextMock,
  };
});

import type { UploadedAsset } from "@prisma/client";
import type { AuthorizationContext } from "@/lib/rbac/service";
import {
  ATTACH_COMPATIBILITY,
  AssetServiceError,
  attachAssetsToEntity,
  isAssetCompatibleWithTarget,
  isSameAttachment,
  markAssetPendingDelete,
  markAssetsForValuesPendingDelete,
  purgePendingDeleteAsset,
  quotaBytes,
  readPrivateAssetObject,
  resolveImageTokens,
  resolvePrivateAssetAccess,
  uploadImageAsset,
  PRIVATE_OBJECT_CACHE_CONTROL,
  PUBLIC_OBJECT_CACHE_CONTROL,
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

/** 事务客户端桩：T1 预留事务直接透传 $executeRaw / uploadedAsset 委托 */
const txStub = {
  $executeRaw: executeRaw,
  uploadedAsset: {
    create: assetCreate,
    updateMany: assetUpdateMany,
    deleteMany: assetDeleteMany,
    findFirst: assetFindFirst,
  },
} as unknown as Parameters<typeof attachAssetsToEntity>[0];

const baseAsset: UploadedAsset & {
  rentalOrder: { renterId: string; ownerId: string } | null;
} = {
  id: "asset-1",
  ownerId: "user-1",
  category: "VERIFICATION",
  access: "PRIVATE",
  bucket: "campus-private",
  objectKey: "private/verification/user-1/abcd1234.webp",
  mimeType: "image/webp",
  sizeBytes: 1024,
  width: 64,
  height: 48,
  originalFileName: null,
  status: "UPLOADED",
  productId: null,
  rentalListingId: null,
  serviceListingId: null,
  rentalOrderId: null,
  verificationId: null,
  attachedAt: null,
  expiresAt: null,
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
  rentalOrder: null,
};

/** 以指定类别/状态派生测试资产 */
function assetWith(overrides: Partial<UploadedAsset>): UploadedAsset {
  return { ...baseAsset, ...overrides };
}

describe("uploadImageAsset（可恢复状态机）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeRaw.mockResolvedValue(1);
    putObject.mockResolvedValue(undefined);
    deleteObject.mockResolvedValue(undefined);
    assetCreate.mockResolvedValue({ id: "asset-1" });
    assetUpdateMany.mockResolvedValue({ count: 1 });
    assetDeleteMany.mockResolvedValue({ count: 1 });
    // T1：交互事务直接以 txStub 执行回调
    transactionMock.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => callback(txStub),
    );
  });

  it("uploads a public image with long-lived public cache control", async () => {
    const result = await uploadImageAsset({
      userId: "user-1",
      category: "product",
      file: buildImageFile(),
    });

    expect(result.assetId).toBe("asset-1");
    expect(result.access).toBe("PUBLIC");
    expect(result.url).toMatch(/^http:\/\/localhost:9100\/campus-public\/public\/products\//);
    expect(result.sizeBytes).toBe(1024);

    // T1：配额预留与 UPLOADING 行创建在同一事务
    expect(assetCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "UPLOADING", objectKey: expect.any(String) }),
      }),
    );
    // 公开对象：长期 public immutable 缓存
    expect(putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "campus-public",
        cacheControl: PUBLIC_OBJECT_CACHE_CONTROL,
        contentType: "image/webp",
      }),
    );
    // S3 PUT 成功后条件转移 UPLOADED
    expect(assetUpdateMany).toHaveBeenCalledWith({
      where: { id: "asset-1", status: "UPLOADING" },
      data: { status: "UPLOADED" },
    });
  });

  it("uploads a private image with no-store cache control and no permanent url", async () => {
    const result = await uploadImageAsset({
      userId: "user-1",
      category: "verification",
      file: buildImageFile(),
    });

    expect(result.access).toBe("PRIVATE");
    expect(result.url).toBeNull();
    // 私有对象：禁止任何缓存存储
    expect(putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "campus-private",
        cacheControl: PRIVATE_OBJECT_CACHE_CONTROL,
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

  it("rejects with QUOTA_EXCEEDED when the reservation matches no row", async () => {
    executeRaw.mockResolvedValue(0);

    await expect(
      uploadImageAsset({ userId: "user-1", category: "product", file: buildImageFile() }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", status: 413 });
    // 预留失败时行不允许创建（事务回滚语义由 mock 委托透传，这里断言未创建）
    expect(assetCreate).not.toHaveBeenCalled();
    expect(putObject).not.toHaveBeenCalled();
  });

  it("T1 失败（配额+建行同事务）：整体失败且无 S3 副作用", async () => {
    assetCreate.mockRejectedValue(new Error("db down"));

    await expect(
      uploadImageAsset({ userId: "user-1", category: "product", file: buildImageFile() }),
    ).rejects.toMatchObject({ code: "ASSET_RECORD_FAILED", status: 500 });
    expect(putObject).not.toHaveBeenCalled();
  });

  it("S3 PUT 失败：补偿删除 UPLOADING 行并释放配额（CASE A）", async () => {
    putObject.mockRejectedValue(new Error("connection reset"));

    await expect(
      uploadImageAsset({ userId: "user-1", category: "product", file: buildImageFile() }),
    ).rejects.toMatchObject({ code: "STORAGE_UPLOAD_FAILED", status: 500 });

    // 补偿事务：删除 UPLOADING 行 + 释放配额（同一事务）
    expect(assetDeleteMany).toHaveBeenCalledWith({
      where: { id: "asset-1", status: "UPLOADING" },
    });
    expect(executeRaw).toHaveBeenCalledTimes(2); // 预留 + 释放
    expect(assetUpdateMany).not.toHaveBeenCalled(); // 未进入 UPLOADED
  });

  it("S3 成功但状态转移失败：报错且资源停留 UPLOADING 等待 cleanup", async () => {
    assetUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      uploadImageAsset({ userId: "user-1", category: "product", file: buildImageFile() }),
    ).rejects.toMatchObject({ code: "ASSET_RECORD_FAILED", status: 500 });
    // 不做即时删除（对象已存在），由 stale UPLOADING cleanup 恢复
    expect(assetDeleteMany).not.toHaveBeenCalled();
  });

  it("reflects the configured default quota (500MB)", () => {
    expect(quotaBytes()).toBe(500 * 1024 * 1024);
  });
});

describe("attach compatibility mapping", () => {
  it("maps every category to exactly its semantic target(s)", () => {
    expect(ATTACH_COMPATIBILITY.AVATAR).toEqual(["avatar"]);
    expect(ATTACH_COMPATIBILITY.PRODUCT).toEqual(["product"]);
    expect(ATTACH_COMPATIBILITY.RENTAL).toEqual(["rentalListing"]);
    expect(ATTACH_COMPATIBILITY.SERVICE).toEqual(["serviceListing"]);
    expect(ATTACH_COMPATIBILITY.VERIFICATION).toEqual(["verification"]);
    expect(ATTACH_COMPATIBILITY.HANDOVER).toEqual(["rentalOrder"]);
    expect(ATTACH_COMPATIBILITY.RETURN).toEqual(["rentalOrder"]);
    expect(ATTACH_COMPATIBILITY.REPORT).toEqual(["rentalOrder"]);
  });

  it("cross-category usage is rejected (helpers)", () => {
    expect(isAssetCompatibleWithTarget("AVATAR", { type: "product", id: "p1" })).toBe(false);
    expect(isAssetCompatibleWithTarget("PRODUCT", { type: "verification", id: "v1" })).toBe(false);
    expect(isAssetCompatibleWithTarget("VERIFICATION", { type: "avatar" })).toBe(false);
    expect(isAssetCompatibleWithTarget("HANDOVER", { type: "product", id: "p1" })).toBe(false);
    expect(isAssetCompatibleWithTarget("RETURN", { type: "serviceListing", id: "s1" })).toBe(false);
    expect(isAssetCompatibleWithTarget("PRODUCT", { type: "product", id: "p1" })).toBe(true);
  });

  it("isSameAttachment matches the exact entity", () => {
    const attached = assetWith({ category: "PRODUCT", productId: "product-A" });
    expect(isSameAttachment(attached, { type: "product", id: "product-A" })).toBe(true);
    expect(isSameAttachment(attached, { type: "product", id: "product-B" })).toBe(false);
    expect(
      isSameAttachment(assetWith({ category: "AVATAR" }), { type: "avatar" }),
    ).toBe(true);
  });
});

describe("resolveImageTokens（授权绑定）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assetUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("claims only the owner's UPLOADED assets (conditional update)", async () => {
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

  it("attaches a compatible owned asset and keeps foreign urls untouched", async () => {
    assetFindFirst.mockResolvedValue({
      ...baseAsset,
      category: "PRODUCT",
      access: "PUBLIC",
      objectKey: "public/products/user-1/xyz.webp",
    });

    const resolved = await resolveImageTokens({
      ownerId: "user-1",
      tokens: ["asset:asset-1", "https://cdn.example.com/external.jpg", "  "],
      target: { type: "product", id: "product-9" },
    });

    expect(resolved).toEqual([
      "http://localhost:9100/campus-public/public/products/user-1/xyz.webp",
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
        target: { type: "verification", id: "verification-1" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ASSET_REFERENCE" });
  });

  it("rejects malformed asset: tokens instead of passing them through", async () => {
    for (const malformed of [
      "asset:***",
      "asset:..",
      "asset:/",
      "asset: ",
      `asset:${"x".repeat(80)}`,
      "asset:%2f..%2fetc",
    ]) {
      await expect(
        resolveImageTokens({
          ownerId: "user-1",
          tokens: [malformed],
          target: { type: "product", id: "product-9" },
        }),
        `token: ${JSON.stringify(malformed)}`,
      ).rejects.toMatchObject({ code: "INVALID_ASSET_REFERENCE" });
    }
    expect(assetFindFirst).not.toHaveBeenCalled();
  });

  it("rejects category mismatches with a stable error code", async () => {
    // PRODUCT 资产用于 verification 目标
    assetFindFirst.mockResolvedValue({
      ...baseAsset,
      category: "PRODUCT",
      access: "PUBLIC",
    });

    await expect(
      resolveImageTokens({
        ownerId: "user-1",
        tokens: ["asset:asset-1"],
        target: { type: "verification", id: "verification-1" },
      }),
    ).rejects.toMatchObject({ code: "ASSET_CATEGORY_MISMATCH" });

    // AVATAR 资产用于 product 目标
    assetFindFirst.mockResolvedValue({ ...baseAsset, category: "AVATAR", access: "PUBLIC" });
    await expect(
      resolveImageTokens({
        ownerId: "user-1",
        tokens: ["asset:asset-1"],
        target: { type: "product", id: "product-9" },
      }),
    ).rejects.toMatchObject({ code: "ASSET_CATEGORY_MISMATCH" });

    // HANDOVER（订单证据）用于 product 目标
    assetFindFirst.mockResolvedValue({ ...baseAsset, category: "HANDOVER" });
    await expect(
      resolveImageTokens({
        ownerId: "user-1",
        tokens: ["asset:asset-1"],
        target: { type: "product", id: "product-9" },
      }),
    ).rejects.toMatchObject({ code: "ASSET_CATEGORY_MISMATCH" });
  });

  it("same-entity ATTACHED asset is idempotently reusable", async () => {
    assetFindFirst.mockResolvedValue({
      ...baseAsset,
      category: "PRODUCT",
      access: "PUBLIC",
      status: "ATTACHED",
      productId: "product-9",
      objectKey: "public/products/user-1/xyz.webp",
    });

    const [resolved] = await resolveImageTokens({
      ownerId: "user-1",
      tokens: ["asset:asset-1"],
      target: { type: "product", id: "product-9" },
    });

    expect(resolved).toBe("http://localhost:9100/campus-public/public/products/user-1/xyz.webp");
    // 幂等复用不再次转移状态
    expect(assetUpdateMany).not.toHaveBeenCalled();
  });

  it("ATTACHED asset cannot be reused for a different entity (even same owner)", async () => {
    assetFindFirst.mockResolvedValue({
      ...baseAsset,
      category: "PRODUCT",
      status: "ATTACHED",
      productId: "product-A",
    });

    await expect(
      resolveImageTokens({
        ownerId: "user-1",
        tokens: ["asset:asset-1"],
        target: { type: "product", id: "product-B" },
      }),
    ).rejects.toMatchObject({ code: "ASSET_ALREADY_ATTACHED" });
  });

  it("private assets cannot migrate across entities (verification → rentalOrder)", async () => {
    assetFindFirst.mockResolvedValue({
      ...baseAsset,
      status: "ATTACHED",
      verificationId: "verification-A",
    });

    await expect(
      resolveImageTokens({
        ownerId: "user-1",
        tokens: ["asset:asset-1"],
        target: { type: "rentalOrder", id: "order-B" },
      }),
    ).rejects.toMatchObject({ code: "ASSET_CATEGORY_MISMATCH" });
  });

  it("rejects deleted / pending-delete / uploading assets", async () => {
    for (const status of ["DELETED", "PENDING_DELETE", "UPLOADING"] as const) {
      assetFindFirst.mockResolvedValue({ ...baseAsset, status });
      await expect(
        resolveImageTokens({
          ownerId: "user-1",
          tokens: ["asset:asset-1"],
          target: { type: "verification", id: "verification-1" },
        }),
        `status: ${status}`,
      ).rejects.toMatchObject({ code: "INVALID_ASSET_REFERENCE" });
    }
  });
});

describe("delete lifecycle（exactly-once 配额）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteObject.mockResolvedValue(undefined);
    assetUpdateMany.mockResolvedValue({ count: 1 });
    executeRaw.mockResolvedValue(1);
    transactionMock.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => callback(txStub),
    );
  });

  it("marks pending delete idempotently", async () => {
    assetUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    expect(await markAssetPendingDelete("asset-1")).toBe(true);
    expect(await markAssetPendingDelete("asset-1")).toBe(false);
  });

  it("purges: S3 delete → 单事务 [DELETED 转移 + 配额减额]", async () => {
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
    // 转移与减额在同一事务（executeRaw 在 transactionMock 回调内被调用）
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
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("does not release quota when the DELETED transition loses the race", async () => {
    // 并发 cleanup：条件转移匹配 0 行（对方已完成）
    assetUpdateMany.mockResolvedValue({ count: 0 });

    const purged = await purgePendingDeleteAsset({
      id: "asset-1",
      ownerId: "user-1",
      bucket: "campus-private",
      objectKey: baseAsset.objectKey,
      sizeBytes: 1024,
    });

    expect(purged).toBe(false);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("transaction failure keeps PENDING_DELETE for the next run", async () => {
    transactionMock.mockRejectedValue(new Error("db down"));

    const purged = await purgePendingDeleteAsset({
      id: "asset-1",
      ownerId: "user-1",
      bucket: "campus-private",
      objectKey: baseAsset.objectKey,
      sizeBytes: 1024,
    });

    expect(purged).toBe(false);
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
  const activeNoGrants: AuthorizationContext = {
    userId: "caller-1",
    accountActive: true,
    activeMembership: null,
    grants: [],
  };

  function ctxWith(
    grants: AuthorizationContext["grants"],
    active = true,
  ): AuthorizationContext {
    return {
      userId: "caller-1",
      accountActive: active,
      activeMembership: null,
      grants,
    };
  }

  const globalSensitiveGrant: AuthorizationContext["grants"][number] = {
    roleKey: "PLATFORM_ADMIN",
    scope: "GLOBAL",
    campusId: null,
    permissionKeys: ["asset.sensitive.read"],
  };

  function campusScopedGrant(campusId: string): AuthorizationContext["grants"][number] {
    return {
      roleKey: "CAMPUS_REVIEWER",
      scope: "CAMPUS",
      campusId,
      permissionKeys: ["asset.sensitive.read"],
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    loadAuthorizationContextMock.mockResolvedValue(activeNoGrants);
    campusMembershipFindFirstMock.mockResolvedValue(null);
  });

  it("returns not_found for missing, deleted, pending-delete or uploading assets", async () => {
    assetFindFirst.mockResolvedValueOnce(null);
    assetFindFirst.mockResolvedValueOnce({ ...baseAsset, status: "DELETED" });
    assetFindFirst.mockResolvedValueOnce({ ...baseAsset, status: "PENDING_DELETE" });
    assetFindFirst.mockResolvedValueOnce({ ...baseAsset, status: "UPLOADING" });

    const stranger = { id: "user-2" };
    for (let i = 0; i < 4; i += 1) {
      expect(await resolvePrivateAssetAccess("asset-1", stranger)).toEqual({
        ok: false,
        reason: "not_found",
      });
    }
  });

  it("returns not_private for public assets", async () => {
    assetFindFirst.mockResolvedValue({ ...baseAsset, access: "PUBLIC" });

    expect(await resolvePrivateAssetAccess("asset-1", { id: "user-2" })).toEqual({
      ok: false,
      reason: "not_private",
    });
  });

  it("returns expired when the retention deadline has passed", async () => {
    assetFindFirst.mockResolvedValue({
      ...baseAsset,
      expiresAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect(await resolvePrivateAssetAccess("asset-1", { id: "user-1" })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("allows the owner regardless of category（账号 active）", async () => {
    assetFindFirst.mockResolvedValue(baseAsset);

    const owner = await resolvePrivateAssetAccess("asset-1", { id: "user-1" });
    expect(owner.ok).toBe(true);
    if (owner.ok) {
      expect(owner.grantedBy).toBe("owner");
    }
  });

  it("forbids owner access when the account is inactive（fail closed）", async () => {
    assetFindFirst.mockResolvedValue(baseAsset);
    loadAuthorizationContextMock.mockResolvedValue(ctxWith([globalSensitiveGrant], false));

    expect(await resolvePrivateAssetAccess("asset-1", { id: "user-1" })).toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it("forbids when the authorization context cannot be loaded（账号不存在）", async () => {
    assetFindFirst.mockResolvedValue(baseAsset);
    loadAuthorizationContextMock.mockResolvedValue(null);

    expect(await resolvePrivateAssetAccess("asset-1", { id: "ghost" })).toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it("forbids strangers without any permission grant（DEFAULT_DENY）", async () => {
    assetFindFirst.mockResolvedValue({ ...baseAsset, category: "VERIFICATION" });

    expect(await resolvePrivateAssetAccess("asset-1", { id: "user-2" })).toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it("grants governance access via global asset.sensitive.read（取代旧 role 判定）", async () => {
    assetFindFirst.mockResolvedValue({ ...baseAsset, category: "VERIFICATION" });
    loadAuthorizationContextMock.mockResolvedValue(ctxWith([globalSensitiveGrant]));

    const granted = await resolvePrivateAssetAccess("asset-1", { id: "reviewer-1" });
    expect(granted.ok).toBe(true);
    if (granted.ok) {
      expect(granted.grantedBy).toBe("permission");
    }
  });

  it("denies users holding unrelated permissions（非 asset.sensitive.read）", async () => {
    assetFindFirst.mockResolvedValue({ ...baseAsset, category: "VERIFICATION" });
    loadAuthorizationContextMock.mockResolvedValue(
      ctxWith([
        {
          roleKey: "PLATFORM_ADMIN",
          scope: "GLOBAL",
          campusId: null,
          permissionKeys: ["report.review"],
        },
      ]),
    );

    expect(await resolvePrivateAssetAccess("asset-1", { id: "reviewer-1" })).toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it("grants campus-scoped access only within the asset's campus", async () => {
    assetFindFirst.mockResolvedValue({
      ...baseAsset,
      category: "VERIFICATION",
      verification: { membership: { campusId: "campus-a" } },
    });
    loadAuthorizationContextMock.mockResolvedValue(ctxWith([campusScopedGrant("campus-a")]));

    const granted = await resolvePrivateAssetAccess("asset-1", { id: "reviewer-a" });
    expect(granted.ok).toBe(true);
  });

  it("denies cross-campus reviewers（关键安全不变量 negative test）", async () => {
    assetFindFirst.mockResolvedValue({
      ...baseAsset,
      category: "VERIFICATION",
      verification: { membership: { campusId: "campus-b" } },
    });
    loadAuthorizationContextMock.mockResolvedValue(ctxWith([campusScopedGrant("campus-a")]));

    expect(await resolvePrivateAssetAccess("asset-1", { id: "reviewer-a" })).toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it("falls back to the owner's active membership campus when the asset has no binding", async () => {
    assetFindFirst.mockResolvedValue({
      ...baseAsset,
      category: "AVATAR",
      verification: null,
      rentalOrder: null,
      rentalListing: null,
      product: null,
      serviceListing: null,
    });
    loadAuthorizationContextMock.mockResolvedValue(ctxWith([campusScopedGrant("campus-a")]));
    campusMembershipFindFirstMock.mockResolvedValue({ campusId: "campus-a" });

    const granted = await resolvePrivateAssetAccess("asset-1", { id: "reviewer-a" });
    expect(granted.ok).toBe(true);

    // 校区不可解析 + 仅 campus-scoped 授权 → DENY
    campusMembershipFindFirstMock.mockResolvedValue(null);
    assetFindFirst.mockResolvedValue({
      ...baseAsset,
      category: "AVATAR",
      verification: null,
      rentalOrder: null,
      rentalListing: null,
      product: null,
      serviceListing: null,
    });
    expect(await resolvePrivateAssetAccess("asset-1", { id: "reviewer-a" })).toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it("allows rental order participants for handover/return/report evidence", async () => {
    const orderAsset = {
      ...baseAsset,
      category: "HANDOVER",
      rentalOrder: {
        renterId: "user-renter",
        ownerId: "user-owner",
        rentalListing: { campusId: "campus-a" },
      },
    };
    assetFindFirst.mockResolvedValue(orderAsset);

    const renter = await resolvePrivateAssetAccess("asset-1", { id: "user-renter" });
    expect(renter.ok).toBe(true);
    if (renter.ok) {
      expect(renter.grantedBy).toBe("order_participant");
    }

    assetFindFirst.mockResolvedValue(orderAsset);
    const owner = await resolvePrivateAssetAccess("asset-1", { id: "user-owner" });
    expect(owner.ok).toBe(true);
  });

  it("forbids order participants from unrelated private categories", async () => {
    assetFindFirst.mockResolvedValue({
      ...baseAsset,
      category: "VERIFICATION",
      rentalOrder: {
        renterId: "user-renter",
        ownerId: "user-owner",
        rentalListing: { campusId: "campus-a" },
      },
    });

    expect(await resolvePrivateAssetAccess("asset-1", { id: "user-renter" })).toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it("readPrivateAssetObject：owner 授权后由 server 经内部凭据读取对象内容", async () => {
    const body = Buffer.from("private-evidence");
    getObject.mockResolvedValue({
      body,
      contentType: "image/jpeg",
      sizeBytes: body.byteLength,
    });

    const result = await readPrivateAssetObject("asset-1", { id: "user-1" });

    expect(result).toMatchObject({
      ok: true,
      grantedBy: "owner",
      category: "VERIFICATION",
    });
    expect(getObject).toHaveBeenCalledWith({
      bucket: baseAsset.bucket,
      objectKey: baseAsset.objectKey,
    });
  });

  it("readPrivateAssetObject：对象缺失按 not_found 处理（不泄露存储细节）", async () => {
    getObject.mockResolvedValue(null);

    expect(await readPrivateAssetObject("asset-1", { id: "user-1" })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("readPrivateAssetObject：未授权与过期不触发对象读取", async () => {
    assetFindFirst.mockResolvedValue({ ...baseAsset, category: "VERIFICATION" });

    expect(await readPrivateAssetObject("asset-1", { id: "user-2" })).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(getObject).not.toHaveBeenCalled();

    assetFindFirst.mockResolvedValue({
      ...baseAsset,
      expiresAt: new Date("2026-01-01T00:00:00Z"),
    });
    expect(await readPrivateAssetObject("asset-1", { id: "user-1" })).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(getObject).not.toHaveBeenCalled();
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
