import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// 子进程管理模式抽到 scripts/resilience/spawn-worker.mjs（与 upload-boundary
// harness 同一模式；测试文件不直接持有进程管理代码）
import {
  killTree,
  runPrismaCommand,
  runWorker,
  spawnWorkerLoop,
} from "../../scripts/resilience/spawn-worker.mjs";

/**
 * LR-071 审计修复（3.6/3.7）：生产 cleanup worker 恢复链集成测试。
 *
 * 关键契约：恢复必须由【实际生产 worker entrypoint】（子进程运行
 * scripts/ops/storage-cleanup-worker.ts，即 compose storage-cleanup 服务
 * 的同一入口）触发——绝不以测试进程内直接调用 purgePendingDeleteAsset
 * 作为恢复证明。
 *
 * 场景（storage outage 之后的真实残留状态）：
 *   真实 MinIO 中存在 orphan candidate 对象
 *   + PENDING_DELETE 行（authoritative recovery row）
 *   + User.storageUsedBytes 保持占用
 * → worker entrypoint 运行一轮
 * → 对象被删除 / 行转 DELETED / 配额 exactly-once 释放
 * → 再次运行（幂等）：无二次释放
 *
 * 自动循环模式（无 --run-once）也以子进程验证：interval 驱动自动回收。
 *
 * 真实依赖：INTEGRATION_DATABASE_URL（PostgreSQL）+ INTEGRATION_S3_ENDPOINT
 * （MinIO）。隔离：唯一测试 user + 唯一 object key 前缀。
 */

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const endpoint = process.env.INTEGRATION_S3_ENDPOINT;

const s3 = endpoint
  ? new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.INTEGRATION_S3_ACCESS_KEY_ID ?? "minioadmin",
        secretAccessKey: process.env.INTEGRATION_S3_SECRET_ACCESS_KEY ?? "minioadmin",
      },
    })
  : null;

async function objectExists(bucket: string, objectKey: string): Promise<boolean> {
  const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
  try {
    await s3!.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!integrationDatabaseUrl || !endpoint || !s3)(
  "生产 cleanup worker 恢复链（真实 PG + MinIO，entrypoint 子进程触发）",
  () => {
    type PrismaModule = typeof import("@/lib/prisma");
    let prisma: PrismaModule["prisma"];

    let userId: string;
    let campusId: string;
    const orphanObjects: Array<{ bucket: string; objectKey: string }> = [];
    const SIZE_BYTES = 4096;

    async function seedPostOutageState(label: string): Promise<{ objectKey: string; assetId: string }> {
      // 模拟一次 storage outage 失败上传后的残留状态：
      // 对象已在远端存在（ambiguous PUT）+ PENDING_DELETE 行 + 配额占用
      const objectKey = `public/products/${userId}/worker-it-${label}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.webp`;
      await s3!.send(
        new PutObjectCommand({
          Bucket: "campus-public",
          Key: objectKey,
          Body: Buffer.alloc(SIZE_BYTES),
          ContentType: "image/webp",
        }),
      );
      orphanObjects.push({ bucket: "campus-public", objectKey });
      expect(await objectExists("campus-public", objectKey)).toBe(true);

      const asset = await prisma.uploadedAsset.create({
        data: {
          ownerId: userId,
          category: "PRODUCT",
          access: "PUBLIC",
          bucket: "campus-public",
          objectKey,
          mimeType: "image/webp",
          sizeBytes: SIZE_BYTES,
          status: "PENDING_DELETE",
        },
      });
      await prisma.user.update({
        where: { id: userId },
        data: { storageUsedBytes: { increment: SIZE_BYTES } },
      });
      return { objectKey, assetId: asset.id };
    }

    /**
     * 一次性隔离数据库：worker 循环会回收"全部 PENDING_DELETE"，若跑在
     * 共享测试库上会与并行测试（asset-storage-fault 等）的恢复中间态互扰。
     * 本套件建库 → migrate → 测试 → drop，完全消除跨文件干扰。
     */
    let isolatedDbName: string;
    const adminUrlFor = (url: string) => {
      const parsed = new URL(url);
      parsed.pathname = "/postgres";
      return parsed.toString();
    };

    beforeAll(async () => {
      const parsed = new URL(integrationDatabaseUrl!);
      isolatedDbName = `campus_worker_it_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      parsed.pathname = `/${isolatedDbName}`;
      const isolatedUrl = parsed.toString();

      // 建库（幂等容忍已存在）→ schema migrate（worker 子进程同库）
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
      ({ prisma } = await import("@/lib/prisma"));
      const campus = await prisma.campus.create({
        data: {
          name: "cleanup worker 集成测试校区",
          slug: `it-cleanup-worker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          schoolName: "集成测试大学",
        },
      });
      campusId = campus.id;
      const user = await prisma.user.create({
        data: {
          name: "cleanup-worker-it",
          email: `cleanup-worker-it-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@campus.local`,
          passwordHash: "test-only",
          schoolName: "集成测试大学",
          campusId,
          storageUsedBytes: 0,
        },
      });
      userId = user.id;
    }, 120_000);

    afterAll(async () => {
      for (const ref of orphanObjects) {
        await s3!
          .send(new DeleteObjectCommand({ Bucket: ref.bucket, Key: ref.objectKey }))
          .catch(() => undefined);
      }
      if (prisma) {
        await prisma.$disconnect();
        // 整库 drop（WITH FORCE 断开残留连接）——不留任何测试残留
        await runPrismaCommand(
          ["db", "execute", "--stdin"],
          { DATABASE_URL: adminUrlFor(integrationDatabaseUrl!) },
          `DROP DATABASE IF EXISTS "${isolatedDbName}" WITH (FORCE);`,
        );
      }
    }, 30_000);

    async function readState(assetId: string) {
      const row = await prisma.uploadedAsset.findUnique({ where: { id: assetId } });
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { storageUsedBytes: true },
      });
      return { row, quota: user?.storageUsedBytes ?? null };
    }

    it("--run-once：生产 entrypoint 一轮回收 orphan candidate + PENDING_DELETE，配额 exactly-once 释放", async () => {
      const { objectKey, assetId } = await seedPostOutageState("run-once");

      const result = await runWorker(["--run-once"], {
        DATABASE_URL: process.env.DATABASE_URL!,
        S3_ENDPOINT: endpoint!,
        S3_BUCKET_PUBLIC: "campus-public",
        S3_BUCKET_PRIVATE: "campus-private",
        NEXTAUTH_SECRET: "worker-it-env-validation-only",
      });
      expect(result.code, `worker exit: ${result.stderr.slice(0, 400)}`).toBe(0);
      // summary 日志仅在产生实际工作时输出
      expect(result.stdout).toMatch(/storage_cleanup_cycle_completed/);

      const { row, quota } = await readState(assetId);
      expect(row!.status).toBe("DELETED");
      expect(await objectExists("campus-public", objectKey)).toBe(false);
      // 配额已释放（回收后归零；种子状态曾占用 SIZE_BYTES）
      expect(quota).toBe(0);

      // 幂等：再次 --run-once，无任何新工作、无二次释放
      const repeat = await runWorker(["--run-once"], {
        DATABASE_URL: process.env.DATABASE_URL!,
        S3_ENDPOINT: endpoint!,
        S3_BUCKET_PUBLIC: "campus-public",
        S3_BUCKET_PRIVATE: "campus-private",
        NEXTAUTH_SECRET: "worker-it-env-validation-only",
      });
      expect(repeat.code).toBe(0);
      expect(repeat.stdout).not.toMatch(/storage_cleanup_cycle_completed.*"objectsDeleted":[1-9]/);

      const afterRepeat = await readState(assetId);
      expect(afterRepeat.row!.status).toBe("DELETED");
      expect(afterRepeat.quota).toBe(0);
    }, 60_000);

    it("PRODUCTION-WORKER-HOLD-01：--run-once 尊重 ACTIVE DataHold（exit 0、对象/行/配额保留），release 后收敛回收", async () => {
      const { objectKey, assetId } = await seedPostOutageState("hold-guard");
      const { createHold, releaseHold } = await import("@/lib/privacy/data-hold-service");
      const hold = await createHold({
        type: "LEGAL",
        subjectType: "USER",
        subjectId: userId,
        reasonCode: "IT_9C_WORKER_HOLD",
      });

      // hold ACTIVE：worker 一轮零破坏性副作用 + 零失败（business block 非 error）
      const blocked = await runWorker(["--run-once"], {
        DATABASE_URL: process.env.DATABASE_URL!,
        S3_ENDPOINT: endpoint!,
        S3_BUCKET_PUBLIC: "campus-public",
        S3_BUCKET_PRIVATE: "campus-private",
        NEXTAUTH_SECRET: "worker-it-env-validation-only",
      });
      expect(blocked.code, `worker exit: ${blocked.stderr.slice(0, 400)}`).toBe(0);
      expect(blocked.stdout).toMatch(/storage_cleanup_cycle_completed/);
      expect(blocked.stdout).toMatch(/"purgeHoldBlocked":[1-9]/);

      const { row, quota } = await readState(assetId);
      expect(row!.status).toBe("PENDING_DELETE");
      expect(await objectExists("campus-public", objectKey)).toBe(true);
      expect(quota).toBe(SIZE_BYTES);

      // release hold → 再一轮：对象删除、DELETED、配额释放
      await releaseHold(hold.id);
      const released = await runWorker(["--run-once"], {
        DATABASE_URL: process.env.DATABASE_URL!,
        S3_ENDPOINT: endpoint!,
        S3_BUCKET_PUBLIC: "campus-public",
        S3_BUCKET_PRIVATE: "campus-private",
        NEXTAUTH_SECRET: "worker-it-env-validation-only",
      });
      expect(released.code).toBe(0);

      const after = await readState(assetId);
      expect(after.row!.status).toBe("DELETED");
      expect(await objectExists("campus-public", objectKey)).toBe(false);
      expect(after.quota).toBe(0);
    }, 90_000);

    it("automatic loop：interval 驱动自动回收（真实常驻子进程，非手动触发）", async () => {
      const { objectKey, assetId } = await seedPostOutageState("auto-loop");

      // NODE_ENV=test 允许 >=1s 的验证周期；生产由 60s 下限保护
      const { child, getOutput } = spawnWorkerLoop({
        ASSET_CLEANUP_INTERVAL_SECONDS: "1",
        DATABASE_URL: process.env.DATABASE_URL!,
        S3_ENDPOINT: endpoint!,
        S3_BUCKET_PUBLIC: "campus-public",
        S3_BUCKET_PRIVATE: "campus-private",
        NEXTAUTH_SECRET: "worker-it-env-validation-only",
      });

      try {
        // 轮询等待 worker 自动完成恢复（不手动调用任何清理函数）。
        // 宽窗口：全量套件并行时单周期可能因 DB 负载失败重试（幂等语义）
        const deadline = Date.now() + 35_000;
        let recovered = false;
        while (Date.now() < deadline) {
          const { row } = await readState(assetId);
          if (row?.status === "DELETED") {
            recovered = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        expect(recovered, `worker output: ${getOutput().slice(0, 500)}`).toBe(true);
        expect(await objectExists("campus-public", objectKey)).toBe(false);

        const { quota } = await readState(assetId);
        expect(quota).toBe(0);
      } finally {
        // 必须等 worker 真正退出：孤儿 loop worker 会在 1s 周期上回收
        // 后续用例（dry-run）的 PENDING_DELETE 种子
        await killTree(child);
      }
    }, 60_000);

    it("生产配置保护：production 下非法 interval（<60s）以非零退出", async () => {
      const result = await runWorker(["--run-once"], {
        NODE_ENV: "production",
        ASSET_CLEANUP_INTERVAL_SECONDS: "1",
        DATABASE_URL: process.env.DATABASE_URL!,
        S3_ENDPOINT: endpoint!,
        S3_BUCKET_PUBLIC: "campus-public",
        S3_BUCKET_PRIVATE: "campus-private",
        NEXTAUTH_SECRET: "worker-it-env-validation-only",
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/ASSET_CLEANUP_INTERVAL_SECONDS/);
    }, 30_000);

    it("--dry-run：只打印计划，不删除对象、不转移状态、不释放配额", async () => {
      const { objectKey, assetId } = await seedPostOutageState("dry-run");

      const result = await runWorker(["--run-once", "--dry-run"], {
        DATABASE_URL: process.env.DATABASE_URL!,
        S3_ENDPOINT: endpoint!,
        S3_BUCKET_PUBLIC: "campus-public",
        S3_BUCKET_PRIVATE: "campus-private",
        NEXTAUTH_SECRET: "worker-it-env-validation-only",
      });
      expect(result.code).toBe(0);

      const { row, quota } = await readState(assetId);
      expect(row!.status).toBe("PENDING_DELETE");
      expect(await objectExists("campus-public", objectKey)).toBe(true);
      expect(quota).toBe(SIZE_BYTES);
    }, 60_000);
  },
);
