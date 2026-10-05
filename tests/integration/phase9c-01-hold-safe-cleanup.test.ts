import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// 一次性隔离数据库生命周期辅助（与 production-cleanup-worker 套件同模式）
import { runPrismaCommand } from "../../scripts/resilience/spawn-worker.mjs";
import { GOVERNANCE_LOCK_NAMESPACE, waitForAdvisoryLockWaiter } from "./helpers/lock-barrier";
import type { StorageClient } from "@/lib/storage/types";

/**
 * Phase 9C-01：storage cleanup ↔ ACTIVE DataHold 真实竞态/阻断集成测试。
 *
 * 真实依赖：PostgreSQL（一次性隔离库，全量 migrate deploy）+ MinIO。
 * 被测对象：asset-service 的 hold-safe destructive boundary
 * （purgePendingDeleteAsset / markRetentionExpiredAssetPendingDelete）与
 * runStorageCleanup 的公平性预过滤——真实 advisory subject 锁 + 真实对象
 * 存储，不用 sleep 定序：
 * - 锁等待/持锁证据一律来自 pg_locks（lock-barrier helper 同款合同）；
 * - purge 内的确定性暂停点由 StorageClient seam（beforeDelete callback，
 *   asset-storage-fault 同款注入模式）提供——该点位于锁内 fresh hold 复核
 *   之后、S3 DeleteObject 之前。
 *
 * 场景：HOLD-01 / HOLD-02 / HOLD-RACE-01 / HOLD-RACE-02 /
 *       STORAGE-CRASH-01 / HOLD-RELEASE-01 / HOLD-FAIRNESS-01
 * （PRODUCTION-WORKER-HOLD-01 在 production-cleanup-worker.test.ts 以生产
 *   entrypoint 子进程覆盖。）
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

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

const PUBLIC_BUCKET = "campus-public";
const SIZE_BYTES = 4096;

async function objectExists(bucket: string, objectKey: string): Promise<boolean> {
  try {
    await s3!.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    return true;
  } catch {
    return false;
  }
}

/**
 * StorageClient seam（测试专用）：
 * - beforeDelete：在 S3 DeleteObject 之前执行的确定性暂停点（purge 事务内、
 *   subject 锁持有中、fresh hold 复核已通过）；
 * - afterDeleteError：S3 真实删除成功后注入异常（crash-after-external-success）。
 */
class PurgeSeamStorage implements StorageClient {
  deleteCalls = 0;

  constructor(
    private readonly real: StorageClient,
    private readonly options: {
      beforeDelete?: () => Promise<void>;
      afterDeleteError?: string;
    } = {},
  ) {}

  async deleteObject(ref: Parameters<StorageClient["deleteObject"]>[0]) {
    this.deleteCalls += 1;
    if (this.options.beforeDelete) {
      await this.options.beforeDelete();
    }
    await this.real.deleteObject(ref);
    if (this.options.afterDeleteError) {
      throw new Error(this.options.afterDeleteError);
    }
  }
  headBucket(bucket: string) {
    return this.real.headBucket(bucket);
  }
  putObject(input: Parameters<StorageClient["putObject"]>[0]) {
    return this.real.putObject(input);
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

/** 等待 subject advisory 锁已被某事务【持有】（granted）——HOLD-RACE-02 的 T1 持锁证据 */
async function waitForGrantedAdvisoryLock(
  client: PrismaClient,
  subjectKey: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await client.$queryRaw<{ objid: number }[]>`
      SELECT locks.objid
      FROM pg_locks locks
      WHERE locks.locktype = 'advisory'
        AND locks.granted
        AND locks.classid = ${GOVERNANCE_LOCK_NAMESPACE}::int
        AND hashtext(${subjectKey})::bit(32)::bigint = locks.objid`;
    if (rows.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`granted advisory-lock barrier 超时：${subjectKey} 未被持有`);
}

describe.skipIf(!integrationDatabaseUrl || !endpoint || !s3)(
  "Phase 9C-01 hold-safe cleanup（真实 PG + MinIO）",
  () => {
    type PrismaModule = typeof import("@/lib/prisma");
    type AssetServiceModule = typeof import("@/lib/asset-service");
    type CleanupModule = typeof import("@/lib/asset-cleanup");
    type HoldModule = typeof import("@/lib/privacy/data-hold-service");
    type StorageModule = typeof import("@/lib/storage");

    let prisma: PrismaModule["prisma"];
    let withTransaction: PrismaModule["withTransaction"];
    let purgePendingDeleteAsset: AssetServiceModule["purgePendingDeleteAsset"];
    let runStorageCleanup: CleanupModule["runStorageCleanup"];
    let createHold: HoldModule["createHold"];
    let releaseHold: HoldModule["releaseHold"];
    let setStorageForTests: StorageModule["setStorageForTests"];
    let realStorage: StorageClient;
    let rawClient: PrismaClient;

    let campusId: string;
    const users: Record<string, string> = {};
    const leftoverObjects: Array<{ bucket: string; objectKey: string }> = [];

    let isolatedDbName: string;
    const adminUrlFor = (url: string) => {
      const parsed = new URL(url);
      parsed.pathname = "/postgres";
      return parsed.toString();
    };

    beforeAll(async () => {
      const parsed = new URL(integrationDatabaseUrl!);
      isolatedDbName = `campus_9c01_it_${Date.now()}_${Math.random()
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
      realStorage = new S3Storage(new S3Client({
        endpoint: endpoint!,
        region: "us-east-1",
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.INTEGRATION_S3_ACCESS_KEY_ID ?? "minioadmin",
          secretAccessKey: process.env.INTEGRATION_S3_SECRET_ACCESS_KEY ?? "minioadmin",
        },
      }));

      ({ prisma, withTransaction } = await import("@/lib/prisma"));
      ({
        purgePendingDeleteAsset,
      } = await import("@/lib/asset-service"));
      ({ runStorageCleanup } = await import("@/lib/asset-cleanup"));
      ({ createHold, releaseHold } = await import("@/lib/privacy/data-hold-service"));
      ({ setStorageForTests } = (await import("@/lib/storage")) as StorageModule);
      rawClient = new PrismaClient({ datasources: { db: { url: isolatedUrl } }, log: ["error"] });

      const campus = await prisma.campus.create({
        data: {
          name: "9C-01 hold-safe 集成测试校区",
          slug: `it-9c01-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          schoolName: "集成测试大学",
        },
      });
      campusId = campus.id;
      for (const label of [
        "hold01",
        "hold02",
        "race01",
        "race02",
        "crash",
        "release",
        "fairHeld",
        "fairFree",
      ]) {
        const user = await prisma.user.create({
          data: {
            name: `9c01-${label}`,
            email: `9c01-${label}-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 6)}@campus.local`,
            passwordHash: "test-only",
            schoolName: "集成测试大学",
            campusId,
            storageUsedBytes: 0,
          },
        });
        users[label] = user.id;
      }
    }, 240_000);

    afterAll(async () => {
      for (const ref of leftoverObjects) {
        await realStorage.deleteObject(ref).catch(() => undefined);
      }
      await rawClient?.$disconnect();
      if (prisma) {
        await prisma.$disconnect();
        await runPrismaCommand(
          ["db", "execute", "--stdin"],
          { DATABASE_URL: adminUrlFor(integrationDatabaseUrl!) },
          `DROP DATABASE IF EXISTS "${isolatedDbName}" WITH (FORCE);`,
        );
      }
      setStorageForTests(null);
    }, 60_000);

    async function putPublicObject(objectKey: string): Promise<void> {
      await s3!.send(
        new PutObjectCommand({
          Bucket: PUBLIC_BUCKET,
          Key: objectKey,
          Body: Buffer.alloc(SIZE_BYTES),
          ContentType: "image/webp",
        }),
      );
      leftoverObjects.push({ bucket: PUBLIC_BUCKET, objectKey });
    }

    function newObjectKey(ownerId: string, label: string): string {
      return `public/products/${ownerId}/9c01-${label}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.webp`;
    }

    /** PENDING_DELETE 种子：对象存在 + 行 PENDING_DELETE + 配额占用 */
    async function seedPendingDeleteAsset(
      ownerId: string,
      label: string,
      createdAt = new Date(),
    ): Promise<{ assetId: string; objectKey: string }> {
      const objectKey = newObjectKey(ownerId, label);
      await putPublicObject(objectKey);
      const asset = await prisma.uploadedAsset.create({
        data: {
          ownerId,
          category: "PRODUCT",
          access: "PUBLIC",
          bucket: PUBLIC_BUCKET,
          objectKey,
          mimeType: "image/webp",
          sizeBytes: SIZE_BYTES,
          status: "PENDING_DELETE",
          createdAt,
        },
      });
      await prisma.user.update({
        where: { id: ownerId },
        data: { storageUsedBytes: { increment: SIZE_BYTES } },
      });
      return { assetId: asset.id, objectKey };
    }

    /** retention 到期种子：对象存在 + 行 UPLOADED + expiresAt 已过 + 配额占用 */
    async function seedRetentionExpiredAsset(
      ownerId: string,
      label: string,
    ): Promise<{ assetId: string; objectKey: string }> {
      const objectKey = newObjectKey(ownerId, label);
      await putPublicObject(objectKey);
      const asset = await prisma.uploadedAsset.create({
        data: {
          ownerId,
          category: "PRODUCT",
          access: "PUBLIC",
          bucket: PUBLIC_BUCKET,
          objectKey,
          mimeType: "image/webp",
          sizeBytes: SIZE_BYTES,
          status: "UPLOADED",
          expiresAt: new Date(Date.now() - 60_000),
        },
      });
      await prisma.user.update({
        where: { id: ownerId },
        data: { storageUsedBytes: { increment: SIZE_BYTES } },
      });
      return { assetId: asset.id, objectKey };
    }

    async function readRow(assetId: string) {
      return prisma.uploadedAsset.findUnique({ where: { id: assetId } });
    }

    async function quotaOf(userId: string): Promise<number> {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { storageUsedBytes: true },
      });
      return user?.storageUsedBytes ?? 0;
    }

    /** 计数型真实存储（无故障注入），每条用例复位 deleteCalls */
    function makeCountingStorage(): PurgeSeamStorage {
      return new PurgeSeamStorage(realStorage);
    }

    it("HOLD-01：retention 到期 + ACTIVE USER hold → 状态不推进、对象保留、配额不变、零 S3 删除", async () => {
      const { assetId, objectKey } = await seedRetentionExpiredAsset(users.hold01!, "hold01");
      await createHold({
        type: "LEGAL",
        subjectType: "USER",
        subjectId: users.hold01!,
        reasonCode: "IT_9C_HOLD01",
      });

      const counting = makeCountingStorage();
      setStorageForTests(counting);
      const summary = await runStorageCleanup({});

      expect(summary.retentionHoldBlocked).toBeGreaterThanOrEqual(1);
      expect(summary.retentionExpiredMarked).toBe(0);
      expect(summary.failures).toBe(0);

      const row = await readRow(assetId);
      expect(row!.status).toBe("UPLOADED"); // 保持原状态（未推进 retention lifecycle）
      expect(await objectExists(PUBLIC_BUCKET, objectKey)).toBe(true);
      expect(await quotaOf(users.hold01!)).toBe(SIZE_BYTES);
      expect(counting.deleteCalls).toBe(0);
    });

    it("HOLD-02：PENDING_DELETE + ACTIVE USER hold → S3 DeleteObject = 0、行/对象/配额保留", async () => {
      const { assetId, objectKey } = await seedPendingDeleteAsset(users.hold02!, "hold02");
      await createHold({
        type: "DISPUTE",
        subjectType: "USER",
        subjectId: users.hold02!,
        reasonCode: "IT_9C_HOLD02",
      });

      const counting = makeCountingStorage();
      setStorageForTests(counting);
      const summary = await runStorageCleanup({});

      expect(summary.purgeHoldBlocked).toBeGreaterThanOrEqual(1);
      expect(summary.objectsDeleted).toBe(0);
      expect(summary.failures).toBe(0);
      expect(counting.deleteCalls).toBe(0);

      const row = await readRow(assetId);
      expect(row!.status).toBe("PENDING_DELETE"); // 绝不因猜测 orphan 而删除（fail closed）
      expect(await objectExists(PUBLIC_BUCKET, objectKey)).toBe(true);
      expect(await quotaOf(users.hold02!)).toBe(SIZE_BYTES);
    });

    it("HOLD-RACE-01（cleanup wins）：cleanup 持锁确认无 hold 后完成删除，并发 createHold 阻塞到 cleanup 提交之后", async () => {
      const ownerKey = `USER:${users.race01!}`;
      const { assetId, objectKey } = await seedPendingDeleteAsset(users.race01!, "race01");

      let holdSettled = false;
      let resolveHoldId!: (holdId: string) => void;
      const holdSettledPromise = new Promise<string>((resolve) => {
        resolveHoldId = resolve;
      });

      const seam = new PurgeSeamStorage(realStorage, {
        beforeDelete: async () => {
          // purge 已持 subject 锁、fresh 复核无 hold —— 并发 createHold 阻塞在锁上
          const pendingHold = createHold({
            type: "LEGAL",
            subjectType: "USER",
            subjectId: users.race01!,
            reasonCode: "IT_RACE01_HOLD",
          }).then(
            (hold) => {
              holdSettled = true;
              return hold.id;
            },
            () => {
              holdSettled = true;
              return "";
            },
          );
          pendingHold.then(resolveHoldId);

          // deterministic barrier（pg_locks 证据）：createHold 已进入锁等待
          await waitForAdvisoryLockWaiter(rawClient, [ownerKey]);
          // cleanup 持锁期间 hold 不可能提交（lock ordering 的确定性断言）
          expect(holdSettled).toBe(false);
          // 返回后 purge 继续：S3 delete → DELETED 转移 → 配额释放 → COMMIT
        },
      });
      setStorageForTests(seam);

      // DB 时钟锚点（PG vs PG）：hold 的 INSERT 在锁释放后才执行，其
      // createdAt（PG now()）必然晚于 purge 开始前的 DB 时间戳。锁序证明
      // 本身由上方 barrier 确定性给出（holdSettled === false while lock
      // held）；此前的 JS 时钟对比（purgeDoneAt = new Date()）跨时钟源
      // 粒度在 CI 上会随机 ±2ms 误报，已替换为本锚点。
      const [dbBeforePurge] = await rawClient!.$queryRaw<{ ts: Date }[]>`
        SELECT now() AS ts
      `;

      const purge = await purgePendingDeleteAsset(assetId);
      expect(purge.outcome).toBe("PURGED");
      expect(purge.releasedQuotaBytes).toBe(SIZE_BYTES);

      expect(await objectExists(PUBLIC_BUCKET, objectKey)).toBe(false);
      const row = await readRow(assetId);
      expect(row!.status).toBe("DELETED");
      expect(await quotaOf(users.race01!)).toBe(0); // released exactly once

      // cleanup COMMIT 后并发 hold 才完成创建（合法顺序：cleanup wins）
      const holdId = await holdSettledPromise;
      expect(holdSettled).toBe(true);
      const hold = await prisma.dataHold.findUnique({ where: { id: holdId } });
      expect(hold).toBeTruthy();
      expect(hold!.status).toBe("ACTIVE");
      expect(hold!.createdAt.getTime()).toBeGreaterThanOrEqual(dbBeforePurge!.ts.getTime());
    });

    it("HOLD-RACE-02（hold wins）：hold 先持 serialization 锁并提交，cleanup 阻塞后锁内 fresh check 看到 ACTIVE hold", async () => {
      const ownerKey = `USER:${users.race02!}`;
      const { assetId, objectKey } = await seedPendingDeleteAsset(users.race02!, "race02");

      // T1 复刻 createHold 的锁内创建序列（acquireGovernanceSubjectLock →
      // dataHold.create，与 createHold 语句完全一致），持锁至 gate 放行
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      const { acquireGovernanceSubjectLock } = await import(
        "@/lib/governance/governance-lock"
      );
      const holdCommitted = withTransaction(async (tx) => {
        await acquireGovernanceSubjectLock(tx, "USER", users.race02!);
        // gate 由主流程在观察到 cleanup 锁等待后放行
        await gate;
        await tx.dataHold.create({
          data: {
            type: "LEGAL",
            subjectType: "USER",
            subjectId: users.race02!,
            reasonCode: "IT_RACE02_HOLD",
          },
        });
      });

      // 确定性证据 1：T1 已持有 subject 锁（granted）——此刻启动 cleanup 必然阻塞
      await waitForGrantedAdvisoryLock(rawClient, ownerKey);

      const counting = makeCountingStorage();
      setStorageForTests(counting);
      const purgePromise = purgePendingDeleteAsset(assetId);

      // 确定性证据 2（pg_locks）：cleanup 事务已进入锁等待
      await waitForAdvisoryLockWaiter(rawClient, [ownerKey]);
      expect(counting.deleteCalls).toBe(0); // 阻塞期间零外部副作用

      // hold 提交（锁释放）→ cleanup 恢复 → 锁内 fresh hold check 见 ACTIVE
      openGate();
      await holdCommitted;
      const purge = await purgePromise;

      expect(purge.outcome).toBe("HOLD_BLOCKED");
      expect(counting.deleteCalls).toBe(0);
      expect(await objectExists(PUBLIC_BUCKET, objectKey)).toBe(true);
      const row = await readRow(assetId);
      expect(row!.status).toBe("PENDING_DELETE");
      expect(await quotaOf(users.race02!)).toBe(SIZE_BYTES);
    });

    it("STORAGE-CRASH-01：S3 删除成功后事务注入失败 → 行保持 PENDING_DELETE、配额不动；下轮幂等收敛 exactly-once", async () => {
      const { assetId, objectKey } = await seedPendingDeleteAsset(users.crash!, "crash01");

      const crashSeam = new PurgeSeamStorage(realStorage, {
        afterDeleteError: "injected failure after S3 delete (crash seam)",
      });
      setStorageForTests(crashSeam);
      const first = await purgePendingDeleteAsset(assetId);
      expect(first.outcome).toBe("RETRYABLE_FAILURE");

      // 对象可能已不在远端（外部副作用已发生）……
      expect(await objectExists(PUBLIC_BUCKET, objectKey)).toBe(false);
      // ……但 recovery authority 完整保留：行 PENDING_DELETE、配额保持占用
      const row = await readRow(assetId);
      expect(row!.status).toBe("PENDING_DELETE");
      expect(await quotaOf(users.crash!)).toBe(SIZE_BYTES);

      // 下轮 cleanup：DeleteObject 对缺失对象幂等 → DELETED + 配额 exactly-once
      const counting = makeCountingStorage();
      setStorageForTests(counting);
      const summary = await runStorageCleanup({});
      expect(summary.objectsDeleted).toBeGreaterThanOrEqual(1);

      const recovered = await readRow(assetId);
      expect(recovered!.status).toBe("DELETED");
      expect(await quotaOf(users.crash!)).toBe(0);

      // replay 幂等：再次 purge 不二次释放
      const repeat = await purgePendingDeleteAsset(assetId);
      expect(repeat.outcome).toBe("NOOP");
      expect(await quotaOf(users.crash!)).toBe(0);
    });

    it("HOLD-RELEASE-01：hold 阻断 cleanup → releaseHold → 下轮收敛（对象删除、DELETED、配额释放）", async () => {
      const { assetId, objectKey } = await seedPendingDeleteAsset(users.release!, "release01");
      const hold = await createHold({
        type: "LEGAL",
        subjectType: "USER",
        subjectId: users.release!,
        reasonCode: "IT_9C_RELEASE01",
      });

      const blocked = makeCountingStorage();
      setStorageForTests(blocked);
      const blockedSummary = await runStorageCleanup({});
      expect(blockedSummary.purgeHoldBlocked).toBeGreaterThanOrEqual(1);
      expect(blocked.deleteCalls).toBe(0);
      expect((await readRow(assetId))!.status).toBe("PENDING_DELETE");
      expect(await objectExists(PUBLIC_BUCKET, objectKey)).toBe(true);
      expect(await quotaOf(users.release!)).toBe(SIZE_BYTES);

      await releaseHold(hold.id);

      const counting = makeCountingStorage();
      setStorageForTests(counting);
      const summary = await runStorageCleanup({});
      expect(summary.objectsDeleted).toBeGreaterThanOrEqual(1);
      expect(summary.failures).toBe(0);
      expect((await readRow(assetId))!.status).toBe("DELETED");
      expect(await objectExists(PUBLIC_BUCKET, objectKey)).toBe(false);
      expect(await quotaOf(users.release!)).toBe(0);
    });

    it("HOLD-FAIRNESS-01：held 行不造成队头阻塞，unheld 资产在同一周期被处理", async () => {
      // hold 保持 ACTIVE（隔离库整体 drop，无需清理；held 行在本套件后续
      // discovery 中继续被预过滤）
      await createHold({
        type: "DISPUTE",
        subjectType: "USER",
        subjectId: users.fairHeld!,
        reasonCode: "IT_9C_FAIRNESS",
      });

      // 5 条 held PENDING_DELETE（较早）先入队，batchLimit=4：
      // 若无 hold 预过滤，FIFO batch 将全部被 held 行占据
      const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
      const heldAssets: Array<{ assetId: string; objectKey: string }> = [];
      for (let i = 0; i < 5; i += 1) {
        heldAssets.push(await seedPendingDeleteAsset(users.fairHeld!, `fair-held-${i}`, tenMinutesAgo));
      }
      // unheld 资产较晚创建（FIFO 队尾）
      const freeAsset = await seedPendingDeleteAsset(users.fairFree!, "fair-free");

      const counting = makeCountingStorage();
      setStorageForTests(counting);
      const summary = await runStorageCleanup({ batchLimit: 4 });

      // unheld 资产被处理
      expect((await readRow(freeAsset.assetId))!.status).toBe("DELETED");
      expect(await objectExists(PUBLIC_BUCKET, freeAsset.objectKey)).toBe(false);
      expect(await quotaOf(users.fairFree!)).toBe(0);

      // held 行全部原样保留（对象、行、配额）
      for (const asset of heldAssets) {
        expect((await readRow(asset.assetId))!.status).toBe("PENDING_DELETE");
        expect(await objectExists(PUBLIC_BUCKET, asset.objectKey)).toBe(true);
      }
      expect(await quotaOf(users.fairHeld!)).toBe(5 * SIZE_BYTES);
      expect(summary.purgeHoldBlocked).toBeGreaterThanOrEqual(5);
      expect(summary.failures).toBe(0);
    });
  },
);
