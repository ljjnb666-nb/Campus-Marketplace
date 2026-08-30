import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// vitest 以仓库根为 cwd（npm run test）
const repoRoot = process.cwd();
const execFileAsync = promisify(execFile);

/** 基于 synthetic 生产 env 生成变体 fixture（全部为合成占位值） */
function buildFixture(overrides: Record<string, string>): string {
  const base = readFileSync(path.join(repoRoot, ".env.production.synthetic"), "utf8");
  let content = base;
  for (const [key, value] of Object.entries(overrides)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    content = re.test(content) ? content.replace(re, `${key}=${value}`) : `${content}\n${key}=${value}`;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "env-check-"));
  const file = path.join(dir, ".env.production");
  writeFileSync(file, content);
  return file;
}

/** Windows 下 spawn "npx" 需要 shell；直接用 node 调 tsx CLI（跨平台）。
 * 显式提供最小干净环境：checker 会用 process.env 覆盖 fixture 值，
 * 继承 vitest 进程的 .env 变量会导致评估失真。 */
function runEnvCheck(file: string) {
  const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  return execFileAsync(
    process.execPath,
    [tsxCli, "scripts/production-env-check.ts", "--file", file],
    {
      cwd: repoRoot,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        SystemDrive: process.env.SystemDrive ?? "C:",
        TEMP: process.env.TEMP ?? "",
        TMP: process.env.TMP ?? "",
        APPDATA: process.env.APPDATA ?? "",
      },
    },
  );
}

describe("production-env-check（self-hosted bucket 契约）", () => {
  it("self-hosted MinIO + 固定 campus-public/campus-private → PASS", async () => {
    const file = buildFixture({});
    try {
      const { stdout } = await runEnvCheck(file);
      expect(stdout).toContain("S3_BUCKET_PUBLIC.selfhosted-contract");
      expect(stdout).toContain("全部");
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true });
    }
  }, 150_000);

  it("self-hosted MinIO + 自定义桶名（配置漂移）→ FAIL 拒绝部署", async () => {
    const file = buildFixture({
      S3_BUCKET_PUBLIC: "my-public-bucket",
      S3_BUCKET_PRIVATE: "my-private-bucket",
    });
    try {
      await expect(runEnvCheck(file)).rejects.toThrow(/selfhosted-contract|不合规/u);
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true });
    }
  }, 150_000);

  it("外部 S3 provider 可使用自定义桶名 → PASS", async () => {
    const file = buildFixture({
      S3_ENDPOINT: "https://s3.example-provider.com",
      S3_BUCKET_PUBLIC: "my-public-bucket",
      S3_BUCKET_PRIVATE: "my-private-bucket",
    });
    try {
      const { stdout } = await runEnvCheck(file);
      expect(stdout).not.toContain("FAIL");
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true });
    }
  }, 150_000);
});
