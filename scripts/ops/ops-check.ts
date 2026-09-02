/**
 * 统一 repo-side 运维检查入口（Phase 4 TASK 8）。
 *
 * 用法：npx tsx scripts/ops/ops-check.ts [--mode production|development|ci]
 *        [--env-file .env.production] [--skip-connectivity]
 *
 * 检查项：环境契约（production mode）、数据库/Redis/对象存储连通性、
 * 备份新鲜度与状态、release identity 配置。
 *
 * 契约：
 * - 全部通过 → exit 0；任何必需检查失败 → exit 1（fail-closed，
 *   绝不 swallow error / 绝不失败后打印 PASS）；
 * - mode 契约：
 *   production：环境契约 + 全部连通性 + 备份新鲜度 + RELEASE_SHA 必需；
 *   development：本地开发不强制生产 env 契约与生产备份——env 契约
 *     标记 skipped，连通性按已配置的变量尽力检查，备份检查按
 *     backup-health-check 的 development 语义报告事实；
 *   ci：同 development，但连通性检查对未配置的依赖标记 skipped。
 * - 输出：每项检查一行 JSON（machine-readable），最后一行汇总
 *   { result: "PASS" | "FAIL", ... }。绝不输出任何秘密值。
 */
import { existsSync, readFileSync } from "node:fs";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";

import { collectEnvChecks } from "../production-env-check";
import { evaluateBackupHealth } from "./backup-health-check";

type CheckStatus = "pass" | "fail" | "skipped";

interface OpsCheckResult {
  name: string;
  status: CheckStatus;
  required: boolean;
  detail?: string;
}

const CONNECT_TIMEOUT_MS = 4000;

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (key === "skip-connectivity") {
        args[key] = "true";
      } else {
        args[key] = argv[i + 1] ?? "";
        i += 1;
      }
    }
  }
  return args;
}

/** shell export 优先，其次 env 文件（与 lib.sh / production-env-check 对齐） */
function loadEnvOverlay(file: string): void {
  if (!existsSync(file)) {
    return;
  }
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function withTimeout<T>(name: string, op: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} check timed out`)), CONNECT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkDatabase(): Promise<OpsCheckResult> {
  if (!process.env.DATABASE_URL) {
    return { name: "database_connectivity", status: "skipped", required: false, detail: "DATABASE_URL 未配置" };
  }
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
    log: ["error"],
  });
  try {
    await withTimeout("database", () => prisma.$queryRaw`SELECT 1`);
    return { name: "database_connectivity", status: "pass", required: true };
  } catch (error) {
    return {
      name: "database_connectivity",
      status: "fail",
      required: true,
      detail: error instanceof Error ? error.name : "unknown",
    };
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

async function checkRedis(): Promise<OpsCheckResult> {
  if (!process.env.REDIS_URL) {
    return { name: "redis_connectivity", status: "skipped", required: false, detail: "REDIS_URL 未配置（本地限流模式）" };
  }
  const redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: CONNECT_TIMEOUT_MS,
    // ops-check 是短命进程，静默消费连接错误事件
    // （错误经检查结果输出，不走 ioredis 事件）
  });
  redis.on("error", () => undefined);
  try {
    const pong = await withTimeout("redis", () => redis.ping());
    if (pong !== "PONG") {
      return { name: "redis_connectivity", status: "fail", required: true, detail: "unexpected PING reply" };
    }
    return { name: "redis_connectivity", status: "pass", required: true };
  } catch (error) {
    return {
      name: "redis_connectivity",
      status: "fail",
      required: true,
      detail: error instanceof Error ? error.name : "unknown",
    };
  } finally {
    redis.disconnect();
  }
}

async function checkStorage(): Promise<OpsCheckResult> {
  const { S3_ENDPOINT, S3_BUCKET_PUBLIC, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION, S3_FORCE_PATH_STYLE } =
    process.env;
  if (!S3_ENDPOINT || !S3_BUCKET_PUBLIC || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
    return {
      name: "storage_connectivity",
      status: "skipped",
      required: false,
      detail: "S3_* 未配置完整",
    };
  }
  const client = new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION || "us-east-1",
    forcePathStyle: S3_FORCE_PATH_STYLE !== "false",
    credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
  });
  try {
    const reachable = await withTimeout("storage", async () => {
      try {
        await client.send(new HeadBucketCommand({ Bucket: S3_BUCKET_PUBLIC }));
        return true;
      } catch {
        return false;
      }
    });
    return reachable
      ? { name: "storage_connectivity", status: "pass", required: true }
      : { name: "storage_connectivity", status: "fail", required: true, detail: "bucket 不可达" };
  } catch (error) {
    return {
      name: "storage_connectivity",
      status: "fail",
      required: true,
      detail: error instanceof Error ? error.name : "unknown",
    };
  } finally {
    client.destroy();
  }
}

function checkReleaseIdentity(mode: string): OpsCheckResult {
  const releaseSha = process.env.RELEASE_SHA ?? "";
  if (releaseSha) {
    return { name: "release_identity", status: "pass", required: mode === "production" };
  }
  if (mode === "production") {
    return { name: "release_identity", status: "fail", required: true, detail: "RELEASE_SHA 未设置（生产必须可回答当前运行版本）" };
  }
  return { name: "release_identity", status: "skipped", required: false, detail: "非 production mode，RELEASE_SHA 可选" };
}

function checkEnvContract(mode: string): OpsCheckResult {
  if (mode !== "production") {
    return { name: "environment_contract", status: "skipped", required: false, detail: "仅 production mode 强制" };
  }
  const results = collectEnvChecks(process.env);
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    return { name: "environment_contract", status: "pass", required: true, detail: `${results.length} 项通过` };
  }
  return {
    name: "environment_contract",
    status: "fail",
    required: true,
    // 只报变量名，绝不报值
    detail: `${failed.length} 项不合规：${failed.map((f) => f.name).join(", ")}`,
  };
}

async function checkBackup(mode: string): Promise<OpsCheckResult> {
  const { report, exitCode } = await evaluateBackupHealth({
    backupDir: process.env.BACKUP_DIR ?? "",
    maxAgeHours: Number(process.env.BACKUP_MAX_AGE_HOURS ?? 26),
    mode,
    strict: false,
  });
  const required = mode === "production";
  if (exitCode === 0) {
    // BLOCKER 1B（fail-closed）：production 总检查要求 productionBackupReady=true
    //（本地新鲜备份 + checksum 验证 + 异地副本成功）。
    // offsite not_configured 在 development 只报告事实；在 production 必须阻断。
    if (required && report.productionBackupReady !== true) {
      return {
        name: "backup_health",
        status: "fail",
        required,
        detail: `PRODUCTION_BACKUP_NOT_READY: ${report.reasons.join("; ") || "productionBackupReady=false"}`,
      };
    }
    return {
      name: "backup_health",
      status: "pass",
      required,
      detail: report.healthy ? `age=${report.backupAgeHours}h offsite=${report.offsiteStatus}` : "development mode：生产备份不强制（未就绪）",
    };
  }
  return {
    name: "backup_health",
    status: "fail",
    required,
    detail: report.reasons.join("; "),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode ?? (process.env.NODE_ENV === "production" ? "production" : "development");
  loadEnvOverlay(args["env-file"] ?? ".env.production");

  const results: OpsCheckResult[] = [];

  // BLOCKER 1（fail-closed）：production 模式禁止跳过连通性检查。
  // 连通性是生产 gate 的核心（DB/Redis/Storage 不可达必须阻断），
  // --skip-connectivity 仅面向 development/CI 的本地快速检查。
  if (mode === "production" && args["skip-connectivity"] === "true") {
    const skipRejection: OpsCheckResult = {
      name: "connectivity_policy",
      status: "fail",
      required: true,
      detail: "PRODUCTION_CONNECTIVITY_CANNOT_BE_SKIPPED",
    };
    results.push(skipRejection, {
      name: "release_identity",
      status: "skipped",
      required: false,
      detail: "PRODUCTION_CONNECTIVITY_CANNOT_BE_SKIPPED",
    });
    console.log(JSON.stringify(skipRejection));
    const rejected = {
      result: "FAIL",
      mode,
      reason: "PRODUCTION_CONNECTIVITY_CANNOT_BE_SKIPPED",
      checks: results.length,
      failed: ["connectivity_policy"],
    };
    console.log(JSON.stringify(rejected));
    process.exit(1);
  }

  results.push(checkEnvContract(mode), checkReleaseIdentity(mode));

  if (args["skip-connectivity"] !== "true") {
    results.push(await checkDatabase(), await checkRedis(), await checkStorage());
  } else {
    results.push(
      { name: "database_connectivity", status: "skipped", required: false, detail: "--skip-connectivity" },
      { name: "redis_connectivity", status: "skipped", required: false, detail: "--skip-connectivity" },
      { name: "storage_connectivity", status: "skipped", required: false, detail: "--skip-connectivity" },
    );
  }

  results.push(await checkBackup(mode));

  for (const result of results) {
    console.log(JSON.stringify(result));
  }

  const failed = results.filter((r) => r.status === "fail" && r.required);
  const summary = {
    result: failed.length === 0 ? "PASS" : "FAIL",
    mode,
    checks: results.length,
    failed: failed.map((f) => f.name),
  };
  console.log(JSON.stringify(summary));

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({ result: "FAIL", error: error instanceof Error ? error.name : "unknown" }),
  );
  process.exit(1);
});
