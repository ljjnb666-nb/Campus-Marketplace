import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
describe("ops-check（npm run ops:check）", () => {
  function tmpCwd(): { cwd: string; cleanup: () => void } {
    const cwd = mkdtempSync(path.join(tmpdir(), "campus-ops-check-"));
    return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
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

  it("production mode 缺契约（无 env）→ exit 1，且不输出任何秘密值", async () => {
    const { cwd, cleanup } = tmpCwd();
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
});
