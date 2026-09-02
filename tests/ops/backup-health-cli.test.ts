import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const script = path.join(repoRoot, "scripts", "ops", "backup-health-check.ts");

/**
 * 修复轮 3：backup-health-check CLI mode 契约（fail-closed）。
 * INVALID_BACKUP_HEALTH_MODE_TEST：显式非法 mode（如 typo prodcution）必须
 * exit!=0——即使无备份 + strict=false 本应落入 development 的 exit 0 语义，
 * 也必须先因 invalid mode 失败，绝不静默降级。
 */
describe("backup-health-check CLI mode contract", () => {
  function runCli(argv: string[], env: NodeJS.ProcessEnv = process.env) {
    return execFileAsync(process.execPath, [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), script, ...argv], {
      cwd: repoRoot,
      timeout: 120_000,
      env,
      maxBuffer: 10 * 1024 * 1024,
    }).catch((error: { stdout?: string; code?: number }) => error);
  }

  const devEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", BACKUP_DIR: "" };

  it("INVALID_BACKUP_HEALTH_MODE_TEST：--mode prodcution → exit!=0 + reason=INVALID_BACKUP_HEALTH_MODE", async () => {
    const failure = await runCli(["--mode", "prodcution"], devEnv);

    expect((failure as { code?: number }).code).not.toBe(0);
    const stdout = (failure as { stdout?: string }).stdout ?? "";
    const summary = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(summary.result).toBe("FAIL");
    expect(summary.reason).toBe("INVALID_BACKUP_HEALTH_MODE");
    expect(summary.allowedModes).toEqual(["production", "development", "ci"]);
    // 绝不能落进 development 的 exit 0 语义（无备份时 development 本应 exit 0）
    expect(stdout).not.toContain('"healthy":');
  });

  it.each(["", "prod", "staging"])("非法显式 mode %j → exit!=0", async (badMode) => {
    const failure = await runCli(["--mode", badMode], devEnv);

    expect((failure as { code?: number }).code).not.toBe(0);
    const summary = JSON.parse(((failure as { stdout?: string }).stdout ?? "").trim().split("\n").at(-1)!);
    expect(summary.reason).toBe("INVALID_BACKUP_HEALTH_MODE");
  });

  it("--mode 后没有值 → exit!=0", async () => {
    const failure = await runCli(["--mode"], devEnv);

    expect((failure as { code?: number }).code).not.toBe(0);
    const summary = JSON.parse(((failure as { stdout?: string }).stdout ?? "").trim().split("\n").at(-1)!);
    expect(summary.reason).toBe("INVALID_BACKUP_HEALTH_MODE");
  });

  it("合法 production mode 继续工作：无备份 → exit!=0（fail-closed 语义而非 mode 错误）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "campus-bh-cli-prod-"));
    try {
      const failure = await runCli(["--mode", "production", "--dir", dir], devEnv);

      expect((failure as { code?: number }).code).not.toBe(0);
      const report = JSON.parse(((failure as { stdout?: string }).stdout ?? "").trim().split("\n").at(-1)!);
      expect(report.healthy).toBe(false);
      expect(report.reasons.join()).toMatch(/backup-status/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);

  it("合法 development mode 继续工作：无备份 → exit 0（报告事实不阻断）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "campus-bh-cli-dev-"));
    try {
      const { stdout } = await runCli(["--mode", "development", "--dir", dir], devEnv);

      const report = JSON.parse(((stdout as string) ?? "").trim().split("\n").at(-1)!);
      expect(report.mode).toBe("development");
      expect(report.healthy).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);

  it("合法 ci mode 继续工作：无备份 → exit 0（宽松语义，供 ops-check ci 调用）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "campus-bh-cli-ci-"));
    try {
      const { stdout } = await runCli(["--mode", "ci", "--dir", dir], devEnv);

      const report = JSON.parse(((stdout as string) ?? "").trim().split("\n").at(-1)!);
      expect(report.mode).toBe("ci");
      expect(report.healthy).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);
});
