import { S3Client } from "@aws-sdk/client-s3";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StorageClient, PutObjectInput } from "@/lib/storage/types";

// 故障边界在 StorageClient 层，图片 decode/重编码不在本测试焦点：
// mock 为固定小尺寸（与 asset-quota.test.ts 同模式）
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

/**
 * LR-071 / AMBIGUOUS_PUT_OUTCOME 真实 MinIO 故障注入集成测试。
 *
 * 故障注入在 StorageClient 边界（test-only 包装器）：
 * - AMBIGUOUS_REMOTE_COMMIT：真实 MinIO putObject 已把对象写入（远端提交
 *   成功），随后合成客户端异常——模拟"网络在 ACK 前断开"的歧义结果。
 *   这是 LR-071 的关键验收：PUT throw ≠ 远端对象不存在。
 * - PURE_OUTAGE：真实 S3Storage 指向无监听的隔离端口（远端提交前失败）。
 *
 * 验证（C3-C8）：
 * - 503 + 稳定 code（服务层合同）
 * - authoritative recovery row 保留（PENDING_DELETE）
 * - 配额不提前释放
 * - orphan candidate 远端对象存在性（真实 headObject）
 * - purge：对象删除 → DELETED 转移 + 配额释放 exactly-once
 * - 重复 purge 幂等（no double release）
 *
 * 真实依赖：INTEGRATION_DATABASE_URL（PostgreSQL）+ INTEGRATION_S3_ENDPOINT
 * （本地/CI MinIO）。隔离：唯一测试 user + 唯一 object key 前缀；不触碰
 * 共享 bucket 中的任何其他对象。
 */

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const endpoint = process.env.INTEGRATION_S3_ENDPOINT;

process.env.STORAGE_QUOTA_MB = process.env.STORAGE_QUOTA_MB ?? "500";

const s3Config = {
  endpoint,
  region: "us-east-1" as const,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.INTEGRATION_S3_ACCESS_KEY_ID ?? "minioadmin",
    secretAccessKey: process.env.INTEGRATION_S3_SECRET_ACCESS_KEY ?? "minioadmin",
  },
};

/** 找一个当前无监听的端口构造不可达端点（提交前故障） */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
    server.on("error", reject);
  });
}

class AmbiguousPutStorage implements StorageClient {
  lastPut: { bucket: string; objectKey: string } | null = null;
  /** 模拟"存储仍不可用"：为 true 时 DeleteObject 也失败（恢复只能靠后续 cleanup） */
  deleteShouldFail = false;

  constructor(private readonly real: StorageClient) {}

  async putObject(input: PutObjectInput): Promise<void> {
    // 远端真实提交成功（对象真实写入 MinIO），然后合成客户端错误
    await this.real.putObject(input);
    this.lastPut = { bucket: input.bucket, objectKey: input.objectKey };
    throw new Error("connection reset after remote commit (synthetic)");
  }

  headBucket(bucket: string) {
    return this.real.headBucket(bucket);
  }
  async deleteObject(ref: Parameters<StorageClient["deleteObject"]>[0]) {
    if (this.deleteShouldFail) {
      throw new Error("storage still down (synthetic)");
    }
    return this.real.deleteObject(ref);
  }
  headObject(ref: Parameters<StorageClient["headObject"]>[0]) {
    return this.real.headObject(ref);
  }
  getObject(ref: Parameters<StorageClient["getObject"]>[0]) {
    return this.real.getObject(ref);
  }
  getSignedReadUrl(...args: Parameters<StorageClient["getSignedReadUrl"]>) {
    return this.real.getSignedReadUrl(...args);
  }
}

describe.skipIf(!integrationDatabaseUrl || !endpoint)(
  "LR-071 存储故障合同（真实 MinIO + 真实 PostgreSQL）",
  () => {
    type StorageModule = typeof import("@/lib/storage");
    type AssetServiceModule = typeof import("@/lib/asset-service");
    type PrismaModule = typeof import("@/lib/prisma");

    let prisma: PrismaModule["prisma"];
    let uploadImageAsset: AssetServiceModule["uploadImageAsset"];
    let purgePendingDeleteAsset: AssetServiceModule["purgePendingDeleteAsset"];
    let getStorageUsage: AssetServiceModule["getStorageUsage"];
    let setStorageForTests: StorageModule["setStorageForTests"];
    let realStorage: StorageClient;

    let userId: string;
    let campusId: string;
    const leftoverObjects: Array<{ bucket: string; objectKey: string }> = [];

    beforeAll(async () => {
      if (!process.env.DATABASE_URL) {
        process.env.DATABASE_URL = integrationDatabaseUrl;
      }
      const { S3Storage } = await import("@/lib/storage/s3-storage");
      realStorage = new S3Storage(new S3Client(s3Config));

      ({ prisma } = await import("@/lib/prisma"));
      ({
        uploadImageAsset,
        purgePendingDeleteAsset,
        getStorageUsage,
      } = await import("@/lib/asset-service"));
      ({ setStorageForTests } = (await import("@/lib/storage")) as StorageModule);

      const campus = await prisma.campus.create({
        data: {
          name: "存储故障集成测试校区",
          slug: `it-lr071-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          schoolName: "集成测试大学",
        },
      });
      campusId = campus.id;
      const user = await prisma.user.create({
        data: {
          name: "lr071-it",
          email: `lr071-it-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@campus.local`,
          passwordHash: "test-only",
          schoolName: "集成测试大学",
          campusId,
          storageUsedBytes: 0,
        },
      });
      userId = user.id;
    });

    afterAll(async () => {
      // 清理测试对象（隔离前缀：userId 下）与 DB 行
      for (const ref of leftoverObjects) {
        await realStorage.deleteObject(ref).catch(() => undefined);
      }
      if (prisma) {
        await prisma.uploadedAsset.deleteMany({ where: { ownerId: userId } });
        await prisma.user.deleteMany({ where: { id: userId, deletedAt: null } });
        await prisma.campus.deleteMany({ where: { id: campusId } });
        await prisma.$disconnect();
      }
      setStorageForTests(null);
    });

    function buildFile() {
      const bytes = new Uint8Array(16);
      return {
        name: "fault.png",
        size: 16,
        type: "image/png",
        arrayBuffer: () => Promise.resolve(bytes.buffer as ArrayBuffer),
      } as unknown as File;
    }

    it("AMBIGUOUS_REMOTE_COMMIT：远端已写入 + client 错误 → 503，恢复行保留，配额不释放，purge 后 exactly-once 释放", async () => {
      const faultStorage = new AmbiguousPutStorage(realStorage);
      // 存储持续不可用：立即 purge 的 DeleteObject 也失败（中间态可观测）
      faultStorage.deleteShouldFail = true;
      setStorageForTests(faultStorage);

      // 远端提交成功但 client 观察到异常
      await expect(
        uploadImageAsset({ userId, category: "product", file: buildFile() }),
      ).rejects.toMatchObject({
        code: "STORAGE_UPLOAD_FAILED",
        status: 503,
      });

      // authoritative recovery row 保留（绝不删行），停留 PENDING_DELETE
      const row = await prisma.uploadedAsset.findFirst({
        where: { ownerId: userId },
        orderBy: { createdAt: "desc" },
      });
      expect(row).not.toBeNull();
      expect(row!.status).toBe("PENDING_DELETE");

      // 配额未提前释放（PUT throw ≠ 远端对象不存在）
      expect((await getStorageUsage(userId)).usedBytes).toBe(row!.sizeBytes);

      // 远端 orphan candidate 真实存在（权威 headObject 证据）
      expect(faultStorage.lastPut).toEqual({ bucket: row!.bucket, objectKey: row!.objectKey });
      expect(await realStorage.headObject({ bucket: row!.bucket, objectKey: row!.objectKey }))
        .not.toBeNull();
      leftoverObjects.push({ bucket: row!.bucket, objectKey: row!.objectKey });

      // 存储恢复（DeleteObject 可用）→ cleanup 原语完成回收
      faultStorage.deleteShouldFail = false;
      const purged = await purgePendingDeleteAsset({
        id: row!.id,
        ownerId: row!.ownerId,
        bucket: row!.bucket,
        objectKey: row!.objectKey,
        sizeBytes: row!.sizeBytes,
      });
      expect(purged).toBe(true);

      // 对象真实消失
      expect(await realStorage.headObject({ bucket: row!.bucket, objectKey: row!.objectKey }))
        .toBeNull();
      // DELETED 转移 + 配额 exactly-once 释放
      const afterRow = await prisma.uploadedAsset.findUnique({ where: { id: row!.id } });
      expect(afterRow!.status).toBe("DELETED");
      expect((await getStorageUsage(userId)).usedBytes).toBe(0);

      // 重复 cleanup 幂等：条件转移不再命中，不二次释放
      const repeat = await purgePendingDeleteAsset({
        id: row!.id,
        ownerId: row!.ownerId,
        bucket: row!.bucket,
        objectKey: row!.objectKey,
        sizeBytes: row!.sizeBytes,
      });
      expect(repeat).toBe(false);
      expect((await getStorageUsage(userId)).usedBytes).toBe(0);
    });

    it("PURE_OUTAGE（提交前失败）：503，PENDING_DELETE 保留，存储恢复后 purge 完成回收", async () => {
      const outagePort = await findFreePort();
      const { S3Storage } = await import("@/lib/storage/s3-storage");
      const outageStorage = new S3Storage(
        new S3Client({
          ...s3Config,
          endpoint: `http://localhost:${outagePort}`,
        }),
      );
      setStorageForTests(outageStorage);

      await expect(
        uploadImageAsset({ userId, category: "product", file: buildFile() }),
      ).rejects.toMatchObject({ code: "STORAGE_UPLOAD_FAILED", status: 503 });

      const row = await prisma.uploadedAsset.findFirst({
        where: { ownerId: userId },
        orderBy: { createdAt: "desc" },
      });
      expect(row).not.toBeNull();
      expect(row!.status).toBe("PENDING_DELETE");
      expect((await getStorageUsage(userId)).usedBytes).toBe(row!.sizeBytes);

      // 存储恢复后（切回真实 MinIO），cleanup 原语完成回收
      setStorageForTests(realStorage);
      const purged = await purgePendingDeleteAsset({
        id: row!.id,
        ownerId: row!.ownerId,
        bucket: row!.bucket,
        objectKey: row!.objectKey,
        sizeBytes: row!.sizeBytes,
      });
      expect(purged).toBe(true);
      expect((await getStorageUsage(userId)).usedBytes).toBe(0);
      const afterRow = await prisma.uploadedAsset.findUnique({ where: { id: row!.id } });
      expect(afterRow!.status).toBe("DELETED");
    });
  },
);
