import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * 真实数据库配额并发集成测试。
 *
 * 仅当 INTEGRATION_DATABASE_URL 指向已应用迁移的真实 PostgreSQL 时执行。
 * 验证：并发上传无法突破总配额（条件原子 UPDATE 串行化预留）、
 * S3 失败后配额完全回滚。
 *
 * 图片处理 mock 为固定大小（300KB）：本测试的焦点是 DB 侧的
 * 配额预留/释放语义，decode 与重编码已由单元测试覆盖。
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
      putObject: vi.fn(async ({ bucket, objectKey, body }: { bucket: string; objectKey: string; body: Buffer }) => {
        if (putObjectShouldFail) {
          throw new Error("simulated s3 outage");
        }
        memoryObjects.set(`${bucket}/${objectKey}`, body);
      }),
      deleteObject: vi.fn(async ({ bucket, objectKey }: { bucket: string; objectKey: string }) => {
        memoryObjects.delete(`${bucket}/${objectKey}`);
      }),
      getSignedReadUrl: vi.fn(async () => "http://signed.local/x"),
      headObject: vi.fn(async () => null),
    }),
  };
});

describe.skipIf(!integrationDatabaseUrl)("上传配额并发集成测试 (asset-quota)", () => {
  // 直接采用模块导出的（挂载软删除扩展的）客户端类型
  type PrismaModule = typeof import("@/lib/prisma");
  let prisma: PrismaModule["prisma"];
  let uploadImageAsset: typeof import("@/lib/asset-service").uploadImageAsset;
  let getStorageUsage: typeof import("@/lib/asset-service").getStorageUsage;
  let userId: string;
  let campusId: string;

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ uploadImageAsset, getStorageUsage } = await import("@/lib/asset-service"));

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
  });

  it("S3 故障时配额完整回滚，不留任何脏数据（CASE A）", async () => {
    // 重置计数，确保本用例能走到 S3 阶段（而非被配额前置拦截）
    await prisma.user.update({
      where: { id: userId },
      data: { storageUsedBytes: 0 },
    });
    putObjectShouldFail = true;
    const before = (await getStorageUsage(userId)).usedBytes;
    expect(before).toBe(0);

    await expect(
      uploadImageAsset({ userId, category: "product", file: buildFile() }),
    ).rejects.toMatchObject({ code: "STORAGE_UPLOAD_FAILED" });

    const after = (await getStorageUsage(userId)).usedBytes;
    expect(after).toBe(0);

    // 失败路径不得产生资源行
    const assets = await prisma.uploadedAsset.findMany({ where: { ownerId: userId } });
    // 上一轮成功的 3 条仍在，本轮失败不新增
    expect(assets).toHaveLength(3);
    putObjectShouldFail = false;
  });
});
