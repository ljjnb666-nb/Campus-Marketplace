/**
 * FINAL REPAIR B — LR-071 evidence harness（真实 MinIO/存储故障状态审计）。
 *
 * 真实依赖：本地 PostgreSQL（prisma）+ 本地 MinIO（真实 S3Storage），
 * 故障注入在 StorageClient 边界（test-only 包装器）：
 *
 * - AMBIGUOUS_REMOTE_COMMIT：真实 putObject 已把对象写入 MinIO，然后
 *   合成 throw（模拟"远端提交成功但 client 观察到错误"——LR-071 关键场景）
 * - PURE_OUTAGE：S3Storage 指向无监听端口（远端提交前失败）
 *
 * 观测（BEFORE 应展示问题、AFTER 应展示合同）：
 * - uploadImageAsset 抛出的 code/status
 * - UploadedAsset 行是否存在及状态（authoritative recovery row）
 * - User.storageUsedBytes（配额是否被提前释放）
 * - MinIO 中对象是否存在（untracked orphan 判定）
 *
 * 运行：npx tsx scripts/resilience/storage-outage-harness.ts --phase BEFORE
 * 结果：bench-results/resilience/lr071-<phase>.json
 */

import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import sharp from "sharp";

import { uploadImageAsset, AssetServiceError } from "@/lib/asset-service";
import { setStorageForTests, getStorage } from "@/lib/storage";
import type { StorageClient, PutObjectInput } from "@/lib/storage/types";

const phase = process.argv[process.argv.indexOf("--phase") + 1] ?? "BEFORE";
const RESULTS_DIR = path.join(process.cwd(), "bench-results", "resilience");
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const OUTAGE_ENDPOINT = process.env.HARNESS_S3_OUTAGE_ENDPOINT ?? "http://localhost:9399";

function log(message: string) {
  process.stdout.write(`[lr071-harness] ${message}\n`);
}

const prisma = new PrismaClient();

/** 真实 MinIO 凭据/端点（本地开发栈） */
const REAL_ENDPOINT = process.env.HARNESS_S3_ENDPOINT ?? "http://localhost:9100";

/**
 * 故障注入包装器：全部方法委托真实实现，仅 putObject 可配置故障模式。
 * lastPut 记录真实提交到 MinIO 的对象引用——行被补偿删除后仍可独立验证
 * "远端对象是否存在"（untracked orphan 判定的权威证据）。
 */
class FaultStorage implements StorageClient {
  lastPut: { bucket: string; objectKey: string } | null = null;

  constructor(
    private readonly real: StorageClient,
    private readonly mode: "AMBIGUOUS_REMOTE_COMMIT" | "PURE_OUTAGE",
  ) {}

  async putObject(input: PutObjectInput): Promise<void> {
    if (this.mode === "AMBIGUOUS_REMOTE_COMMIT") {
      // 真实提交到 MinIO（对象真实写入），然后合成客户端错误
      await this.real.putObject(input);
      this.lastPut = { bucket: input.bucket, objectKey: input.objectKey };
      throw new Error("connection reset after remote commit (synthetic)");
    }
    // PURE_OUTAGE：提交前失败（端点不可达的真实存储实现已在构造时保证，
    // 这里直接委托——real 实例指向不可达端点）
    await this.real.putObject(input);
  }

  headBucket(bucket: string) {
    return this.real.headBucket(bucket);
  }
  deleteObject(ref: Parameters<StorageClient["deleteObject"]>[0]) {
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

async function makeValidImage(): Promise<File> {
  // 真实可解码 PNG（重编码后 ~几百字节）
  const png = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 90, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
  return new File([png], "photo.png", { type: "image/png" });
}

async function objectExists(bucket: string, objectKey: string): Promise<boolean> {
  const storage = getStorage();
  const metadata = await storage.headObject({ bucket, objectKey }).catch(() => "error");
  return metadata !== null && metadata !== "error";
}

interface ScenarioOutcome {
  scenario: string;
  errorCode: string | null;
  errorStatus: number | null;
  errorName: string | null;
  rowState: string | null;
  rowExists: boolean;
  quotaBytes: number | null;
  remoteObjectExists: boolean | null;
  bucketUsed: string | null;
}

async function runScenario(
  scenario: string,
  storage: StorageClient,
): Promise<ScenarioOutcome> {
  const faultStorage = storage instanceof FaultStorage ? storage : null;
  const user = await prisma.user.findUnique({
    where: { email: "resilience-harness@campus.local" },
    select: { id: true, storageUsedBytes: true },
  });
  if (!user) {
    throw new Error("resilience harness 用户不存在（先运行 ensure-resilience-user.ts）");
  }
  const quotaBefore = await prisma.user.findUnique({
    where: { id: user.id },
    select: { storageUsedBytes: true },
  });

  setStorageForTests(storage);
  const outcome: ScenarioOutcome = {
    scenario,
    errorCode: null,
    errorStatus: null,
    errorName: null,
    rowState: null,
    rowExists: false,
    quotaBytes: null,
    remoteObjectExists: null,
    bucketUsed: null,
  };

  try {
    const file = await makeValidImage();
    const result = await uploadImageAsset({ userId: user.id, category: "product", file });
    outcome.errorName = `UNEXPECTED_SUCCESS assetId=${result.assetId}`;
  } catch (error) {
    if (error instanceof AssetServiceError) {
      outcome.errorCode = error.code;
      outcome.errorStatus = error.status;
    } else {
      outcome.errorName = error instanceof Error ? error.name : "unknown";
      outcome.errorCode = `RAW:${error instanceof Error ? error.message.slice(0, 80) : String(error).slice(0, 80)}`;
    }
  }

  // 行状态 / 配额
  const row = await prisma.uploadedAsset.findFirst({
    where: { ownerId: user.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, bucket: true, objectKey: true },
  });
  outcome.rowExists = row !== null;
  outcome.rowState = row?.status ?? null;
  outcome.bucketUsed = row?.bucket ?? null;
  const quotaAfter = await prisma.user.findUnique({
    where: { id: user.id },
    select: { storageUsedBytes: true },
  });
  outcome.quotaBytes = quotaAfter?.storageUsedBytes ?? null;
  log(
    `${scenario}: quota ${quotaBefore?.storageUsedBytes} → ${outcome.quotaBytes}, row=${outcome.rowState ?? "ABSENT"}, code=${outcome.errorCode ?? "-"}:${outcome.errorStatus ?? "-"}`,
  );

  // 远端对象：优先用行里的引用；行已被补偿删除时用 FaultStorage 记录的
  // 真实提交引用（正是 untracked orphan 判定所需的独立证据）
  const objectRef = row ?? faultStorage?.lastPut ?? null;
  if (objectRef) {
    outcome.remoteObjectExists = await objectExists(objectRef.bucket, objectRef.objectKey);
    log(
      `${scenario}: remote object exists=${outcome.remoteObjectExists} (ref from ${row ? "db-row" : "fault-storage-lastPut"})`,
    );
  } else {
    outcome.remoteObjectExists = null;
  }

  return outcome;
}

async function main() {
  // 场景前清理：harness 用户的历史资产行 + 配额 + 远端对象全部归零，
  // 保证每次运行从干净基线开始（可重复）
  const { S3Storage } = await import("@/lib/storage/s3-storage");
  const { S3Client } = await import("@aws-sdk/client-s3");
  process.env.S3_ENDPOINT = REAL_ENDPOINT;
  const realStorage = new S3Storage();
  const harnessUser = await prisma.user.findUnique({
    where: { email: "resilience-harness@campus.local" },
    select: { id: true },
  });
  if (harnessUser) {
    const staleRows = await prisma.uploadedAsset.findMany({
      where: { ownerId: harnessUser.id },
      select: { bucket: true, objectKey: true },
    });
    for (const row of staleRows) {
      await realStorage.deleteObject({ bucket: row.bucket, objectKey: row.objectKey }).catch(
        () => undefined,
      );
    }
    await prisma.uploadedAsset.deleteMany({ where: { ownerId: harnessUser.id } });
    await prisma.user.update({
      where: { id: harnessUser.id },
      data: { storageUsedBytes: 0 },
    });
    log(`前置清理：删除 ${staleRows.length} 条历史资产行，配额归零`);
  }


  const outageClient = new S3Client({
    endpoint: OUTAGE_ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "harness-local-key", secretAccessKey: "harness-local-secret" },
    // 快速失败：太长的超时/重试会拖慢 harness
    requestHandler: { requestTimeout: 1500 } as never,
  });
  const outageStorage = new S3Storage(outageClient);

  const outcomes: ScenarioOutcome[] = [];

  outcomes.push(
    await runScenario(
      "AMBIGUOUS_REMOTE_COMMIT",
      new FaultStorage(realStorage, "AMBIGUOUS_REMOTE_COMMIT"),
    ),
  );
  outcomes.push(await runScenario("PURE_OUTAGE", outageStorage));

  setStorageForTests(null);

  const summary = { phase, generatedAt: new Date().toISOString(), outcomes };
  const outputPath = path.join(RESULTS_DIR, `lr071-${phase.toLowerCase()}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
  log(`结果已写入 ${outputPath}`);
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error("[lr071-harness] 失败:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    setStorageForTests(null);
  });
