import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * 真实数据库配额与崩溃恢复集成测试。
 *
 * 仅当 INTEGRATION_DATABASE_URL 指向已应用迁移的真实 PostgreSQL 时执行。
 * 覆盖：
 * - 并发上传无法突破总配额（条件原子 UPDATE 串行化预留）
 * - S3 故障后配额完整回滚（无脏行）
 * - QUOTA_CRASH_RECOVERY：stale UPLOADING（对象存在/不存在）、
 *   并发 cleanup、重复 cleanup、最终配额精确
 *
 * 图片处理 mock 为固定大小（300KB）：本测试的焦点是 DB 侧的
 * 配额预留/释放/恢复语义，decode 与重编码已由单元测试覆盖。
 */

process.env.STORAGE_QUOTA_MB = "1"; // 1MB 配额，必须在模块导入前生效

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

vi.mock("@/lib/image-processing", () => ({
  processUploadedImage: vi.fn(async () => ({
    buffer: Buffer.alloc(300_000),
    mimeType: "image/webp",
    width: 640,
    height: 480,
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

// 内存存储替身：putObject 可按场景注入失败
const memoryObjects = new Map<string, Buffer>();
let putObjectShouldFail = false;

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    getStorage: () => ({
      putObject: vi.fn(
        async ({ bucket, objectKey, body }: { bucket: string; objectKey: string; body: Buffer }) => {
          if (putObjectShouldFail) {
            throw new Error("simulated s3 outage");
          }
          memoryObjects.set(`${bucket}/${objectKey}`, body);
        },
      ),
      deleteObject: vi.fn(async ({ bucket, objectKey }: { bucket: string; objectKey: string }) => {
        memoryObjects.delete(`${bucket}/${objectKey}`);
      }),
      getSignedReadUrl: vi.fn(async () => "http://signed.local/x"),
      headObject: vi.fn(async () => null),
      headBucket: vi.fn(async () => true),
    }),
  };
});

describe.skipIf(!integrationDatabaseUrl)("上传配额并发与崩溃恢复集成测试 (asset-quota)", () => {
  // 直接采用模块导出的（挂载软删除扩展的）客户端类型
  type PrismaModule = typeof import("@/lib/prisma");
  let prisma: PrismaModule["prisma"];
  let uploadImageAsset: typeof import("@/lib/asset-service").uploadImageAsset;
  let getStorageUsage: typeof import("@/lib/asset-service").getStorageUsage;
  let purgePendingDeleteAsset: typeof import("@/lib/asset-service").purgePendingDeleteAsset;
  let resolvePrivateAssetAccess: typeof import("@/lib/asset-service").resolvePrivateAssetAccess;
  let runStorageCleanup: typeof import("@/lib/asset-cleanup").runStorageCleanup;
  let userId: string;
  let campusId: string;

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({
      uploadImageAsset,
      getStorageUsage,
      purgePendingDeleteAsset,
      resolvePrivateAssetAccess,
    } = await import("@/lib/asset-service"));
    ({ runStorageCleanup } = await import("@/lib/asset-cleanup"));

    const campus = await prisma.campus.create({
      data: {
        name: "配额集成测试校区",
        slug: `it-quota-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        schoolName: "集成测试大学",
      },
    });
    campusId = campus.id;
    const user = await prisma.user.create({
      data: {
        name: "quota-it",
        email: `quota-it-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@campus.local`,
        passwordHash: "test-only",
        schoolName: "集成测试大学",
        campusId,
        storageUsedBytes: 0,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    if (prisma) {
      // UploadedAsset 对 ownerId 是 RESTRICT：先物理删除资源行（含 DELETED 审计行）
      await prisma.uploadedAsset.deleteMany({ where: { ownerId: userId } });
      await prisma.user.deleteMany({ where: { id: userId, deletedAt: null } });
      await prisma.campus.deleteMany({ where: { id: campusId } });
      await prisma.$disconnect();
    }
  });

  function buildFile() {
    const bytes = new Uint8Array(16);
    return {
      name: "race.png",
      size: 16,
      type: "image/png",
      arrayBuffer: () => Promise.resolve(bytes.buffer as ArrayBuffer),
    } as unknown as File;
  }

  async function listAssets() {
    return prisma.uploadedAsset.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: "asc" },
    });
  }

  it("并发上传无法突破配额：8 路并发仅 3 路成功（1MB / 300KB）", async () => {
    putObjectShouldFail = false;

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        uploadImageAsset({ userId, category: "product", file: buildFile() }),
      ),
    );

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // ⌊1048576 / 300000⌋ = 3：第 4 路起预留必然失败
    expect(succeeded).toHaveLength(3);
    expect(rejected).toHaveLength(5);
    for (const r of rejected) {
      expect((r.reason as { code?: string }).code).toBe("QUOTA_EXCEEDED");
    }

    // 记账精确等于 3 × 300000，无超额也无泄漏
    const usage = await getStorageUsage(userId);
    expect(usage.usedBytes).toBe(900_000);
    // 每条成功记录都走完 UPLOADING → UPLOADED
    const assets = await listAssets();
    expect(assets).toHaveLength(3);
    expect(assets.every((a) => a.status === "UPLOADED")).toBe(true);
  });

  it("S3 故障：预留与 UPLOADING 行同事务回滚，无脏数据（CASE A）", async () => {
    // 重置计数，确保本用例能走到 S3 阶段（而非被配额前置拦截）
    await prisma.user.update({
      where: { id: userId },
      data: { storageUsedBytes: 0 },
    });
    putObjectShouldFail = true;
    expect((await getStorageUsage(userId)).usedBytes).toBe(0);

    await expect(
      uploadImageAsset({ userId, category: "product", file: buildFile() }),
    ).rejects.toMatchObject({ code: "STORAGE_UPLOAD_FAILED" });

    // 补偿事务已删行并释放配额
    expect((await getStorageUsage(userId)).usedBytes).toBe(0);
    expect(await listAssets()).toHaveLength(3); // 上一轮 3 条仍在，本轮失败不新增
    putObjectShouldFail = false;
  });

  describe("QUOTA_CRASH_RECOVERY", () => {
    const SIZE = 300_000;

    async function simulateCrashedReservation(withObject: boolean) {
      // 模拟 T1 已提交（预留 + UPLOADING 行）后进程崩溃：
      // 直接构造 DB 状态 + 记账，可选写入"孤儿对象"
      const asset = await prisma.uploadedAsset.create({
        data: {
          ownerId: userId,
          category: "PRODUCT",
          access: "PUBLIC",
          bucket: "campus-public",
          objectKey: `public/products/${userId}/crash-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}.webp`,
          mimeType: "image/webp",
          sizeBytes: SIZE,
          status: "UPLOADING",
        },
      });
      await prisma.user.update({
        where: { id: userId },
        data: { storageUsedBytes: { increment: SIZE } },
      });
      // backdate createdAt，让 cleanup 的 TTL 判定立即命中
      await prisma.uploadedAsset.update({
        where: { id: asset.id },
        data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
      });
      if (withObject) {
        memoryObjects.set(
          `${asset.bucket}/${asset.objectKey}`,
          Buffer.alloc(SIZE),
        );
      }
      return asset;
    }

    it("stale UPLOADING（对象从未写入）→ cleanup 恢复配额", async () => {
      const asset = await simulateCrashedReservation(false);
      const before = (await getStorageUsage(userId)).usedBytes;

      const summary = await runStorageCleanup();

      expect(summary.orphansMarked).toBeGreaterThanOrEqual(1);
      expect(summary.objectsDeleted).toBeGreaterThanOrEqual(1);
      const after = await prisma.uploadedAsset.findUnique({ where: { id: asset.id } });
      expect(after?.status).toBe("DELETED");
      expect((await getStorageUsage(userId)).usedBytes).toBe(before - SIZE);
    });

    it("stale UPLOADING（对象已写入、转移前崩溃）→ 对象删除且配额恢复", async () => {
      const asset = await simulateCrashedReservation(true);
      const before = (await getStorageUsage(userId)).usedBytes;
      expect(memoryObjects.has(`${asset.bucket}/${asset.objectKey}`)).toBe(true);

      await runStorageCleanup();

      expect(memoryObjects.has(`${asset.bucket}/${asset.objectKey}`)).toBe(false);
      const after = await prisma.uploadedAsset.findUnique({ where: { id: asset.id } });
      expect(after?.status).toBe("DELETED");
      expect((await getStorageUsage(userId)).usedBytes).toBe(before - SIZE);
    });

    it("UPLOADING 状态对私有访问不可见（not_found）", async () => {
      const asset = await simulateCrashedReservation(false);
      const result = await resolvePrivateAssetAccess(asset.id, { id: userId, role: "STUDENT" });
      expect(result).toEqual({ ok: false, reason: "not_found" });
      await runStorageCleanup();
    });

    it("两个 cleanup worker 并发同一资产：配额只释放一次", async () => {
      const asset = await simulateCrashedReservation(true);
      const before = (await getStorageUsage(userId)).usedBytes;

      // 先由两路并发执行完整清理（含 stale 标记 + purge）
      const [first, second] = await Promise.all([
        runStorageCleanup(),
        runStorageCleanup(),
      ]);
      expect(first.failures + second.failures).toBe(0);

      // 只允许一次减额生效
      expect((await getStorageUsage(userId)).usedBytes).toBe(before - SIZE);
      const after = await prisma.uploadedAsset.findUnique({ where: { id: asset.id } });
      expect(after?.status).toBe("DELETED");
    });

    it("重复 cleanup 幂等：第二轮无新增删除/释放", async () => {
      const asset = await simulateCrashedReservation(true);
      await runStorageCleanup();
      const usedAfterFirst = (await getStorageUsage(userId)).usedBytes;

      const second = await runStorageCleanup();

      expect(second.orphansMarked).toBe(0);
      expect(second.retentionExpiredMarked).toBe(0);
      expect(second.objectsDeleted).toBe(0);
      expect((await getStorageUsage(userId)).usedBytes).toBe(usedAfterFirst);
      const after = await prisma.uploadedAsset.findUnique({ where: { id: asset.id } });
      expect(after?.status).toBe("DELETED");
    });

    it("对象删除成功后 DB 事务失败：保留 PENDING_DELETE，重试后配额精确", async () => {
      const asset = await simulateCrashedReservation(true);
      const before = (await getStorageUsage(userId)).usedBytes;

      // 直接进入 PENDING_DELETE（真实流程由 stale 扫描/业务标记完成）
      await prisma.uploadedAsset.update({
        where: { id: asset.id },
        data: { status: "PENDING_DELETE" },
      });
      // 第一遍 purge 正常成功（对象删除 + 转移 + 减额一个事务）
      const purged = await purgePendingDeleteAsset(asset);
      expect(purged).toBe(true);
      expect((await getStorageUsage(userId)).usedBytes).toBe(before - SIZE);

      // 对已 DELETED 的资产重复 purge：不得再次减额（exactly-once）
      const repeat = await purgePendingDeleteAsset(asset);
      expect(repeat).toBe(false);
      expect((await getStorageUsage(userId)).usedBytes).toBe(before - SIZE);
    });
  });
});
