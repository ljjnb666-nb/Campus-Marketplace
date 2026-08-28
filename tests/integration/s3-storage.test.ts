import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import http from "node:http";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 真实 MinIO 集成测试（S3 兼容 API 全链路）。
 *
 * 仅当 INTEGRATION_S3_ENDPOINT 指向一个真实可用的 S3 兼容服务
 * （本地 docker compose 的 MinIO 或 CI 服务容器）时执行，否则跳过。
 * 覆盖：bucket 引导（幂等创建）、公/私有上传、head、签名 URL、
 * 匿名访问策略、删除幂等、配额记账与释放。
 */

const endpoint = process.env.INTEGRATION_S3_ENDPOINT;
const region = process.env.INTEGRATION_S3_REGION ?? "us-east-1";
const accessKeyId = process.env.INTEGRATION_S3_ACCESS_KEY_ID ?? "minioadmin";
const secretAccessKey = process.env.INTEGRATION_S3_SECRET_ACCESS_KEY ?? "minioadmin";
const publicBucket = process.env.INTEGRATION_S3_BUCKET_PUBLIC ?? "campus-public";
const privateBucket = process.env.INTEGRATION_S3_BUCKET_PRIVATE ?? "campus-private";

const s3 = endpoint
  ? new S3Client({
      endpoint,
      region,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    })
  : null;

const createdKeys: Array<{ bucket: string; objectKey: string }> = [];

/**
 * 受控的对象读取（集成测试专用）：
 * 仅允许访问测试端点主机（本地/回环），路径段做白名单字符校验，
 * 杜绝把任意来源的 URL 直接发给服务端。
 */
async function httpGetStatusAndBody(url: string): Promise<{ status: number; body: string }> {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const isLocalHost =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (!isLocalHost) {
    throw new Error(`集成测试仅允许访问本地端点，拒绝主机：${host}`);
  }
  for (const segment of parsed.pathname.split("/")) {
    if (segment === ".." || segment.includes("\\")) {
      throw new Error(`非法路径段：${segment}`);
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let started = false;
    const chunks: Buffer[] = [];
    let statusCode = 0;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      // MinIO 对匿名拒绝可能在响应中途 RST 连接：状态码已收到时按已读内容收敛
      if (error && !started) {
        reject(error);
        return;
      }
      resolve({ status: statusCode, body: Buffer.concat(chunks).toString() });
    };

    const request = http.get(parsed, { headers: { connection: "close" } }, (response) => {
      started = true;
      statusCode = response.statusCode ?? 0;
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => finish());
      response.on("aborted", () => finish());
    });
    request.on("error", (error) => finish(error));
  });
}

beforeAll(async () => {
  if (!s3) return;
  // bucket 引导（幂等）：已存在时忽略冲突
  for (const bucket of [publicBucket, privateBucket]) {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") {
        throw error;
      }
    }
  }
});

afterAll(async () => {
  if (s3) {
    for (const ref of createdKeys) {
      try {
        await s3.send(
          new DeleteObjectCommand({ Bucket: ref.bucket, Key: ref.objectKey }),
        );
      } catch {
        // 清理失败不阻塞测试结束
      }
    }
    await s3.destroy();
  }
});

describe.skipIf(!endpoint)("S3 对象存储集成测试 (MinIO)", () => {
  it("bucket 已就绪：公私有 bucket 均可访问", async () => {
    for (const bucket of [publicBucket, privateBucket]) {
      await expect(s3!.send(new HeadBucketCommand({ Bucket: bucket }))).resolves.toBeDefined();
    }
  });

  it("公开对象：上传 → head → 匿名 GET 可读", async () => {
    const { S3Storage } = await import("@/lib/storage/s3-storage");
    const { buildObjectKey } = await import("@/lib/storage/object-key");
    const storage = new S3Storage(s3!);

    const objectKey = buildObjectKey({
      access: "PUBLIC",
      categoryDirectory: "products",
      userId: "it-user-1",
      fileExtension: ".webp",
    });
    createdKeys.push({ bucket: publicBucket, objectKey });

    const body = Buffer.from("public-integration-test");
    await storage.putObject({ bucket: publicBucket, objectKey, body, contentType: "text/plain" });

    const head = await storage.headObject({ bucket: publicBucket, objectKey });
    expect(head?.sizeBytes).toBe(body.byteLength);

    // bucket 策略允许匿名读（compose/CI 已用 mc 设置 download）
    const response = await httpGetStatusAndBody(`${endpoint}/${publicBucket}/${objectKey}`);
    expect(response.status).toBe(200);
    expect(response.body).toBe("public-integration-test");
  });

  it("私有对象：上传 → 匿名 GET 拒绝 → 签名 URL 可读", async () => {
    const { S3Storage } = await import("@/lib/storage/s3-storage");
    const { buildObjectKey } = await import("@/lib/storage/object-key");
    const storage = new S3Storage(s3!);

    const objectKey = buildObjectKey({
      access: "PRIVATE",
      categoryDirectory: "verification",
      userId: "it-user-1",
      fileExtension: ".webp",
    });
    createdKeys.push({ bucket: privateBucket, objectKey });

    const body = Buffer.from("private-integration-test");
    await storage.putObject({ bucket: privateBucket, objectKey, body, contentType: "text/plain" });

    // 匿名访问被 bucket 策略拒绝
    const anonymous = await httpGetStatusAndBody(`${endpoint}/${privateBucket}/${objectKey}`);
    expect(anonymous.status).toBe(403);

    // 签名 URL 短期可读
    const signedUrl = await storage.getSignedReadUrl({ bucket: privateBucket, objectKey }, 60);
    const signed = await httpGetStatusAndBody(signedUrl);
    expect(signed.status).toBe(200);
    expect(signed.body).toBe("private-integration-test");
  });

  it("删除幂等：删除后 head 返回 null，重复删除不抛错", async () => {
    const { S3Storage } = await import("@/lib/storage/s3-storage");
    const { buildObjectKey } = await import("@/lib/storage/object-key");
    const storage = new S3Storage(s3!);

    const objectKey = buildObjectKey({
      access: "PUBLIC",
      categoryDirectory: "products",
      userId: "it-user-1",
      fileExtension: ".webp",
    });

    await storage.putObject({
      bucket: publicBucket,
      objectKey,
      body: Buffer.from("tmp"),
      contentType: "text/plain",
    });
    await storage.deleteObject({ bucket: publicBucket, objectKey });
    await storage.deleteObject({ bucket: publicBucket, objectKey });
    await expect(storage.headObject({ bucket: publicBucket, objectKey })).resolves.toBeNull();
  });

  it("uploadImageAsset 全链路：私有对象无 URL + 配额记账与释放", async () => {
    const { S3Storage } = await import("@/lib/storage/s3-storage");
    const { setStorageForTests } = await import("@/lib/storage");
    const { prisma } = await import("@/lib/prisma");
    const {
      getStorageUsage,
      markAssetPendingDelete,
      purgePendingDeleteAsset,
      uploadImageAsset,
    } = await import("@/lib/asset-service");

    setStorageForTests(new S3Storage(s3!));

    const campus = await prisma.campus.create({
      data: {
        name: "S3集成测试校区",
        slug: `it-s3-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        schoolName: "集成测试大学",
      },
    });
    const user = await prisma.user.create({
      data: {
        name: "s3-it",
        email: `s3-it-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@campus.local`,
        passwordHash: "test-only",
        schoolName: "集成测试大学",
        campusId: campus.id,
      },
    });

    try {
      const png = await sharp({
        create: { width: 24, height: 24, channels: 3, background: "#123456" },
      })
        .png()
        .toBuffer();
      const file = {
        name: "card.png",
        size: png.byteLength,
        type: "image/png",
        arrayBuffer: () =>
          Promise.resolve(
            png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer,
          ),
      } as unknown as File;

      const result = await uploadImageAsset({
        userId: user.id,
        category: "verification",
        file,
      });

      // 私有资源：禁止返回永久公开 URL
      expect(result.access).toBe("PRIVATE");
      expect(result.url).toBeNull();

      const asset = await prisma.uploadedAsset.findUnique({ where: { id: result.assetId } });
      expect(asset?.status).toBe("UPLOADED");
      expect(asset?.objectKey).toMatch(/^private\/verification\//);
      createdKeys.push({ bucket: asset!.bucket, objectKey: asset!.objectKey });

      // 配额记账 = 重编码后实际存储大小
      const usage = await getStorageUsage(user.id);
      expect(usage.usedBytes).toBe(result.sizeBytes);

      // 清理：标记 → 物理删除 → 状态转移 → 配额释放
      expect(await markAssetPendingDelete(asset!.id)).toBe(true);
      expect(
        await purgePendingDeleteAsset({
          id: asset!.id,
          ownerId: user.id,
          bucket: asset!.bucket,
          objectKey: asset!.objectKey,
          sizeBytes: asset!.sizeBytes,
        }),
      ).toBe(true);

      expect((await getStorageUsage(user.id)).usedBytes).toBe(0);
      expect(
        (await prisma.uploadedAsset.findUnique({ where: { id: asset!.id } }))?.status,
      ).toBe("DELETED");
    } finally {
      setStorageForTests(null);
      // 物理清理测试数据（User 显式 deletedAt 条件豁免软删除拦截 → 硬删除）
      await prisma.uploadedAsset.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id, deletedAt: null } });
      await prisma.campus.deleteMany({ where: { id: campus.id } });
      await prisma.$disconnect();
    }
  });
});
