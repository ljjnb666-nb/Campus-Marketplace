/**
 * E2E teardown：尽力而为的资源回收（即使部分 spec 失败也应执行）。
 *
 * - MinIO：删除本轮（run-state.startedAt 之后）上传的全部对象
 *   —— 通过 E2E 库 uploadedAsset 行精确追踪，不碰其它对象
 * - Redis：再次清理 ratelimit:* 计数键
 * - DB：保留数据供失败排查（下一轮 e2e-setup 会全量重置）
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import {
  DeleteObjectsCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/campus_e2e?schema=public";

const E2E_REDIS_URL = process.env.E2E_REDIS_URL ?? "redis://localhost:6379";

const S3_ENDPOINT = process.env.E2E_S3_ENDPOINT ?? process.env.S3_ENDPOINT ?? "http://localhost:9100";
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID ?? "minioadmin";
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin";

const RUN_STATE_FILE = path.join("tests", "e2e", ".run-state.json");

function readRunStartedAt(): Date {
  try {
    const state = JSON.parse(readFileSync(RUN_STATE_FILE, "utf-8")) as {
      startedAt: string;
    };
    return new Date(state.startedAt);
  } catch {
    // run-state 丢失时退化为清理全部 E2E 库登记的对象（E2E 库本来就只含本轮数据）
    return new Date(0);
  }
}

async function cleanupMinIO(startedAt: Date): Promise<void> {
  const prisma = new PrismaClient({ datasources: { db: { url: E2E_DATABASE_URL } } });
  const s3 = new S3Client({
    endpoint: S3_ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
    },
  });

  try {
    const assets = await prisma.uploadedAsset.findMany({
      where: { createdAt: { gte: startedAt } },
      select: { bucket: true, objectKey: true },
    });

    if (assets.length === 0) {
      console.log("[e2e-teardown] 本轮无新增对象存储资产");
      return;
    }

    const byBucket = new Map<string, string[]>();
    for (const asset of assets) {
      const keys = byBucket.get(asset.bucket) ?? [];
      keys.push(asset.objectKey);
      byBucket.set(asset.bucket, keys);
    }

    let deleted = 0;
    for (const [bucket, keys] of byBucket) {
      // 去重（同 key 可能被多行引用）
      const unique = [...new Set(keys)];
      for (let i = 0; i < unique.length; i += 100) {
        const batch = unique.slice(i, i + 100).map((Key) => ({ Key }));
        await s3.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch } }),
        );
        deleted += batch.length;
      }
      console.log(`[e2e-teardown] ${bucket}: 已请求删除 ${unique.length} 个对象`);
    }

    // 兜底：bucket 中仍残留的孤儿对象（如事务回滚导致的未登记对象）按前缀扫描，
    // 仅删除 e2e 上传路径下 startedAt 之后无法判断的对象不做猜测——孤儿由
    // npm run storage:cleanup 定期回收，这里只保证不永久堆积已登记对象。
    console.log(`[e2e-teardown] 共清理 ${deleted} 个对象`);
  } finally {
    await prisma.$disconnect();
  }
}

async function flushRateLimitKeys(): Promise<void> {
  const redis = new Redis(E2E_REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    lazyConnect: true,
  });

  try {
    await redis.connect();
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "ratelimit:*", "COUNT", 100);
      cursor = next;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
    console.log("[e2e-teardown] 限流 Redis 键已清理");
  } catch (error) {
    console.warn(
      `[e2e-teardown] Redis 清理跳过（${error instanceof Error ? error.message : error}）`,
    );
  } finally {
    redis.disconnect();
  }
}

async function main(): Promise<void> {
  const startedAt = readRunStartedAt();

  try {
    await cleanupMinIO(startedAt);
  } catch (error) {
    console.warn(
      `[e2e-teardown] MinIO 清理失败（${error instanceof Error ? error.message : error}）`,
    );
  }

  await flushRateLimitKeys();
}

main().catch((error) => {
  console.error("[e2e-teardown] 失败:", error);
  process.exit(1);
});
