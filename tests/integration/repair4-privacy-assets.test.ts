import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import sharp from "sharp";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StorageClient } from "@/lib/storage/types";

/**
 * Repair 4 / RB-04 资产 durable deletion 集成测试（真实 PostgreSQL + MinIO）。
 *
 * 使用临时 PostgreSQL 库（全量迁移重放）隔离运行：runStorageCleanup 是
 * 全局扫描 PENDING_DELETE 的生产任务，在共享集成库上运行会与并行测试
 * 文件的资产状态机竞态——本文件将全局 prisma 指向临时库后再引入
 * @/lib/prisma，保证物理删除工作流测试零跨文件干扰。
 *
 * 证明（spec §42/§44/§45/§46/§47）：
 * - ASSET-05/08：真实 MinIO 对象 PENDING_DELETE → cleanup → 对象消失 +
 *   DELETED + 配额恰一次释放；重复 cleanup 零副作用。
 * - ASSET-06/07：确定性 storage seam 第一次 deleteObject 失败 → 保留
 *   PENDING_DELETE + 配额不动；重试成功 → DELETED + 释放（eventual
 *   physical deletion）。
 * - ASSET-01/02 + §47：eraseAccount 后头像/认证资产 PENDING_DELETE →
 *   cleanup 收敛（对象删除、状态 DELETED、配额对账）。
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const s3Endpoint = process.env.INTEGRATION_S3_ENDPOINT;
const runAssets = Boolean(integrationDatabaseUrl && s3Endpoint);

const region = process.env.INTEGRATION_S3_REGION ?? "us-east-1";
const accessKeyId = process.env.INTEGRATION_S3_ACCESS_KEY_ID ?? "minioadmin";
const secretAccessKey = process.env.INTEGRATION_S3_SECRET_ACCESS_KEY ?? "minioadmin";
const publicBucket = process.env.INTEGRATION_S3_BUCKET_PUBLIC ?? "campus-public";
const privateBucket = process.env.INTEGRATION_S3_BUCKET_PRIVATE ?? "campus-private";

// ---- 临时库 helpers（phase7g 同款：无 shell 的 Prisma CLI 调用） ----

function swapDatabaseName(databaseUrl: string, name: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${name}`;
  parsed.search = "";
  return parsed.toString();
}

function runPrismaDbExecute(sql: string, databaseUrl: string): void {
  const result = spawnSync(
    process.execPath,
    [join("node_modules", "prisma", "build", "index.js"), "db", "execute", "--schema", "prisma/schema.prisma", "--stdin"],
    {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
      input: sql,
    },
  );
  if (result.status !== 0) {
    throw new Error(`prisma db execute failed (${result.status}): ${result.stderr}`);
  }
}

const TEMP_DB = runAssets ? `rb04_assets_${randomUUID().slice(0, 8)}` : "";

function bootstrapTempDatabase(): string {
  const maintenanceUrl = swapDatabaseName(integrationDatabaseUrl!, "postgres");
  runPrismaDbExecute(`DROP DATABASE IF EXISTS "${TEMP_DB}";`, maintenanceUrl);
  runPrismaDbExecute(`CREATE DATABASE "${TEMP_DB}";`, maintenanceUrl);
  const tempUrl = swapDatabaseName(integrationDatabaseUrl!, TEMP_DB);

  // 全量迁移重放（单批 db execute；scratch 库无需 _prisma_migrations 台账）
  const migrationsDir = join(process.cwd(), "prisma", "migrations");
  const migrations = readdirSync(migrationsDir)
    .filter((name) => /^\d{14}_/.test(name))
    .sort();
  expect(migrations.length).toBeGreaterThan(0);
  const sql = migrations
    .map((name) => readFileSync(join(migrationsDir, name, "migration.sql"), "utf8"))
    .join("\n\n");
  runPrismaDbExecute(sql, tempUrl);
  return tempUrl;
}

// 在引入任何依赖 DATABASE_URL 的模块前重定向全局客户端
const tempDatabaseUrl = runAssets ? bootstrapTempDatabase() : "";
if (runAssets) {
  process.env.DATABASE_URL = tempDatabaseUrl;
}

const rawClient = runAssets
  ? new PrismaClient({ datasources: { db: { url: tempDatabaseUrl } }, log: ["error"] })
  : null;

const s3 = s3Endpoint
  ? new S3Client({
      endpoint: s3Endpoint,
      region,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    })
  : null;

/** 确定性 storage 故障 seam：前 N 次 deleteObject 抛错，其余委托真实实现。 */
function makeFailingStorage(real: StorageClient, failuresRemaining: { count: number }): StorageClient {
  return {
    headBucket: (bucket) => real.headBucket(bucket),
    putObject: (input) => real.putObject(input),
    deleteObject: async (ref) => {
      if (failuresRemaining.count > 0) {
        failuresRemaining.count -= 1;
        throw new Error("injected deterministic delete failure");
      }
      return real.deleteObject(ref);
    },
    headObject: (ref) => real.headObject(ref),
    getObject: (ref) => real.getObject(ref),
    getSignedReadUrl: (ref, expiresInSeconds, responseCacheControl) =>
      real.getSignedReadUrl(ref, expiresInSeconds, responseCacheControl),
  };
}

async function createTestPng(): Promise<File> {
  const png = await sharp({
    create: { width: 16, height: 16, channels: 3, background: "#0a0b0c" },
  })
    .png()
    .toBuffer();
  return {
    name: "rb04-asset.png",
    size: png.byteLength,
    type: "image/png",
    arrayBuffer: () =>
      Promise.resolve(
        png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer,
      ),
  } as unknown as File;
}

async function headObjectExists(bucket: string, objectKey: string): Promise<boolean> {
  try {
    await s3!.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!runAssets)("Repair 4 asset durable deletion (real PostgreSQL + MinIO)", () => {
  const objectKeys: Array<{ bucket: string; objectKey: string }> = [];

  beforeAll(async () => {
    for (const bucket of [publicBucket, privateBucket]) {
      try {
        await s3!.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch (error) {
        const name = (error as { name?: string }).name;
        if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") {
          throw error;
        }
      }
    }
  });

  afterAll(async () => {
    const { setStorageForTests } = await import("@/lib/storage");
    setStorageForTests(null);
    if (s3) {
      for (const ref of objectKeys) {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: ref.bucket, Key: ref.objectKey }));
        } catch {
          // 清理失败不阻塞测试结束
        }
      }
      await s3.destroy();
    }
    await rawClient?.$disconnect();
    if (runAssets) {
      const maintenanceUrl = swapDatabaseName(integrationDatabaseUrl!, "postgres");
      try {
        runPrismaDbExecute(`DROP DATABASE IF EXISTS "${TEMP_DB}" WITH (FORCE);`, maintenanceUrl);
      } catch {
        // 残留连接 FORCE 已尽力
      }
    }
  });

  it("ASSET-05/08：真实 MinIO 对象 PENDING_DELETE → cleanup → DELETED + 配额恰一次释放", async () => {
    const { S3Storage } = await import("@/lib/storage/s3-storage");
    const { setStorageForTests } = await import("@/lib/storage");
    const { prisma } = await import("@/lib/prisma");
    const { getStorageUsage, markAssetPendingDelete, uploadImageAsset } = await import("@/lib/asset-service");
    const { runStorageCleanup } = await import("@/lib/asset-cleanup");

    setStorageForTests(new S3Storage(s3!));

    const campus = await prisma.campus.create({
      data: {
        name: "RB04 资产校区",
        slug: `rb04-assets-${randomUUID().slice(0, 8)}`,
        schoolName: "集成测试大学",
      },
    });
    const user = await prisma.user.create({
      data: {
        name: "rb04-quota",
        email: `rb04-quota-${randomUUID().slice(0, 8)}@it.local`,
        passwordHash: "test-only",
        schoolName: "集成测试大学",
        campusId: campus.id,
      },
    });

    try {
      const uploaded = await uploadImageAsset({
        userId: user.id,
        category: "verification",
        file: await createTestPng(),
      });
      const asset = await prisma.uploadedAsset.findUniqueOrThrow({ where: { id: uploaded.assetId } });
      objectKeys.push({ bucket: asset.bucket, objectKey: asset.objectKey });

      const quotaBefore = (await getStorageUsage(user.id)).usedBytes;
      expect(quotaBefore).toBe(asset.sizeBytes);
      expect(await headObjectExists(asset.bucket, asset.objectKey)).toBe(true);

      expect(await markAssetPendingDelete(asset.id)).toBe(true);

      const summary = await runStorageCleanup();
      expect(summary.failures).toBe(0);

      // 物理对象已消失 + 状态 DELETED + 配额释放恰一次
      expect(await headObjectExists(asset.bucket, asset.objectKey)).toBe(false);
      expect((await prisma.uploadedAsset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("DELETED");
      expect((await getStorageUsage(user.id)).usedBytes).toBe(0);

      // ASSET-08：重复 cleanup 无进一步效果（配额不再减、状态不再变）
      const summary2 = await runStorageCleanup();
      expect(summary2.objectsDeleted).toBe(0);
      expect(summary2.quotaReleasedBytes).toBe(0);
      expect((await getStorageUsage(user.id)).usedBytes).toBe(0);
      expect((await prisma.uploadedAsset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("DELETED");
    } finally {
      await prisma.uploadedAsset.deleteMany({ where: { ownerId: user.id } });
      await prisma.campusMembership.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id, deletedAt: null } });
      await prisma.campus.deleteMany({ where: { id: campus.id } });
    }
  });

  it("ASSET-06/07：deleteObject 确定性失败保留 PENDING_DELETE + 配额不动；重试收敛删除", async () => {
    const { S3Storage } = await import("@/lib/storage/s3-storage");
    const { setStorageForTests } = await import("@/lib/storage");
    const { prisma } = await import("@/lib/prisma");
    const { getStorageUsage, markAssetPendingDelete, uploadImageAsset } = await import("@/lib/asset-service");
    const { runStorageCleanup } = await import("@/lib/asset-cleanup");

    const realStorage = new S3Storage(s3!);
    const failuresRemaining = { count: 1 };
    setStorageForTests(makeFailingStorage(realStorage, failuresRemaining));

    const campus = await prisma.campus.create({
      data: {
        name: "RB04 重试校区",
        slug: `rb04-retry-${randomUUID().slice(0, 8)}`,
        schoolName: "集成测试大学",
      },
    });
    const user = await prisma.user.create({
      data: {
        name: "rb04-retry",
        email: `rb04-retry-${randomUUID().slice(0, 8)}@it.local`,
        passwordHash: "test-only",
        schoolName: "集成测试大学",
        campusId: campus.id,
      },
    });

    try {
      const uploaded = await uploadImageAsset({
        userId: user.id,
        category: "verification",
        file: await createTestPng(),
      });
      const asset = await prisma.uploadedAsset.findUniqueOrThrow({ where: { id: uploaded.assetId } });
      objectKeys.push({ bucket: asset.bucket, objectKey: asset.objectKey });

      expect(await markAssetPendingDelete(asset.id)).toBe(true);

      // 第一次 cleanup：deleteObject 注入失败 → purge 返回 false（不计入
      // objectsDeleted），资产保留 PENDING_DELETE、配额不动（§46：
      // 失败可观测且绝不放行状态转移/配额释放）
      const failedSummary = await runStorageCleanup();
      expect(failedSummary.objectsDeleted).toBe(0);
      expect(failedSummary.quotaReleasedBytes).toBe(0);
      expect((await prisma.uploadedAsset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("PENDING_DELETE");
      expect((await getStorageUsage(user.id)).usedBytes).toBe(asset.sizeBytes);
      expect(await headObjectExists(asset.bucket, asset.objectKey)).toBe(true);

      // 第二次 cleanup：seam 恢复 → DELETED + 配额释放（eventual deletion）
      const retrySummary = await runStorageCleanup();
      expect(retrySummary.failures).toBe(0);
      expect((await prisma.uploadedAsset.findUniqueOrThrow({ where: { id: asset.id } })).status).toBe("DELETED");
      expect((await getStorageUsage(user.id)).usedBytes).toBe(0);
      expect(await headObjectExists(asset.bucket, asset.objectKey)).toBe(false);

      // 第三次 cleanup：无进一步效果
      const thirdSummary = await runStorageCleanup();
      expect(thirdSummary.objectsDeleted).toBe(0);
      expect(thirdSummary.quotaReleasedBytes).toBe(0);
      expect((await getStorageUsage(user.id)).usedBytes).toBe(0);
    } finally {
      await prisma.uploadedAsset.deleteMany({ where: { ownerId: user.id } });
      await prisma.campusMembership.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id, deletedAt: null } });
      await prisma.campus.deleteMany({ where: { id: campus.id } });
    }
  });

  it("ASSET-01/02 + §47：eraseAccount → 头像/认证资产 PENDING_DELETE → cleanup 对账（对象删除 + 配额清零）", async () => {
    const { S3Storage } = await import("@/lib/storage/s3-storage");
    const { setStorageForTests } = await import("@/lib/storage");
    const { prisma } = await import("@/lib/prisma");
    const { uploadImageAsset } = await import("@/lib/asset-service");
    const { runStorageCleanup } = await import("@/lib/asset-cleanup");
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");

    setStorageForTests(new S3Storage(s3!));

    const campus = await prisma.campus.create({
      data: {
        name: "RB04 注销资产校区",
        slug: `rb04-erase-${randomUUID().slice(0, 8)}`,
        schoolName: "集成测试大学",
      },
    });
    const user = await prisma.user.create({
      data: {
        name: "rb04-erase",
        email: `rb04-erase-${randomUUID().slice(0, 8)}@it.local`,
        passwordHash: "test-only",
        schoolName: "集成测试大学",
        campusId: campus.id,
      },
    });
    const membership = await prisma.campusMembership.create({
      data: { userId: user.id, campusId: campus.id, status: "ACTIVE" },
    });

    try {
      const avatar = await uploadImageAsset({ userId: user.id, category: "avatar", file: await createTestPng() });
      const evidence = await uploadImageAsset({ userId: user.id, category: "verification", file: await createTestPng() });
      const avatarAsset = await prisma.uploadedAsset.findUniqueOrThrow({ where: { id: avatar.assetId } });
      const evidenceAsset = await prisma.uploadedAsset.findUniqueOrThrow({ where: { id: evidence.assetId } });
      objectKeys.push({ bucket: avatarAsset.bucket, objectKey: avatarAsset.objectKey });
      objectKeys.push({ bucket: evidenceAsset.bucket, objectKey: evidenceAsset.objectKey });

      // 绑定为已使用状态（头像挂到 profile；认证材料 ATTACHED 到认证行）
      await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: `asset:${avatarAsset.id}` } });
      await prisma.uploadedAsset.update({
        where: { id: avatarAsset.id },
        data: { status: "ATTACHED", attachedAt: new Date() },
      });
      const verification = await prisma.userVerification.create({
        data: {
          userId: user.id,
          membershipId: membership.id,
          schoolName: "示例大学",
          campusName: "主校区",
          studentIdLast4: "1234",
          studentCardImage: `asset:${evidenceAsset.id}`,
          status: "VERIFIED",
          submittedAt: new Date(),
          reviewDueAt: new Date(Date.now() + 48 * 3600_000),
        },
      });
      await prisma.uploadedAsset.update({
        where: { id: evidenceAsset.id },
        data: { status: "ATTACHED", attachedAt: new Date(), verificationId: verification.id },
      });

      const quotaBefore = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).storageUsedBytes;
      expect(quotaBefore).toBe(avatarAsset.sizeBytes + evidenceAsset.sizeBytes);

      // 生产路径注销（USER 治理锁 + 事务内标记 PENDING_DELETE）
      const result = await eraseAccount(user.id);
      expect(result.sensitiveAssetsMarkedForDeletion).toBe(2);

      const erasedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(erasedUser.avatarUrl).toBeNull();

      const erasedAvatar = await prisma.uploadedAsset.findUniqueOrThrow({ where: { id: avatarAsset.id } });
      const erasedEvidence = await prisma.uploadedAsset.findUniqueOrThrow({ where: { id: evidenceAsset.id } });
      expect(erasedAvatar.status).toBe("PENDING_DELETE");
      expect(erasedEvidence.status).toBe("PENDING_DELETE");
      expect(erasedAvatar.originalFileName).toBeNull();
      expect(erasedEvidence.originalFileName).toBeNull();
      // 注销后对象仍存在（物理删除由 cleanup 收敛，而非 DB 事务内网络 I/O）
      expect(await headObjectExists(erasedAvatar.bucket, erasedAvatar.objectKey)).toBe(true);
      expect(await headObjectExists(erasedEvidence.bucket, erasedEvidence.objectKey)).toBe(true);

      const summary = await runStorageCleanup();
      expect(summary.failures).toBe(0);

      expect(await headObjectExists(erasedAvatar.bucket, erasedAvatar.objectKey)).toBe(false);
      expect(await headObjectExists(erasedEvidence.bucket, erasedEvidence.objectKey)).toBe(false);
      expect((await prisma.uploadedAsset.findUniqueOrThrow({ where: { id: avatarAsset.id } })).status).toBe("DELETED");
      expect((await prisma.uploadedAsset.findUniqueOrThrow({ where: { id: evidenceAsset.id } })).status).toBe("DELETED");
      // 配额对账：注销资产清理后恰一次释放到 0
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).storageUsedBytes).toBe(0);
    } finally {
      await prisma.uploadedAsset.deleteMany({ where: { ownerId: user.id } });
      await prisma.userVerification.deleteMany({ where: { userId: user.id } });
      await prisma.notification.deleteMany({ where: { userId: user.id } });
      await prisma.privacyRequest.deleteMany({ where: { userId: user.id } });
      await prisma.campusMembership.deleteMany({ where: { userId: user.id } });
      await prisma.session.deleteMany({ where: { userId: user.id } });
      // 测试清理：rawClient 硬删除 fixture User（生产代码红线 = 绝不删 User 行，
      // 此处仅为测试库不留残留）；显式 deletedAt 条件豁免软删除拦截
      await prisma.user.deleteMany({ where: { id: user.id, deletedAt: null } });
      await prisma.campus.deleteMany({ where: { id: campus.id } });
    }
  });
});
