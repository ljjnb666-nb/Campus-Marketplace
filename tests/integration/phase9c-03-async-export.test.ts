import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runPrismaCommand } from "../../scripts/resilience/spawn-worker.mjs";
import { GOVERNANCE_LOCK_NAMESPACE } from "./helpers/lock-barrier";
import type { StorageClient } from "@/lib/storage/types";

/**
 * Phase 9C-03（ASYNC DURABLE DATA EXPORT）集成测试（真实 PostgreSQL + MinIO）。
 *
 * 第一红线（§16/§53）：
 *   ASYNC-EXPORT-LARGE-01 —— 真实序列化 > 8 MiB 的导出在 async 管道上成功：
 *   request COMPLETED + artifact READY + job COMPLETED + 下载 200 + JSON
 *   parse 成功（旧同步 8 MiB blocker 消失的真实证据，不是 mock byteLength）。
 *
 * crash / replay / ambiguous PUT（§12/§13/§49）：
 *   EXPORT-CRASH-01  PUT success → READY commit 前 fail → retry → 同一
 *                    objectKey → 恰一个对象 → COMPLETED
 *   EXPORT-CRASH-02  domain COMPLETED commit → job marker 前 crash →
 *                    replay → COMPLETED_IDEMPOTENT → 无第二 artifact
 *
 * storage failure（§50）：
 *   EXPORT-STORAGE-RETRY-01   attempt1 瞬态失败 → RETRY（request 合法
 *                             非终态）→ attempt2 READY + COMPLETED
 *   EXPORT-STORAGE-TERMINAL-01 retry 预算耗尽 → DEAD_LETTER → scoped
 *                             reconciler 收敛 REJECTED（不可下载、不卡死）
 *
 * erasure race（§22/§23/§51，真实 PG advisory-lock barrier，零 sleep）：
 *   EXPORT-ERASE-RACE-01  export wins → erasure 跟进 → artifact
 *                         PENDING_DELETE → 下载拒绝
 *   EXPORT-ERASE-RACE-02  erasure wins → worker 不得 READY/COMPLETED →
 *                         REJECTED + 对象受 cleanup 追踪
 *
 * cleanup（§27/§28/§55）：
 *   EXPORT-CLEANUP-01  到期 READY → PENDING_DELETE → DeleteObject →
 *                      DELETED；DeleteObject success + DB fail → 下轮重试；
 *                      two cleanup workers → one logical DELETED transition
 *
 * 下载守卫（§32/§33/§52）：跨用户与不存在同形（anti-oracle）、未就绪/已
 * 拒绝/已过期/对象缺失的稳定语义。
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

// EXPORT-SECURITY-PERMANENT-01 专用 seam：默认透传真实 buildUserExport，
// 单个测试用 mockImplementationOnce 注入运行时含禁止键的恶意载荷（测试
// 可绕开 TS 类型构造）。factory 惰性执行——首次动态 import 时才触发，
// 隔离库 DATABASE_URL 已由 beforeAll 就位。
vi.mock("@/lib/privacy/data-export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/privacy/data-export")>();
  return {
    ...actual,
    buildUserExport: vi.fn(actual.buildUserExport),
  };
});

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

const PRIVATE_BUCKET = "campus-private";

async function objectExists(bucket: string, objectKey: string): Promise<boolean> {
  try {
    await s3!.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    return true;
  } catch {
    return false;
  }
}

async function listUserExportObjects(userId: string): Promise<string[]> {
  const result = await s3!.send(
    new ListObjectsV2Command({
      Bucket: PRIVATE_BUCKET,
      Prefix: `private/data-exports/${userId}/`,
    }),
  );
  return (result.Contents ?? []).map((entry) => entry.Key ?? "").filter(Boolean);
}

type PutFault = "none" | "throw-before" | "throw-after-success";

/**
 * StorageClient seam（测试专用，asset-storage-fault 同款注入模式）：
 * - putFault = throw-after-success：真实 PUT 已提交 MinIO 后抛错——
 *   ambiguous PUT 语义（LR-071）：客户端错误 ≠ 远端对象确定缺席；
 * - putFault = throw-before：请求未发出（瞬态传输失败）；
 * - deleteFaultKey（once）：对指定 objectKey 的 DeleteObject 在真实成功后
 *   抛错一次（crash-after-external-success，仅定向命中目标 artifact，
 *   不误伤同批其它删除）；下轮 cleanup 重试收敛。
 */
class ExportFaultStorage implements StorageClient {
  putCalls = 0;
  deleteCalls = 0;
  private faultedDeleteKeys = new Set<string>();

  constructor(
    private readonly real: StorageClient,
    private readonly options: {
      putFault?: PutFault;
      deleteFaultKey?: string;
    } = {},
  ) {}

  async putObject(input: Parameters<StorageClient["putObject"]>[0]) {
    this.putCalls += 1;
    if (this.options.putFault === "throw-before") {
      throw new Error("ETIMEDOUT: controlled transient transport failure");
    }
    await this.real.putObject(input);
    if (this.options.putFault === "throw-after-success") {
      throw new Error("controlled ambiguous put failure（对象已提交）");
    }
  }

  async deleteObject(ref: Parameters<StorageClient["deleteObject"]>[0]) {
    this.deleteCalls += 1;
    await this.real.deleteObject(ref);
    if (
      ref.objectKey === this.options.deleteFaultKey &&
      !this.faultedDeleteKeys.has(ref.objectKey)
    ) {
      this.faultedDeleteKeys.add(ref.objectKey);
      throw new Error("controlled crash after successful delete");
    }
  }

  headBucket(bucket: string) {
    return this.real.headBucket(bucket);
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

/** 等待 subject advisory 锁已被某事务【持有】（granted）——ERASE-RACE-01 barrier */
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
  "Phase 9C-03 async data export（真实 PG + MinIO）",
  () => {
  type PrismaModule = typeof import("@/lib/prisma");
  type AsyncModule = typeof import("@/lib/privacy/data-export-async");
  type ArtifactModule = typeof import("@/lib/privacy/data-export-artifact");
  type DownloadModule = typeof import("@/lib/privacy/data-export-download");
  type CleanupModule = typeof import("@/lib/privacy/data-export-cleanup");
  type RunnerModule = typeof import("@/lib/async/job-runner");
  type ErasureModule = typeof import("@/lib/privacy/account-erasure");
  type StorageModule = typeof import("@/lib/storage");

  let prisma: PrismaModule["prisma"];
  let withTransaction: PrismaModule["withTransaction"];
  let createAsyncDataExportRequest: AsyncModule["createAsyncDataExportRequest"];
  let processDataExportGenerateJob: AsyncModule["processDataExportGenerateJob"];
  let reconcileDataExportDeadLetters: AsyncModule["reconcileDataExportDeadLetters"];
  let markArtifactDeletedIfPendingDelete: ArtifactModule["markArtifactDeletedIfPendingDelete"];
  let readExportArtifactForDownload: DownloadModule["readExportArtifactForDownload"];
  let runDataExportArtifactCleanup: CleanupModule["runDataExportArtifactCleanup"];
  let runAsyncJobBatchOnce: RunnerModule["runAsyncJobBatchOnce"];
  let eraseAccount: ErasureModule["eraseAccount"];
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

  async function createFixtureUser(label: string) {
    const user = await rawClient.user.create({
      data: {
        name: `9c03-${label}`,
        email: `9c03-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@campus.local`,
        passwordHash: "test-only",
        schoolName: "集成测试大学",
        campusId,
        storageUsedBytes: 0,
      },
    });
    await rawClient.campusMembership.create({
      data: { userId: user.id, campusId, status: "ACTIVE" },
    });
    users[label] = user.id;
    return user.id;
  }

  /**
   * LARGE-01 大数据 fixture：单会话 N 条 70KB 消息（本人发送）→
   * messagesSent 段主导序列化体积。160 × 70KB ≈ 11.2 MB（> 8 MiB 旧
   * sync blocker，< 32 MiB async 上界）。
   */
  async function createLargeMessageFixture(userId: string, messageCount: number) {
    const conversation = await rawClient.conversation.create({
      data: {
        participants: {
          create: [{ userId }],
        },
      },
    });
    const chunk = "x".repeat(70_000);
    await rawClient.message.createMany({
      data: Array.from({ length: messageCount }, () => ({
        conversationId: conversation.id,
        senderId: userId,
        content: chunk,
      })),
    });
  }

  beforeAll(async () => {
    const parsed = new URL(integrationDatabaseUrl!);
    isolatedDbName = `campus_9c03_it_${Date.now()}_${Math.random()
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
    realStorage = new S3Storage(
      new S3Client({
        endpoint: endpoint!,
        region: "us-east-1",
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.INTEGRATION_S3_ACCESS_KEY_ID ?? "minioadmin",
          secretAccessKey: process.env.INTEGRATION_S3_SECRET_ACCESS_KEY ?? "minioadmin",
        },
      }),
    );
    ({ setStorageForTests } = (await import("@/lib/storage")) as StorageModule);
    setStorageForTests(realStorage);

    // bucket 兜底（compose minio-init 通常已建；integration 环境自愈）
    try {
      await s3!.send(new HeadBucketCommand({ Bucket: PRIVATE_BUCKET }));
    } catch {
      await s3!.send(new CreateBucketCommand({ Bucket: PRIVATE_BUCKET }));
    }

    ({ prisma, withTransaction } = await import("@/lib/prisma"));
    ({
      createAsyncDataExportRequest,
      processDataExportGenerateJob,
      reconcileDataExportDeadLetters,
    } = await import("@/lib/privacy/data-export-async"));
    ({ markArtifactDeletedIfPendingDelete } = await import("@/lib/privacy/data-export-artifact"));
    ({ readExportArtifactForDownload } = await import("@/lib/privacy/data-export-download"));
    ({ runDataExportArtifactCleanup } = await import("@/lib/privacy/data-export-cleanup"));
    ({ runAsyncJobBatchOnce } = await import("@/lib/async/job-runner"));
    ({ eraseAccount } = await import("@/lib/privacy/account-erasure"));
    rawClient = new PrismaClient({ datasources: { db: { url: isolatedUrl } }, log: ["error"] });

    const campus = await rawClient.campus.create({
      data: {
        name: "9C-03 导出集成测试校区",
        slug: `it-9c03-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        schoolName: "集成测试大学",
      },
    });
    campusId = campus.id;
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

  /** 生产 runner 驱动：有界轮次内反复跑真实 batch（每轮前把本 fixture job
   * 的 runAt 提前到 now——TEST-ONLY 时钟控制，对齐 9B e2e 的 deadline
   * advance 惯例；backoff 等待期间零 sleep）。返回末次 job 行。 */
  async function runExportJobUntil(
    requestId: string,
    expected: (job: { status: string; attempts: number }) => boolean,
    maxRounds = 10,
  ) {
    let job = await rawClient.asyncJob.findUniqueOrThrow({
      where: { dedupeKey: `DATA_EXPORT_GENERATE:${requestId}` },
    });
    for (let round = 0; round < maxRounds && !expected(job); round += 1) {
      await rawClient.asyncJob.update({
        where: { id: job.id },
        data: { runAt: new Date() },
      });
      await runAsyncJobBatchOnce();
      job = await rawClient.asyncJob.findUniqueOrThrow({ where: { id: job.id } });
    }
    return job;
  }

  async function requestRow(requestId: string) {
    return rawClient.privacyRequest.findUniqueOrThrow({ where: { id: requestId } });
  }

  async function artifactRow(requestId: string) {
    return rawClient.dataExportArtifact.findUniqueOrThrow({ where: { requestId } });
  }

  it("ASYNC-EXPORT-LARGE-01：>8 MiB 真实导出全链成功（COMPLETED + READY + 下载 200 + JSON parse）", async () => {
    const userId = await createFixtureUser("large");
    await createLargeMessageFixture(userId, 160);

    const { request } = await createAsyncDataExportRequest(userId);
    const job = await runExportJobUntil(request.id, (row) => row.status === "COMPLETED");
    expect(job.status).toBe("COMPLETED");
    expect(job.attempts).toBeGreaterThanOrEqual(2); // Step A + Step B

    const requestAfter = await requestRow(request.id);
    expect(requestAfter.status).toBe("COMPLETED");
    expect(requestAfter.completedAt).toBeTruthy();

    const artifact = await artifactRow(request.id);
    expect(artifact.status).toBe("READY");
    expect(artifact.sha256).toBeTruthy();
    expect(artifact.expiresAt).toBeTruthy();

    // 第一红线核心：序列化体积真实超过旧同步 8 MiB blocker
    //（旧 buildUserExport 的 EXPORT_MAX_BYTES guard 会直接 DATA_EXPORT_TOO_LARGE）
    expect(artifact.sizeBytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(artifact.sizeBytes).toBeLessThanOrEqual(32 * 1024 * 1024);

    // 对象真实存在且可完整读回
    expect(await objectExists(artifact.bucket, artifact.objectKey)).toBe(true);
    leftoverObjects.push({ bucket: artifact.bucket, objectKey: artifact.objectKey });

    const download = await readExportArtifactForDownload(request.id, userId);
    expect(download.ok).toBe(true);
    if (!download.ok) return;

    expect(download.filename).toBe(`campus-data-export-${request.id}.json`);
    expect(download.sizeBytes).toBe(artifact.sizeBytes);
    const payload = JSON.parse(download.body.toString("utf8"));
    expect(payload.format).toBe("campus-marketplace.user-export/v3");
    expect(payload.account.id).toBe(userId);
    expect(payload.messagesSent).toHaveLength(160);

    // request 生命周期恰好一次；TTL 从 READY 起算（24h）
    const ttlHours =
      (artifact.expiresAt!.getTime() - requestAfter.completedAt!.getTime()) / 3_600_000;
    expect(ttlHours).toBeGreaterThan(23.9);
    expect(ttlHours).toBeLessThan(24.1);
  });

  it("EXPORT-ARTIFACT-FK-GUARD-01（RB03）：存在未收敛 artifact 时 parent 物理删除被 DB 拒绝（recovery metadata 不得 cascade 消失）", async () => {
    const userId = await createFixtureUser("fk-guard");
    const { request } = await createAsyncDataExportRequest(userId);
    await runExportJobUntil(request.id, (row) => row.status === "COMPLETED");

    const artifact = await artifactRow(request.id);
    expect(artifact.status).toBe("READY"); // 未收敛 = S3 对象的恢复元数据仍被本行持有

    // DELETE PrivacyRequest → FK Restrict 拒绝（P2003）
    await expect(
      rawClient.privacyRequest.delete({ where: { id: request.id } }),
    ).rejects.toMatchObject({ code: "P2003" });

    // DELETE User → 同样拒绝（对象恢复元数据不得随 parent 消失）
    await expect(rawClient.user.delete({ where: { id: userId } })).rejects.toMatchObject({
      code: "P2003",
    });

    // DB 行确实原样保留（零副作用）
    expect((await artifactRow(request.id)).status).toBe("READY");
    expect(await requestRow(request.id)).toMatchObject({ status: "COMPLETED" });

    // 收敛后 tombstone 同样受 FK 保护（DELETED 行仍持有恢复/审计元数据）
    await rawClient.dataExportArtifact.update({
      where: { id: artifact.id },
      data: { status: "PENDING_DELETE", expiresAt: new Date(Date.now() - 1_000) },
    });
    await runDataExportArtifactCleanup({ batchLimit: 10 });
    expect((await artifactRow(request.id)).status).toBe("DELETED");
    await expect(
      rawClient.privacyRequest.delete({ where: { id: request.id } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("EXPORT-CRASH-01：PUT success → READY commit 前 fail → retry → 同一 objectKey、恰一个对象、COMPLETED", async () => {
    const userId = await createFixtureUser("crash01");
    const { request } = await createAsyncDataExportRequest(userId);

    // Step A（prepare anchor）
    await runExportJobUntil(request.id, (row) => row.status === "RETRY" || row.attempts >= 1);
    let artifact = await artifactRow(request.id);
    expect(artifact.status).toBe("WRITING");

    // Step B 首轮：真实 PUT 提交后注入失败（ambiguous PUT）
    const faulted = new ExportFaultStorage(realStorage, {
      putFault: "throw-after-success",
    });
    setStorageForTests(faulted);

    await rawClient.asyncJob.update({
      where: { dedupeKey: `DATA_EXPORT_GENERATE:${request.id}` },
      data: { runAt: new Date() },
    });
    const summary = await runAsyncJobBatchOnce();
    expect(summary.retried).toBeGreaterThanOrEqual(1);

    // ambiguous PUT 后对象可能已在远端：key 必须已被 WRITING 行 durable 追踪
    artifact = await artifactRow(request.id);
    expect(artifact.status).toBe("WRITING");
    const requestMid = await requestRow(request.id);
    expect(requestMid.status).toBe("IN_PROGRESS");

    // 恢复真实存储 → retry 覆盖同一 key → 收敛 COMPLETED
    setStorageForTests(realStorage);
    const job = await runExportJobUntil(request.id, (row) => row.status === "COMPLETED");
    expect(job.status).toBe("COMPLETED");

    const artifacts = await rawClient.dataExportArtifact.findMany({
      where: { requestId: request.id },
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.status).toBe("READY");
    expect(artifacts[0]!.objectKey).toBe(artifact.objectKey); // deterministic key 不变

    // INV-9C03-06：重放/歧义 PUT 不产生 orphan 副本——用户前缀下恰一个对象
    const keys = await listUserExportObjects(userId);
    expect(keys).toEqual([artifact.objectKey]);
    leftoverObjects.push({ bucket: artifacts[0]!.bucket, objectKey: artifacts[0]!.objectKey });
  });

  it("EXPORT-CRASH-02：domain COMPLETED commit → marker 前 crash → replay COMPLETED_IDEMPOTENT、无第二 artifact", async () => {
    const userId = await createFixtureUser("crash02");
    const { request } = await createAsyncDataExportRequest(userId);

    // Step A + Step B 正常完成 domain 提交
    await runExportJobUntil(request.id, (row) => row.status === "COMPLETED");

    // crash-replay 模拟：worker 在 domain COMMIT 后、completion marker 前
    // 崩溃——job 停在 RUNNING 且 lease 已过期（crash recovery reclaim 路径）
    await rawClient.asyncJob.update({
      where: { dedupeKey: `DATA_EXPORT_GENERATE:${request.id}` },
      data: { status: "RUNNING", leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    const replay = await runAsyncJobBatchOnce();

    const job = await rawClient.asyncJob.findUniqueOrThrow({
      where: { dedupeKey: `DATA_EXPORT_GENERATE:${request.id}` },
    });
    expect(job.status).toBe("COMPLETED");
    expect(replay.leaseRecovered).toBeGreaterThanOrEqual(1);
    expect(replay.idempotentNoOp).toBeGreaterThanOrEqual(1);

    const artifacts = await rawClient.dataExportArtifact.findMany({
      where: { requestId: request.id },
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.status).toBe("READY");

    const keys = await listUserExportObjects(userId);
    expect(keys).toHaveLength(1);
    leftoverObjects.push({ bucket: artifacts[0]!.bucket, objectKey: artifacts[0]!.objectKey });
  });

  it("EXPORT-STORAGE-RETRY-01：attempt1 瞬态失败 → RETRY（request 合法非终态）→ attempt2 READY + COMPLETED", async () => {
    const userId = await createFixtureUser("storage-retry");
    const { request } = await createAsyncDataExportRequest(userId);

    await runExportJobUntil(request.id, (row) => row.attempts >= 1);

    const faulted = new ExportFaultStorage(realStorage, { putFault: "throw-before" });
    setStorageForTests(faulted);

    await rawClient.asyncJob.update({
      where: { dedupeKey: `DATA_EXPORT_GENERATE:${request.id}` },
      data: { runAt: new Date() },
    });
    const summary = await runAsyncJobBatchOnce();
    expect(summary.retried).toBeGreaterThanOrEqual(1);

    // request 保持合法非终态；零对象落盘（PUT 从未发出）
    const requestMid = await requestRow(request.id);
    expect(requestMid.status).toBe("IN_PROGRESS");
    const artifactMid = await artifactRow(request.id);
    expect(artifactMid.status).toBe("WRITING");
    expect(faulted.putCalls).toBe(1);
    expect(await objectExists(artifactMid.bucket, artifactMid.objectKey)).toBe(false);

    setStorageForTests(realStorage);
    const job = await runExportJobUntil(request.id, (row) => row.status === "COMPLETED");
    expect(job.status).toBe("COMPLETED");

    const artifact = await artifactRow(request.id);
    expect(artifact.status).toBe("READY");
    leftoverObjects.push({ bucket: artifact.bucket, objectKey: artifact.objectKey });
  });

  it("EXPORT-STORAGE-TERMINAL-01：retry 预算耗尽 → DEAD_LETTER → reconciler 收敛 REJECTED（不可下载、不卡死）", async () => {
    const userId = await createFixtureUser("storage-terminal");
    const { request } = await createAsyncDataExportRequest(userId);

    await runExportJobUntil(request.id, (row) => row.attempts >= 1);

    // fixture seam：压缩 retry 预算（真实 claim/fail 语义不变）
    const jobRow = await rawClient.asyncJob.findUniqueOrThrow({
      where: { dedupeKey: `DATA_EXPORT_GENERATE:${request.id}` },
    });
    await rawClient.asyncJob.update({
      where: { id: jobRow.id },
      data: { maxAttempts: 2 },
    });

    const faulted = new ExportFaultStorage(realStorage, { putFault: "throw-before" });
    setStorageForTests(faulted);

    const job = await runExportJobUntil(request.id, (row) => row.status === "DEAD_LETTER");
    expect(job.status).toBe("DEAD_LETTER");
    setStorageForTests(realStorage);

    // budget 耗尽后 request 仍非终态（generic runner 边界外的残余面）
    const beforeReconcile = await requestRow(request.id);
    expect(beforeReconcile.status).toBe("IN_PROGRESS");

    const reconciliation = await reconcileDataExportDeadLetters({ batchLimit: 10 });
    expect(reconciliation.convergedRequests).toBeGreaterThanOrEqual(1);
    expect(reconciliation.artifactsMarkedForDeletion).toBeGreaterThanOrEqual(1);

    const requestAfter = await requestRow(request.id);
    expect(requestAfter.status).toBe("REJECTED");
    expect(requestAfter.reasonCode).toBe("DATA_EXPORT_GENERATION_FAILED");

    const artifact = await artifactRow(request.id);
    expect(artifact.status).toBe("PENDING_DELETE");

    // 不可下载 + 幂等（再次扫描零收敛）
    const download = await readExportArtifactForDownload(request.id, userId);
    expect(download.ok).toBe(false);
    expect(await reconcileDataExportDeadLetters({ batchLimit: 10 })).toMatchObject({
      convergedRequests: 0,
    });
  });

  it("EXPORT-STORAGE-LOG-REDACTION-01（RB04）：data-export PUT/DELETE 失败日志零 raw locator（opaque diagnosticRef）", async () => {
    const userId = await createFixtureUser("log-redaction");
    const { request } = await createAsyncDataExportRequest(userId);
    await runExportJobUntil(request.id, (row) => row.attempts >= 1);
    const artifact = await artifactRow(request.id); // WRITING anchor

    // 不可达 endpoint 的真实 S3Storage：真实失败路径 → logWriteFailure
    // 真实触发（而非测试自造日志）。requestTimeout 1s + maxAttempts 1
    // 保证失败快速且确定。
    const { S3Storage } = await import("@/lib/storage/s3-storage");
    const { S3Client } = await import("@aws-sdk/client-s3");
    const unreachable = new S3Storage(
      new S3Client({
        endpoint: "http://127.0.0.1:9",
        region: "us-east-1",
        forcePathStyle: true,
        credentials: { accessKeyId: "it-unreachable", secretAccessKey: "it-unreachable" },
        requestHandler: { requestTimeout: 1000, maxAttempts: 1 } as never,
      }),
    );
    setStorageForTests(unreachable);

    const loggerModule = await import("@/lib/logger");
    const warnSpy = vi.spyOn(loggerModule.logger, "warn");
    const errorSpy = vi.spyOn(loggerModule.logger, "error");

    try {
      // ---- PUT 路径：真实 runner → handler Step B → putObject 失败 ----
      await rawClient.asyncJob.update({
        where: { dedupeKey: `DATA_EXPORT_GENERATE:${request.id}` },
        data: { runAt: new Date() },
      });
      await runAsyncJobBatchOnce();

      const putLogs = warnSpy.mock.calls
        .filter((call) => call[1] === "S3Storage")
        .map((call) => JSON.stringify(call[2] ?? {}));
      expect(putLogs.length).toBeGreaterThanOrEqual(1);

      const joinedPut = putLogs.join('\n');
      for (const forbidden of [
        artifact.bucket,
        artifact.objectKey,
        "private/data-exports/",
        userId,
        request.id,
        "127.0.0.1",
      ]) {
        expect(joinedPut.includes(forbidden)).toBe(false);
      }

      // 机器诊断字段完整保留（errorClass/ambiguous/attempts/durationMs）
      const putFields = JSON.parse(putLogs[0]!);
      expect(putFields).toMatchObject({
        operation: "putObject",
        event: "storage_write_failure",
        locator: `data-export:${artifact.id}`,
      });
      expect(typeof putFields.errorClass).toBe("string");
      expect(typeof putFields.ambiguous).toBe("boolean");
      expect(typeof putFields.attempts).toBe("number");
      expect(typeof putFields.durationMs).toBe("number");

      // 连接失败 = RETRYABLE（既有分类不变）；安全字段仅在 PERMANENT 路径收敛
      const jobAfterPut = await rawClient.asyncJob.findUniqueOrThrow({
        where: { dedupeKey: `DATA_EXPORT_GENERATE:${request.id}` },
      });
      expect(jobAfterPut.status).toBe("RETRY");

      // ---- DELETE 路径：cleanup 对 PENDING_DELETE 删除失败 → 同策略 ----
      warnSpy.mockClear();
      await rawClient.dataExportArtifact.update({
        where: { id: artifact.id },
        data: { status: "PENDING_DELETE" },
      });
      const cleanupSummary = await runDataExportArtifactCleanup({ batchLimit: 10 });
      expect(cleanupSummary.failures).toBeGreaterThanOrEqual(1);

      const deleteLogs = warnSpy.mock.calls
        .filter((call) => call[1] === "S3Storage")
        .map((call) => JSON.stringify(call[2] ?? {}));
      expect(deleteLogs.length).toBeGreaterThanOrEqual(1);
      const joinedDelete = deleteLogs.join('\n');
      for (const forbidden of [
        artifact.bucket,
        artifact.objectKey,
        "private/data-exports/",
        userId,
        request.id,
        "127.0.0.1",
      ]) {
        expect(joinedDelete.includes(forbidden)).toBe(false);
      }
      // 本套件更早用例可能遗留其它 PENDING_DELETE artifact（updatedAt 更早
      // 排前）——断言：全部日志均为 opaque data-export:<artifactId> locator，
      // 且包含本 artifact 的 ref（排重处理顺序不敏感）
      const deleteFields = deleteLogs.map((entry) => JSON.parse(entry) as { locator: string });
      expect(
        deleteFields.some((fields) => fields.locator === `data-export:${artifact.id}`),
      ).toBe(true);
      expect(
        deleteFields.every(
          (fields) => typeof fields.locator === "string" && fields.locator.startsWith("data-export:"),
        ),
      ).toBe(true);

      // cleanup 自身的 error 日志只含 errorName（S3 message 可能内嵌 locator）
      const cleanupErrorLogs = errorSpy.mock.calls
        .filter((call) => call[1] === "data-export-cleanup")
        .map((call) => JSON.stringify(call[2] ?? {}));
      expect(cleanupErrorLogs.length).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(cleanupErrorLogs[0]!).errorName).toBeTruthy();
      const cleanupErrorText = cleanupErrorLogs.join('\n');
      expect(cleanupErrorText.includes(artifact.objectKey)).toBe(false);
      expect(cleanupErrorText.includes("private/data-exports/")).toBe(false);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      setStorageForTests(realStorage);
    }

    // 收敛：request REJECTED（artifact 已 PENDING_DELETE）+ 对象受追踪，最终物理收敛
    const reconciliation = await reconcileDataExportDeadLetters({ batchLimit: 10 });
    void reconciliation; // 本路径 job 未 DEAD_LETTER（RETRY 中）——手动收敛该 fixture
    await rawClient.privacyRequest.update({
      where: { id: request.id },
      data: { status: "REJECTED", reasonCode: "DATA_EXPORT_GENERATION_FAILED" },
    });
    const secondCleanup = await runDataExportArtifactCleanup({ batchLimit: 10 });
    expect(secondCleanup.objectsDeleted).toBeGreaterThanOrEqual(1);
    expect((await artifactRow(request.id)).status).toBe("DELETED");
  });

  it("EXPORT-ERASE-RACE-01：export completion wins → erasure 跟进 → PENDING_DELETE + 下载拒绝（真实锁 barrier）", async () => {
    const userId = await createFixtureUser("erase-race-01");
    const { request } = await createAsyncDataExportRequest(userId);

    await runExportJobUntil(request.id, (row) => row.attempts >= 1);

    // Step B 在锁内 afterCheck 处挂起（已持 USER 锁 + fresh active 复核通过）
    let releaseStepB!: () => void;
    const stepBGate = new Promise<void>((resolve) => {
      releaseStepB = resolve;
    });
    let signalAfterCheck!: () => void;
    const afterCheck = new Promise<void>((resolve) => {
      signalAfterCheck = resolve;
    });

    await rawClient.asyncJob.update({
      where: { dedupeKey: `DATA_EXPORT_GENERATE:${request.id}` },
      data: { runAt: new Date() },
    });

    const claimTx = withTransaction((tx) =>
      (async () => {
        const { claimDueAsyncJobs } = await import("@/lib/async/job-repository");
        const claimed = await claimDueAsyncJobs(tx, {
          workerId: "it-9c03-erase-race-01",
          leaseSeconds: 120,
          batchSize: 10,
        });
        return claimed.find(
          (candidate) =>
            candidate.kind === "DATA_EXPORT_GENERATE" &&
            (candidate.payload as { requestId?: string }).requestId === request.id,
        );
      })(),
    );
    const job = await claimTx;
    expect(job).toBeTruthy();

    const stepB = withTransaction((tx) =>
      processDataExportGenerateJob(tx, job!, {
        activeAccountSeams: {
          afterCheck: async () => {
            signalAfterCheck();
            await stepBGate;
          },
        },
      }),
    );

    // 真实 barrier：锁被 handler 持有（pg_locks granted）后，erasure 发起
    // （将阻塞在 USER 锁上）
    await afterCheck;
    await waitForGrantedAdvisoryLock(rawClient, `USER:${userId}`);
    const erasure = eraseAccount(userId);

    releaseStepB();
    const outcome = await stepB;
    expect(outcome.kind).toBe("COMPLETED");

    // export completion wins：READY + COMPLETED 先提交
    const requestAfter = await requestRow(request.id);
    expect(requestAfter.status).toBe("COMPLETED");
    const artifact = await artifactRow(request.id);
    expect(artifact.status).toBe("READY");
    leftoverObjects.push({ bucket: artifact.bucket, objectKey: artifact.objectKey });

    // erasure 随后提交：artifact 原子 PENDING_DELETE + 下载立即拒绝
    await erasure;
    const artifactAfterErasure = await artifactRow(request.id);
    expect(artifactAfterErasure.status).toBe("PENDING_DELETE");

    const denied = await readExportArtifactForDownload(request.id, userId);
    expect(denied).toMatchObject({ ok: false, status: 410 });
    expect(await objectExists(artifact.bucket, artifact.objectKey)).toBe(true); // 对象由 cleanup 物理收敛

    const summary = await runDataExportArtifactCleanup({ batchLimit: 10 });
    expect(summary.objectsDeleted).toBeGreaterThanOrEqual(1);
    expect(await objectExists(artifact.bucket, artifact.objectKey)).toBe(false);
    expect((await artifactRow(request.id)).status).toBe("DELETED");
  });

  it("EXPORT-ERASE-RACE-02：erasure wins → worker 不得 READY/COMPLETED → REJECTED + 对象受追踪", async () => {
    const userId = await createFixtureUser("erase-race-02");
    const { request } = await createAsyncDataExportRequest(userId);

    await runExportJobUntil(request.id, (row) => row.attempts >= 1);
    const artifact = await artifactRow(request.id);
    expect(artifact.status).toBe("WRITING");

    // erasure 先行完整提交（erasure wins）
    await eraseAccount(userId);

    // worker 后续获得 authority：不得 READY/COMPLETED 可下载 artifact
    const claimTx = withTransaction((tx) =>
      (async () => {
        const { claimDueAsyncJobs } = await import("@/lib/async/job-repository");
        await rawClient.asyncJob.update({
          where: { dedupeKey: `DATA_EXPORT_GENERATE:${request.id}` },
          data: { runAt: new Date() },
        });
        const claimed = await claimDueAsyncJobs(tx, {
          workerId: "it-9c03-erase-race-02",
          leaseSeconds: 120,
          batchSize: 10,
        });
        return claimed.find(
          (candidate) =>
            candidate.kind === "DATA_EXPORT_GENERATE" &&
            (candidate.payload as { requestId?: string }).requestId === request.id,
        );
      })(),
    );
    const job = await claimTx;
    expect(job).toBeTruthy();

    const outcome = await withTransaction((tx) => processDataExportGenerateJob(tx, job!));
    expect(outcome.kind).toBe("COMPLETED"); // intent 收敛为终局

    const requestAfter = await requestRow(request.id);
    expect(requestAfter.status).toBe("REJECTED");
    expect(requestAfter.reasonCode).toBe("ACCOUNT_ALREADY_DELETED");

    const artifactAfter = await artifactRow(request.id);
    expect(artifactAfter.status).toBe("PENDING_DELETE"); // WRITING 对象受 cleanup 追踪
    expect(await objectExists(artifactAfter.bucket, artifactAfter.objectKey)).toBe(false);

    const denied = await readExportArtifactForDownload(request.id, userId);
    expect(denied.ok).toBe(false);
  });

  it("EXPORT-CLEANUP-01：到期 → PENDING_DELETE → DELETED；delete 成功 + DB fail → 重试；two workers → one transition", async () => {
    const userId = await createFixtureUser("cleanup");
    const { request } = await createAsyncDataExportRequest(userId);
    await runExportJobUntil(request.id, (row) => row.status === "COMPLETED");

    const artifact = await artifactRow(request.id);
    leftoverObjects.push({ bucket: artifact.bucket, objectKey: artifact.objectKey });

    // fixture 时钟：expiresAt → past（TTL 到期）
    await rawClient.dataExportArtifact.update({
      where: { id: artifact.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    // 第一轮 cleanup：目标 artifact 的 DeleteObject 真实成功后注入失败
    //（crash-after-external-success，定向 key，不误伤同批其它删除）
    const faulted = new ExportFaultStorage(realStorage, {
      deleteFaultKey: artifact.objectKey,
    });
    setStorageForTests(faulted);
    await runDataExportArtifactCleanup({ batchLimit: 10 });
    setStorageForTests(realStorage);

    expect(await objectExists(artifact.bucket, artifact.objectKey)).toBe(false); // 对象已物理删除
    expect((await artifactRow(request.id)).status).toBe("PENDING_DELETE"); // DB 转移未完成

    // 第二轮：DeleteObject 幂等重删 → 条件 DELETED 转移收敛
    const secondRound = await runDataExportArtifactCleanup({ batchLimit: 10 });
    expect(secondRound.objectsDeleted).toBe(1);
    expect((await artifactRow(request.id)).status).toBe("DELETED");
    expect((await artifactRow(request.id)).deletedAt).toBeTruthy();

    // 幂等：第三轮零工作
    const thirdRound = await runDataExportArtifactCleanup({ batchLimit: 10 });
    expect(thirdRound.objectsDeleted).toBe(0);
    expect(thirdRound.expiryMarked).toBe(0);

    // §28 two cleanup workers → one logical DELETED transition：
    // 新 READY artifact 到期后并发双 cleanup——物理删除调用 2 次（幂等），
    // 逻辑 DELETED 转移恰好一次（sum objectsDeleted = 1）
    const userId2 = await createFixtureUser("cleanup-race");
    const { request: request2 } = await createAsyncDataExportRequest(userId2);
    await runExportJobUntil(request2.id, (row) => row.status === "COMPLETED");
    const artifact2 = await artifactRow(request2.id);
    leftoverObjects.push({ bucket: artifact2.bucket, objectKey: artifact2.objectKey });
    await rawClient.dataExportArtifact.update({
      where: { id: artifact2.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const firstMark = await prisma.dataExportArtifact.updateMany({
      where: { id: artifact2.id, status: "READY", expiresAt: { lte: new Date() } },
      data: { status: "PENDING_DELETE" },
    });
    expect(firstMark.count).toBe(1);

    const [workerA, workerB] = await Promise.all([
      runDataExportArtifactCleanup({ batchLimit: 10 }),
      runDataExportArtifactCleanup({ batchLimit: 10 }),
    ]);
    expect(workerA.objectsDeleted + workerB.objectsDeleted).toBe(1);
    expect((await artifactRow(request2.id)).status).toBe("DELETED");

    // 条件转移原语 directly：PENDING_DELETE 谓词之外零转移
    expect(await withTransaction((tx) => markArtifactDeletedIfPendingDelete(tx, artifact2.id, new Date()))).toBe(false);
  });

  it("EXPORT-CLEANUP-BOUNDED-01：backlog=100、batchLimit=10 → 每轮到期推进 ≤10，分批最终全收敛", async () => {
    const userId = await createFixtureUser("cleanup-bounded");

    // backlog fixture：100 条 READY + 已到期 artifact（DB 行级，无对象——
    // 物理阶段 DeleteObject 幂等，对象不存在视为成功）
    const now = Date.now();
    const requests = await rawClient.privacyRequest.createManyAndReturn({
      data: Array.from({ length: 100 }, () => ({
        userId,
        type: "DATA_EXPORT" as const,
        status: "COMPLETED" as const,
        requestedAt: new Date(now - 3_600_000),
        completedAt: new Date(now - 3_500_000),
      })),
      select: { id: true },
    });
    expect(requests).toHaveLength(100);

    const artifactRows = requests.map((request, index) => ({
      requestId: request.id,
      userId,
      status: "READY" as const,
      bucket: "campus-private",
      objectKey: `private/data-exports/${userId}/bounded-${String(index).padStart(3, "0")}-${request.id}.json`,
      mimeType: "application/json; charset=utf-8",
      sizeBytes: 1024,
      sha256: "0".repeat(64),
      expiresAt: new Date(now - 1_000),
      createdAt: new Date(now - 3_000_000),
      updatedAt: new Date(now - 3_000_000),
    }));
    await rawClient.dataExportArtifact.createMany({ data: artifactRows });

    // 第一轮：到期推进必须 bounded（≤ batchLimit），绝不一次推进整个 backlog
    const firstRound = await runDataExportArtifactCleanup({ batchLimit: 10 });
    expect(firstRound.expiryMarked).toBeLessThanOrEqual(10);
    expect(firstRound.expiryMarked).toBeGreaterThanOrEqual(1);

    const remainingReady = await rawClient.dataExportArtifact.count({
      where: { userId, status: "READY" },
    });
    expect(remainingReady).toBe(100 - firstRound.expiryMarked);

    // 持续执行：每轮 bounded，最终全部收敛 DELETED
    let rounds = 1;
    let lastRound = firstRound;
    let deletedTotal = firstRound.objectsDeleted;
    while (rounds < 40) {
      const readyLeft = await rawClient.dataExportArtifact.count({
        where: { userId, status: "READY" },
      });
      if (readyLeft === 0) break;
      lastRound = await runDataExportArtifactCleanup({ batchLimit: 10 });
      rounds += 1;
      expect(lastRound.expiryMarked).toBeLessThanOrEqual(10);
      expect(lastRound.objectsDeleted).toBeLessThanOrEqual(10);
      deletedTotal += lastRound.objectsDeleted;
    }

    expect(await rawClient.dataExportArtifact.count({ where: { userId, status: "READY" } })).toBe(0);
    expect(await rawClient.dataExportArtifact.count({ where: { userId, status: "PENDING_DELETE" } })).toBe(0);
    expect(await rawClient.dataExportArtifact.count({ where: { userId, status: "DELETED" } })).toBe(100);
    expect(deletedTotal).toBe(100);
    expect(rounds).toBeGreaterThanOrEqual(10); // bounded 分批的真实证据
  });

  it("EXPORT-STALE-WRITING-SWEEP：孤儿 WRITING（request 已 REJECTED）→ cleanup 标记并物理收敛；活跃 WRITING 不动", async () => {
    const userId = await createFixtureUser("stale-writing");
    const { request } = await createAsyncDataExportRequest(userId);
    await runExportJobUntil(request.id, (row) => row.attempts >= 1);

    // TEST-ONLY 时钟：把 orphan 的 job 推到未来——后续 batch 只允许处理
    // 活跃面的 job（否则 orphan 会被 claim 进 Step B 提前终局）
    const orphanJob = await rawClient.asyncJob.findUniqueOrThrow({
      where: { dedupeKey: `DATA_EXPORT_GENERATE:${request.id}` },
    });
    await rawClient.asyncJob.update({
      where: { id: orphanJob.id },
      data: { runAt: new Date(Date.now() + 3_600_000) },
    });

    // 活跃面：另一 request 正在 IN_PROGRESS + WRITING（worker 工作面，不可动）
    const userId2 = await createFixtureUser("active-writing");
    const { request: activeRequest } = await createAsyncDataExportRequest(userId2);
    await runExportJobUntil(activeRequest.id, (row) => row.attempts >= 1);
    expect((await requestRow(request.id)).status).toBe("IN_PROGRESS"); // orphan 未被后续 batch 触碰

    // fixture：orphan 的 request 直接收敛 REJECTED（模拟收敛后 WRITING 残留
    // ——canonical 代码路径不可能出现，sweep 只覆盖手工改库/迁移缺口）
    await rawClient.privacyRequest.update({
      where: { id: request.id },
      data: { status: "REJECTED", reasonCode: "DATA_EXPORT_GENERATION_FAILED" },
    });

    const summary = await runDataExportArtifactCleanup({ batchLimit: 10 });
    expect(summary.staleWritingMarked).toBe(1);
    // 同轮 cleanup 的物理阶段把刚标记的孤儿一并收敛（对象从未 PUT → 幂等删除）
    expect((await artifactRow(request.id)).status).toBe("DELETED");
    expect((await artifactRow(activeRequest.id)).status).toBe("WRITING"); // 活跃面不动
  });

  it("EXPORT-DOWNLOAD-GUARDS：跨用户 404 同形（anti-oracle）/ 未就绪 / 已拒绝 / 已过期 / 对象缺失", async () => {
    const ownerA = await createFixtureUser("dl-a");
    const userB = await createFixtureUser("dl-b");
    const { request } = await createAsyncDataExportRequest(ownerA);
    await runExportJobUntil(request.id, (row) => row.status === "COMPLETED");
    const artifact = await artifactRow(request.id);
    leftoverObjects.push({ bucket: artifact.bucket, objectKey: artifact.objectKey });

    // 本人可下载
    expect((await readExportArtifactForDownload(request.id, ownerA)).ok).toBe(true);

    // anti-oracle：跨用户与不存在完全同形（同 status + 同 code）
    const crossUser = await readExportArtifactForDownload(request.id, userB);
    const missing = await readExportArtifactForDownload("nonexistent-request-id", ownerA);
    expect(crossUser).toMatchObject({ ok: false, status: 404, code: "EXPORT_DOWNLOAD_NOT_FOUND" });
    expect(missing).toEqual(crossUser);

    // 未就绪（构造：新 request 尚未执行）
    const { request: pendingRequest } = await createAsyncDataExportRequest(ownerA);
    await expect(readExportArtifactForDownload(pendingRequest.id, ownerA)).resolves.toMatchObject({
      ok: false,
      status: 409,
      code: "EXPORT_NOT_READY",
    });

    // 已拒绝（REQUESTED → IN_PROGRESS → REJECTED，真实状态机路径）
    const { request: rejectedRequest } = await createAsyncDataExportRequest(userB);
    const { transitionPrivacyRequest } = await import("@/lib/privacy/privacy-request-service");
    await transitionPrivacyRequest(rejectedRequest.id, "IN_PROGRESS");
    await transitionPrivacyRequest(rejectedRequest.id, "REJECTED", {
      reasonCode: "DATA_EXPORT_GENERATION_FAILED",
    });
    await expect(readExportArtifactForDownload(rejectedRequest.id, userB)).resolves.toMatchObject({
      ok: false,
      status: 409,
      code: "EXPORT_GENERATION_FAILED",
    });

    // 已过期（410）
    await rawClient.dataExportArtifact.update({
      where: { id: artifact.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(readExportArtifactForDownload(request.id, ownerA)).resolves.toMatchObject({
      ok: false,
      status: 410,
      code: "EXPORT_EXPIRED",
    });

    // 对象缺失（READY 行 + 存储侧对象被删）→ 明确不可用，绝不静默
    await rawClient.dataExportArtifact.update({
      where: { id: artifact.id },
      data: { expiresAt: new Date(Date.now() + 3_600_000) },
    });
    await realStorage.deleteObject({ bucket: artifact.bucket, objectKey: artifact.objectKey });
    await expect(readExportArtifactForDownload(request.id, ownerA)).resolves.toMatchObject({
      ok: false,
      status: 409,
      code: "EXPORT_ARTIFACT_UNAVAILABLE",
    });
  });

  it("EXPORT-NO-SECRET-LEAK：create 结果 / list DTO / 下载面零 bucket/objectKey/sha256（§54）", async () => {
    const userId = await createFixtureUser("leak");
    const { request } = await createAsyncDataExportRequest(userId);

    // create 响应面只含 safe DTO 四字段
    expect(Object.keys(request).sort()).toEqual(["id", "requestedAt", "status", "type"]);

    await runExportJobUntil(request.id, (row) => row.status === "COMPLETED");
    const artifact = await artifactRow(request.id);
    leftoverObjects.push({ bucket: artifact.bucket, objectKey: artifact.objectKey });

    const { listUserPrivacyRequestDtos } = await import("@/lib/privacy/privacy-request-service");
    const dtos = await listUserPrivacyRequestDtos(userId);
    const serialized = JSON.stringify(dtos);

    expect(serialized).not.toContain(artifact.bucket);
    expect(serialized).not.toContain(artifact.objectKey);
    expect(serialized).not.toContain(artifact.sha256!);
    expect(serialized).not.toContain('"bucket"');
    expect(serialized).not.toContain('"objectKey"');
    expect(serialized).not.toContain('"sha256"');

    // 下载路径仅相对 app route；downloadAvailable 语义与 READY + 未过期一致
    const dto = dtos.find((entry) => entry.id === request.id);
    expect(dto).toMatchObject({
      downloadAvailable: true,
      downloadPath: `/api/privacy/export/${request.id}/download`,
    });
    expect(dto!.artifactExpiresAt).toBeTruthy();

    const download = await readExportArtifactForDownload(request.id, userId);
    expect(download.ok).toBe(true);
    if (download.ok) {
      expect(download.filename).not.toContain("@");
      expect(download.filename).toMatch(/^campus-data-export-[a-z0-9]+\.json$/);
      // 响应体是导出 JSON 本身，绝不含内部定位符
      const body = download.body.toString("utf8");
      expect(body).not.toContain(artifact.bucket);
      expect(body).not.toContain(artifact.objectKey);
    }
  });

  it("EXPORT-RESCHEDULE-DEFENSE：Step A 的 RESCHEDULE 不消耗失败、不回退 attempts（durable anchor 幂等）", async () => {
    const userId = await createFixtureUser("reschedule");
    const { request } = await createAsyncDataExportRequest(userId);

    await runAsyncJobBatchOnce();

    // Step A 完成后：job 回到 PENDING（RESCHEDULE 不计失败），attempts = 1
    //（claim 计数不回退）；request IN_PROGRESS + artifact WRITING anchor
    const job = await rawClient.asyncJob.findUniqueOrThrow({
      where: { dedupeKey: `DATA_EXPORT_GENERATE:${request.id}` },
    });
    expect(job.status).toBe("PENDING");
    expect(job.attempts).toBe(1);
    expect(job.lastErrorCode).toBeNull();
    expect((await requestRow(request.id)).status).toBe("IN_PROGRESS");

    // anchor 提交时 object key 已 deterministic 确定
    const artifact = await artifactRow(request.id);
    expect(artifact.status).toBe("WRITING");
    expect(artifact.objectKey).toBe(`private/data-exports/${userId}/${request.id}.json`);
    leftoverObjects.push({ bucket: artifact.bucket, objectKey: artifact.objectKey });
  });

  it("EXPORT-JOB-PAYLOAD-PERMANENT：payload 结构损坏 → PERMANENT → DEAD_LETTER → reconciler 收敛", async () => {
    const userId = await createFixtureUser("corrupt");
    const { request } = await createAsyncDataExportRequest(userId);

    // fixture：手工损坏 payload（写边界生产不可能产生；执行边界 fail closed）
    await rawClient.asyncJob.update({
      where: { dedupeKey: `DATA_EXPORT_GENERATE:${request.id}` },
      data: { payload: { requestId: request.id, smuggled: "object-key" } },
    });
    await rawClient.asyncJob.update({
      where: { dedupeKey: `DATA_EXPORT_GENERATE:${request.id}` },
      data: { runAt: new Date() },
    });
    await runAsyncJobBatchOnce();

    const job = await rawClient.asyncJob.findUniqueOrThrow({
      where: { dedupeKey: `DATA_EXPORT_GENERATE:${request.id}` },
    });
    expect(job.status).toBe("DEAD_LETTER");
    expect(job.lastErrorCode).toBe("DATA_EXPORT_JOB_PAYLOAD_INVALID");

    // request 尚未进入任何 artifact 面（Step A 未执行）→ reconciler 收敛
    const reconciliation = await reconcileDataExportDeadLetters({ batchLimit: 10 });
    expect(reconciliation.convergedRequests).toBeGreaterThanOrEqual(1);
    expect(await requestRow(request.id)).toMatchObject({
      status: "REJECTED",
      reasonCode: "DATA_EXPORT_GENERATION_FAILED",
    });
  });

  it("EXPORT-SECURITY-PERMANENT-01（RB02）：载荷含禁止键 → Step B PERMANENT fail closed → DEAD_LETTER（零 RETRY）→ reconciler 收敛 REJECTED", async () => {
    const userId = await createFixtureUser("security-permanent");
    const { request } = await createAsyncDataExportRequest(userId);

    // Step A：durable anchor（真实 runner 路径）
    await runExportJobUntil(request.id, (row) => row.attempts >= 1);

    // Step B：注入运行时含 passwordHash 的恶意载荷（builder seam 绕开 TS
    // 类型）。真实 runner claim → 执行边界禁止键扫描 → PERMANENT →
    // DEAD_LETTER（绝不 RETRY 排程）
    const dataExportModule = await import("@/lib/privacy/data-export");
    const buildMock = dataExportModule.buildUserExport as unknown as {
      mockImplementationOnce: (impl: () => Promise<unknown>) => void;
    };
    buildMock.mockImplementationOnce(async () => {
      return {
        blob: "x",
        passwordHash: "$2a$10$evil-secret-hash-value",
      } as never;
    });

    const job = await runExportJobUntil(request.id, (row) => row.status === "DEAD_LETTER");
    expect(job.status).toBe("DEAD_LETTER");
    expect(job.deadLetteredAt).not.toBeNull();

    // attempts = Step A(1) + Step B(2)：Step B 安全失败立即 PERMANENT，
    // 不产生任何 RETRY 排程（若被误分类为 RETRYABLE，此处会 > 2）
    expect(job.attempts).toBe(2);

    // durable job 行只含受控 generic 文案——绝不出现禁止键名/键路径/值
    expect(job.lastErrorCode).toBe("DATA_EXPORT_SECURITY_VALIDATION_FAILED");
    expect(job.lastErrorMessage).toBe("导出载荷未通过安全验证");
    expect(job.lastErrorMessage).not.toContain("passwordHash");
    expect(job.lastErrorMessage).not.toContain("evil");

    // request 未被 runner 终结（REJECTED 收敛属 scoped reconciler 职责）
    const requestMid = await requestRow(request.id);
    expect(requestMid.status).toBe("IN_PROGRESS");

    const reconciliation = await reconcileDataExportDeadLetters({ batchLimit: 10 });
    expect(reconciliation.convergedRequests).toBeGreaterThanOrEqual(1);

    expect(await requestRow(request.id)).toMatchObject({
      status: "REJECTED",
      reasonCode: "DATA_EXPORT_GENERATION_FAILED",
    });

    // artifact（Step A WRITING anchor）→ PENDING_DELETE → 不可下载
    const artifact = await artifactRow(request.id);
    expect(artifact.status).toBe("PENDING_DELETE");
    const denied = await readExportArtifactForDownload(request.id, userId);
    expect(denied.ok).toBe(false);
  });

  it("EXPORT-QUOTA-ISOLATION：artifact 不计入 user storage quota（INV-9C03-12）", async () => {
    const userId = await createFixtureUser("quota");
    const quotaBefore = (await rawClient.user.findUniqueOrThrow({ where: { id: userId } }))
      .storageUsedBytes;

    const { request } = await createAsyncDataExportRequest(userId);
    await runExportJobUntil(request.id, (row) => row.status === "COMPLETED");

    const quotaAfter = (await rawClient.user.findUniqueOrThrow({ where: { id: userId } }))
      .storageUsedBytes;
    expect(quotaAfter).toBe(quotaBefore);

    const artifact = await artifactRow(request.id);
    expect(artifact.sizeBytes).toBeGreaterThan(0);
    leftoverObjects.push({ bucket: artifact.bucket, objectKey: artifact.objectKey });
  });
  },
);
