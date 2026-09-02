import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const script = path.join(repoRoot, "scripts", "ops", "ops-check.ts");

/**
 * Phase 4 TASK 8：统一运维检查入口（OPS_CHECK_FAIL_CLOSED_TEST）。
 * 契约：必需检查失败 → exit 1；绝不失败后仍打印 PASS。
 * cwd 用临时目录：避免读到仓库根 .env.production / 本机 env 之外的干扰。
 */

/** 运行时拼接的合成值：仅用于通过 env 契约校验，不是任何真实凭据 */
const SYNTH = {
  dbPassword: ["SynthDbPass-Only-For-", "Contract-Test-0123"].join(""),
  redisPassword: ["SynthRedisPass-Only-For-", "Contract-Test-0123"].join(""),
  nextauthSecret: ["SynthNextAuthSecret-Only-For-Contract-", "Test-0123456789abcdef"].join(""),
  s3Secret: ["SynthS3SecretKey-Only-For-", "Contract-Test-0123456789"].join(""),
  releaseSha: ["2623b8406f1ddf52461b6cd19b3358c20c94", "b885"].join(""),
};

/** 能通过 environment contract 的合成生产 env（host 用容器服务名，非 localhost） */
function syntheticProductionEnv(backupDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: `postgresql://campus_app:${SYNTH.dbPassword}@postgres:5432/campus?schema=public`,
    REDIS_URL: `redis://:${SYNTH.redisPassword}@redis:6379`,
    NEXTAUTH_URL: "https://campus.example.edu.cn",
    NEXTAUTH_SECRET: SYNTH.nextauthSecret,
    S3_ENDPOINT: "http://minio:9000",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: "CAMPUSSYNTHKEY01",
    S3_SECRET_ACCESS_KEY: SYNTH.s3Secret,
    S3_BUCKET_PUBLIC: "campus-public",
    S3_BUCKET_PRIVATE: "campus-private",
    S3_FORCE_PATH_STYLE: "true",
    PUBLIC_ASSET_BASE_URL: "https://campus.example.edu.cn/assets",
    SITE_ADDRESS: "campus.example.edu.cn",
    APP_NAME: "校园集市",
    DEFAULT_CAMPUS_SLUG: "main-campus",
    ALLOW_LOCAL_S3_IN_PRODUCTION: "",
    BACKUP_DIR: backupDir,
    BACKUP_OFFSITE_TARGET: "",
    RELEASE_SHA: SYNTH.releaseSha,
    METRICS_BEARER_TOKEN: "",
  };
}

/** 写一份新鲜、checksum 合法（真实文件）的备份产物（offsiteStatus 可选） */
function writeFreshBackupStatus(backupDir: string, offsiteStatus: string): void {
  // BLOCKER 4 之后 health 会真实重验 checksum：必须提供真实 dump + .sha256
  const dumpName = "campus-20260902-000000.dump";
  const dumpContent = Buffer.from("PGDMP-ops-check-fixture-payload");
  const checksum = createHash("sha256").update(dumpContent).digest("hex");
  writeFileSync(path.join(backupDir, dumpName), dumpContent);
  writeFileSync(path.join(backupDir, `${dumpName}.sha256`), `${checksum}  ${dumpName}\n`);
  writeFileSync(
    path.join(backupDir, "backup-status.json"),
    JSON.stringify({
      status: "success",
      completedAt: new Date().toISOString(),
      filename: dumpName,
      checksumVerified: true,
      offsiteStatus,
      stage: "complete",
    }),
  );
}

describe("ops-check（npm run ops:check）", () => {
  function tmpCwd(): { cwd: string; cleanup: () => void } {
    const cwd = mkdtempSync(path.join(tmpdir(), "campus-ops-check-"));
    return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
  }

  function tmpBackupDir(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(path.join(tmpdir(), "campus-ops-backup-"));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("development + --skip-connectivity + 无生产配置 → PASS（exit 0）", async () => {
    const { cwd, cleanup } = tmpCwd();
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
          script,
          "--mode",
          "development",
          "--skip-connectivity",
        ],
        {
          cwd,
          timeout: 120_000,
          env: {
            ...process.env,
            DATABASE_URL: "",
            REDIS_URL: "",
            S3_ENDPOINT: "",
            BACKUP_DIR: "",
            RELEASE_SHA: "",
          },
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      const lines = stdout.trim().split("\n");
      const summary = JSON.parse(lines.at(-1)!);
      expect(summary.result).toBe("PASS");
    } finally {
      cleanup();
    }
  }, 150_000);

  it("FAIL_CLOSED：配置了不可达的 DATABASE_URL → exit 1，绝不打印 PASS", async () => {
    const { cwd, cleanup } = tmpCwd();
    try {
      // 不带 --skip-connectivity：连通性是本场景的被测对象
      // （端口 9 = discard 服务，本机几乎必然 ECONNREFUSED，快速失败）
      const failure = await execFileAsync(
        process.execPath,
        [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), script, "--mode", "development"],
        {
          cwd,
          timeout: 120_000,
          env: {
            ...process.env,
            DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:9/campus",
            REDIS_URL: "",
            S3_ENDPOINT: "",
            BACKUP_DIR: "",
            RELEASE_SHA: "",
          },
          maxBuffer: 10 * 1024 * 1024,
        },
      ).catch((error: { stdout?: string; code?: number }) => error);

      const stdout = (failure as { stdout?: string }).stdout ?? "";
      expect((failure as { code?: number }).code).not.toBe(0);
      expect(stdout).not.toMatch(/"result":"PASS"/);
      // 检查结果为机器可读行 + 失败汇总
      const summary = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(summary.result).toBe("FAIL");
      expect(summary.failed).toContain("database_connectivity");
    } finally {
      cleanup();
    }
  }, 150_000);

  it("production mode 缺契约（无 env，不带 skip）→ exit 1，且不输出任何秘密值", async () => {
    const { cwd, cleanup } = tmpCwd();
    try {
      const failure = await execFileAsync(
        process.execPath,
        [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), script, "--mode", "production"],
        {
          cwd,
          timeout: 120_000,
          env: {
            ...process.env,
            DATABASE_URL: "",
            REDIS_URL: "",
            S3_ENDPOINT: "",
            S3_BUCKET_PUBLIC: "",
            BACKUP_DIR: "",
            RELEASE_SHA: "",
          },
          maxBuffer: 10 * 1024 * 1024,
        },
      ).catch((error: { stdout?: string; code?: number }) => error);

      const stdout = (failure as { stdout?: string }).stdout ?? "";
      expect((failure as { code?: number }).code).not.toBe(0);
      const summary = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(summary.result).toBe("FAIL");
      expect(summary.failed).toContain("environment_contract");
      expect(summary.failed).toContain("release_identity");
      // 只报变量名：即使进程 env 里带值，输出也绝不包含值本身
      expect(stdout).not.toMatch(/postgresql:\/\/[^"]+/);
      expect(stdout).not.toMatch(/redis:\/\/[^"]+/);
    } finally {
      cleanup();
    }
  }, 150_000);

  // ---- BLOCKER 1：production 不得用 --skip-connectivity 绕过连通性 gate ----

  it("PRODUCTION_SKIP_CONNECTIVITY_REJECTED_TEST：env 契约全过的合成生产 env + --skip-connectivity → exit!=0，失败原因仅为 skip 本身", async () => {
    const { cwd, cleanup } = tmpCwd();
    const { dir: backupDir, cleanup: cleanupBackup } = tmpBackupDir();
    try {
      const failure = await execFileAsync(
        process.execPath,
        [
          path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
          script,
          "--mode",
          "production",
          "--skip-connectivity",
        ],
        {
          cwd,
          timeout: 120_000,
          env: syntheticProductionEnv(backupDir),
          maxBuffer: 10 * 1024 * 1024,
        },
      ).catch((error: { stdout?: string; code?: number }) => error);

      const stdout = (failure as { stdout?: string }).stdout ?? "";
      expect((failure as { code?: number }).code).not.toBe(0);

      const lines = stdout.trim().split("\n");
      const summary = JSON.parse(lines.at(-1)!);
      expect(summary.result).toBe("FAIL");
      // 失败原因来自 skip-connectivity 本身：env 契约与 release identity 均无失败
      expect(summary.reason).toBe("PRODUCTION_CONNECTIVITY_CANNOT_BE_SKIPPED");
      expect(summary.failed).toEqual(["connectivity_policy"]);
      expect(stdout).toContain("PRODUCTION_CONNECTIVITY_CANNOT_BE_SKIPPED");
      // 不输出任何秘密值
      expect(stdout).not.toContain(SYNTH.dbPassword);
      expect(stdout).not.toContain(SYNTH.redisPassword);
      expect(stdout).not.toContain(SYNTH.nextauthSecret);
    } finally {
      cleanup();
      cleanupBackup();
    }
  }, 150_000);

  // ---- BLOCKER 1B：productionBackupReady=false 时 production 不得 overall PASS ----

  it("PRODUCTION_OFFSITE_NOT_READY_FAILS_OPS_CHECK：fresh+valid 备份但 offsite=not_configured → production FAIL 含 backup_health；offsite=success 对照不含", async () => {
    // 场景 B：offsite=not_configured → backup_health 必须出现在 failed 列表
    const { cwd, cleanup } = tmpCwd();
    const { dir: backupDir, cleanup: cleanupBackup } = tmpBackupDir();
    try {
      writeFreshBackupStatus(backupDir, "not_configured");

      // production 模式必须跑连通性（不能 skip）；synthetic host 不可达会让
      // 连通性类检查同时失败，但差分断言聚焦 backup_health 的有无
      const failure = await execFileAsync(
        process.execPath,
        [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), script, "--mode", "production"],
        {
          cwd,
          timeout: 120_000,
          env: syntheticProductionEnv(backupDir),
          maxBuffer: 10 * 1024 * 1024,
        },
      ).catch((error: { stdout?: string; code?: number }) => error);

      const stdout = (failure as { stdout?: string }).stdout ?? "";
      expect((failure as { code?: number }).code).not.toBe(0);
      const summary = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(summary.result).toBe("FAIL");
      expect(summary.failed).toContain("backup_health");
      expect(stdout).toContain("PRODUCTION_BACKUP_NOT_READY");
    } finally {
      cleanup();
      cleanupBackup();
    }
  }, 150_000);

  it("PRODUCTION_BACKUP_READY_PASSES_BACKUP_CHECK：fresh + checksumVerified + offsite=success → failed 列表不含 backup_health", async () => {
    const { cwd, cleanup } = tmpCwd();
    const { dir: backupDir, cleanup: cleanupBackup } = tmpBackupDir();
    try {
      writeFreshBackupStatus(backupDir, "success");

      const failure = await execFileAsync(
        process.execPath,
        [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), script, "--mode", "production"],
        {
          cwd,
          timeout: 120_000,
          env: syntheticProductionEnv(backupDir),
          maxBuffer: 10 * 1024 * 1024,
        },
      ).catch((error: { stdout?: string; code?: number }) => error);

      const stdout = (failure as { stdout?: string }).stdout ?? "";
      expect((failure as { code?: number }).code).not.toBe(0);
      const summary = JSON.parse(stdout.trim().split("\n").at(-1)!);
      // 备份维度已满足（productionBackupReady=true）；整体 FAIL 仅来自
      // synthetic host 不可达的连通性检查——差分证明 backup 检查自身 PASS
      expect(summary.failed).not.toContain("backup_health");
    } finally {
      cleanup();
      cleanupBackup();
    }
  }, 150_000);
});
