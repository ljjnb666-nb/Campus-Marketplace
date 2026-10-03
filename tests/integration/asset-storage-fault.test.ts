import { S3Client } from "@aws-sdk/client-s3";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// 一次性隔离数据库生命周期辅助（与 production-cleanup-worker 套件同模式）
import { runPrismaCommand } from "../../scripts/resilience/spawn-worker.mjs";
import { createBoundedS3Client } from "@/lib/storage/s3-client-policy";
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

/**
 * R3-05 / RESPONSE_LOST_AFTER_COMMIT 故障注入（transport 级，真实 socket）：
 * - PUT：请求原样转发给真实 MinIO（对象【真实提交】），但吞掉 MinIO 响应并
 *   在响应头完整到达后销毁客户端连接——client 观察到连接错误而远端对象已
 *   存在。这是比应用层合成 throw 更强的 LR-071 歧义证据。
 * - DELETE：在转发前直接销毁客户端连接（删除请求从未到达 MinIO，对象得以
 *   存活）——模拟"存储不可用，恢复失败保留 PENDING_DELETE"路径。
 */
function startCommitSwallowingProxy(targetPort: number) {
  let swallowedPuts = 0;
  const server = net.createServer((clientSocket) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    const swallow = () => undefined;
    clientSocket.on("error", swallow);
    upstream.on("error", swallow);

    let requestHead = "";
    let forwarded = false;
    clientSocket.on("data", function onData(chunk: Buffer) {
      if (forwarded) return;
      requestHead += chunk.toString("latin1");
      if (!requestHead.includes("\r\n\r\n")) return;
      forwarded = true;
      if (requestHead.startsWith("DELETE")) {
        // 删除请求从未到达远端：对象存活，purge 必然失败
        clientSocket.destroy();
        upstream.destroy();
        return;
      }
      // PUT：完整转发请求（含已缓冲字节）——对象真实提交
      upstream.write(Buffer.from(requestHead, "latin1"));
      clientSocket.pipe(upstream);
      let responseBytes = Buffer.alloc(0);
      upstream.on("data", (responseChunk: Buffer) => {
        // 下行响应一律吞掉（绝不回写客户端）
        responseBytes = Buffer.concat([responseBytes, responseChunk]);
        if (responseBytes.includes("\r\n\r\n")) {
          swallowedPuts += 1;
          clientSocket.destroy();
          upstream.destroy();
        }
      });
    });
  });
  return {
    server,
    get swallowedPutCount() {
      return swallowedPuts;
    },
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.listen(0, "127.0.0.1", () =>
          resolve((server.address() as AddressInfo).port),
        );
        server.on("error", reject);
      }),
  };
}

/** accept 后永不响应的 blackhole 端点（R3-06 超时 abort 路径） */
function startBlackholeServer() {
  const server = net.createServer((socket) => {
    socket.on("error", () => undefined);
  });
  return {
    server,
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.listen(0, "127.0.0.1", () =>
          resolve((server.address() as AddressInfo).port),
        );
        server.on("error", reject);
      }),
  };
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

    /**
     * 一次性隔离数据库：本套件制造 PENDING_DELETE 恢复中间态，而并行运行的
     * asset-quota 套件会执行 runStorageCleanup 回收共享库的【全部】
     * PENDING_DELETE——共享库上存在跨文件竞态（上一轮 full run 实测复现）。
     * 建库 → migrate → 测试 → drop，与 production-cleanup-worker 套件同模式。
     */
    let isolatedDbName: string;
    const adminUrlFor = (url: string) => {
      const parsed = new URL(url);
      parsed.pathname = "/postgres";
      return parsed.toString();
    };

    beforeAll(async () => {
      const parsed = new URL(integrationDatabaseUrl!);
      isolatedDbName = `campus_lrfault_it_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      parsed.pathname = `/${isolatedDbName}`;
      const isolatedUrl = parsed.toString();

      await runPrismaCommand(
        ["db", "execute", "--stdin"],
        { DATABASE_URL: adminUrlFor(integrationDatabaseUrl!) },
        `CREATE DATABASE "${isolatedDbName}";`,
      );
      const migrated = await runPrismaCommand(
        ["migrate", "deploy"],
        { DATABASE_URL: isolatedUrl },
      );
      expect(
        migrated.code,
        `migrate deploy failed: ${migrated.stderr.slice(0, 400)}`,
      ).toBe(0);

      process.env.DATABASE_URL = isolatedUrl;
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
    }, 120_000);

    afterAll(async () => {
      // 清理测试对象（隔离前缀：userId 下）；隔离库整体 drop
      for (const ref of leftoverObjects) {
        await realStorage.deleteObject(ref).catch(() => undefined);
      }
      if (prisma) {
        await prisma.$disconnect();
        await runPrismaCommand(
          ["db", "execute", "--stdin"],
          { DATABASE_URL: adminUrlFor(integrationDatabaseUrl!) },
          `DROP DATABASE IF EXISTS "${isolatedDbName}" WITH (FORCE);`,
        );
      }
      setStorageForTests(null);
    }, 30_000);

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
      const purged = await purgePendingDeleteAsset(row!.id);
      expect(purged.outcome).toBe("PURGED");

      // 对象真实消失
      expect(await realStorage.headObject({ bucket: row!.bucket, objectKey: row!.objectKey }))
        .toBeNull();
      // DELETED 转移 + 配额 exactly-once 释放
      const afterRow = await prisma.uploadedAsset.findUnique({ where: { id: row!.id } });
      expect(afterRow!.status).toBe("DELETED");
      expect((await getStorageUsage(userId)).usedBytes).toBe(0);

      // 重复 cleanup 幂等：条件转移不再命中，不二次释放
      const repeat = await purgePendingDeleteAsset(row!.id);
      expect(repeat.outcome).toBe("NOOP");
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
      const purged = await purgePendingDeleteAsset(row!.id);
      expect(purged.outcome).toBe("PURGED");
      expect((await getStorageUsage(userId)).usedBytes).toBe(0);
      const afterRow = await prisma.uploadedAsset.findUnique({ where: { id: row!.id } });
      expect(afterRow!.status).toBe("DELETED");
    });

    it("R3-05 RESPONSE_LOST_AFTER_COMMIT（transport 级）：MinIO 真实提交后响应被吞 → 503，对象确证存在，恢复后 exactly-once 回收", async () => {
      const { S3Storage } = await import("@/lib/storage/s3-storage");
      const targetPort = Number(new URL(endpoint!).port) || 9100;
      const proxy = startCommitSwallowingProxy(targetPort);
      const proxyPort = await proxy.listen();
      const swallowStorage = new S3Storage(
        createBoundedS3Client({
          endpoint: `http://127.0.0.1:${proxyPort}`,
          region: "us-east-1" as const,
          forcePathStyle: true,
          credentials: {
            accessKeyId: process.env.INTEGRATION_S3_ACCESS_KEY_ID ?? "minioadmin",
            secretAccessKey: process.env.INTEGRATION_S3_SECRET_ACCESS_KEY ?? "minioadmin",
          },
        }),
      );
      setStorageForTests(swallowStorage);

      // 远端真实提交（对象写入 MinIO），client 经真实 socket 观察到连接错误
      await expect(
        uploadImageAsset({ userId, category: "product", file: buildFile() }),
      ).rejects.toMatchObject({ code: "STORAGE_UPLOAD_FAILED", status: 503 });
      expect(proxy.swallowedPutCount).toBeGreaterThanOrEqual(1);

      const row = await prisma.uploadedAsset.findFirst({
        where: { ownerId: userId },
        orderBy: { createdAt: "desc" },
      });
      expect(row).not.toBeNull();
      // authoritative recovery row 保留（歧义结果绝不删行）
      expect(row!.status).toBe("PENDING_DELETE");
      // 配额未提前释放（client 错误 ≠ 远端不存在）
      expect((await getStorageUsage(userId)).usedBytes).toBe(row!.sizeBytes);

      // 传输级歧义确证：client 失败而对象真实存在于 MinIO（权威 headObject）
      // （inline purge 的 DELETE 被代理拦截，从未到达 MinIO）
      expect(
        await realStorage.headObject({ bucket: row!.bucket, objectKey: row!.objectKey }),
      ).not.toBeNull();
      leftoverObjects.push({ bucket: row!.bucket, objectKey: row!.objectKey });

      // 存储恢复（直连真实 MinIO）→ cleanup 原语回收：对象删除 + DELETED +
      // 配额 exactly-once 释放
      setStorageForTests(realStorage);
      const purged = await purgePendingDeleteAsset(row!.id);
      expect(purged.outcome).toBe("PURGED");
      expect(
        await realStorage.headObject({ bucket: row!.bucket, objectKey: row!.objectKey }),
      ).toBeNull();
      const afterRow = await prisma.uploadedAsset.findUnique({ where: { id: row!.id } });
      expect(afterRow!.status).toBe("DELETED");
      expect((await getStorageUsage(userId)).usedBytes).toBe(0);

      // 重复 cleanup 幂等：条件转移不再命中，无二次释放
      const repeat = await purgePendingDeleteAsset(row!.id);
      expect(repeat.outcome).toBe("NOOP");
      expect((await getStorageUsage(userId)).usedBytes).toBe(0);
    }, 60_000);

    it("R3-06 超时 abort（blackhole 端点）：上传整体有界返回 503，歧义归类，恢复后 exactly-once 回收", async () => {
      const { S3Storage } = await import("@/lib/storage/s3-storage");
      const blackhole = startBlackholeServer();
      const blackholePort = await blackhole.listen();
      const timeoutStorage = new S3Storage(
        createBoundedS3Client({
          endpoint: `http://127.0.0.1:${blackholePort}`,
          region: "us-east-1" as const,
          forcePathStyle: true,
          credentials: {
            accessKeyId: process.env.INTEGRATION_S3_ACCESS_KEY_ID ?? "minioadmin",
            secretAccessKey: process.env.INTEGRATION_S3_SECRET_ACCESS_KEY ?? "minioadmin",
          },
        }),
      );
      setStorageForTests(timeoutStorage);

      // PUT abort（~5s）+ 内联 purge DELETE abort（~3s）——整个上传调用有界
      const startedAt = Date.now();
      await expect(
        uploadImageAsset({ userId, category: "product", file: buildFile() }),
      ).rejects.toMatchObject({ code: "STORAGE_UPLOAD_FAILED", status: 503 });
      const elapsed = Date.now() - startedAt;
      // LR-R3 验收：有界失败（修复前为 ~36s 长尾）
      expect(elapsed).toBeLessThan(15_000);

      const row = await prisma.uploadedAsset.findFirst({
        where: { ownerId: userId },
        orderBy: { createdAt: "desc" },
      });
      expect(row).not.toBeNull();
      // abort ≠ 远端零副作用证明：状态机保持保守（PENDING_DELETE，配额占用）
      expect(row!.status).toBe("PENDING_DELETE");
      expect((await getStorageUsage(userId)).usedBytes).toBe(row!.sizeBytes);

      // 存储恢复 → cleanup 原语完成回收（exactly-once）
      setStorageForTests(realStorage);
      const purged = await purgePendingDeleteAsset(row!.id);
      expect(purged.outcome).toBe("PURGED");
      const afterRow = await prisma.uploadedAsset.findUnique({ where: { id: row!.id } });
      expect(afterRow!.status).toBe("DELETED");
      expect((await getStorageUsage(userId)).usedBytes).toBe(0);
    }, 60_000);
  },
);
