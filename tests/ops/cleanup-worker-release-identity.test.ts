import { spawn } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// vitest 以仓库根为 cwd（npm run test）
const repoRoot = process.cwd();

/**
 * LR-R2（LAUNCH_REHEARSAL_REPAIR R2）：cleanup worker release identity 回归。
 *
 * 合同：worker 结构化启动日志的 release 字段必须等于构建期 bake 进镜像的
 * RELEASE_SHA（与不可变 image tag 同源），而不是 logger 缺省的 "dev"。
 *
 * 本测试运行【真实的 worker entrypoint】（tsx scripts/ops/storage-cleanup-worker.ts）
 * 在 run-once + dry-run 模式下：启动日志在首个 DB 访问之前发出，之后单周期
 * 因不可达 DATABASE_URL 失败 → run-once 立即 exit 1（worker 既有语义）。
 * 断言对象是真实结构化 logger 的 stdout 输出（不是只查源码里有没有
 * RELEASE_SHA 字样），证明 logger 真正使用了该环境值。
 *
 * 无凭据：DATABASE_URL 为合成不可达占位值（与 Dockerfile 构建占位同模式），
 * 输出中不得出现任何连接串/凭据形态。
 */

const TEST_SHA = ["1234567890abcdef", "1234567890abcdef", "12345678"].join("");
// 40 位 hex 校验（TEST_SHA 拼接错误时让测试自身先失败）
expect(TEST_SHA).toMatch(/^[a-f0-9]{40}$/);

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function spawnWorker(releaseSha: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    // cwd 必须是仓库根：worker 经 @/lib/logger 别名导入（tsx 按 cwd 的
    // tsconfig 解析路径）。显式 process.env 值不会被 dotenv 覆盖，
    // 断言因此不受仓库本地 env 文件影响。
    const child = spawn(
      process.execPath,
      [
        path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(repoRoot, "scripts", "ops", "storage-cleanup-worker.ts"),
        "--run-once",
        "--dry-run",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          NODE_ENV: "production",
          // 合成不可达占位（端口 9 = discard）：启动日志先于 DB 访问发出，
          // 随后单周期失败 → run-once exit 1。绝不使用真实连接串。
          DATABASE_URL: "postgresql://build-placeholder:build-placeholder@127.0.0.1:9/build",
          // 未设置 S3_*：仅当周期需要 S3 时才会涉及；本测试只断言启动日志
          ASSET_CLEANUP_INTERVAL_SECONDS: "1800",
          // 对照用例传空串 = 模拟"未 bake"镜像：releaseSha 为空时必须真正
          // delete（空串不触发 ?? 缺省，logger 会得到 "" 而非 "dev"）
          ...(releaseSha === "" ? {} : { RELEASE_SHA: releaseSha }),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`worker 未在预算时间内退出（stdout 前 200 字符：${stdout.slice(0, 200)}）`));
    }, 60_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe("LR-R2 cleanup worker 结构化日志 release identity（真实 entrypoint）", () => {
  it("release == bake 的 RELEASE_SHA（非 dev），event/context/environment 契约成立", async () => {
    const { stdout, code } = await spawnWorker(TEST_SHA);

    // 找到结构化启动日志行（单行 JSON）
    const startupLine = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"))
      .find((line) => line.includes("storage_cleanup_worker_started"));
    expect(startupLine, `stdout 中必须有启动日志，实际：${stdout.slice(0, 400)}`).toBeTruthy();

    const parsed = JSON.parse(startupLine!) as Record<string, unknown>;
    expect(parsed.event).toBe("storage_cleanup_worker_started");
    expect(parsed.context).toBe("storage-cleanup-worker");
    expect(parsed.environment).toBe("production");
    // 核心断言：真实 logger 输出使用构建期身份，而非缺省 "dev"
    expect(parsed.release).toBe(TEST_SHA);
    expect(parsed.release).not.toBe("dev");

    // run-once + 不可达 DB → 单周期失败退出（worker 既有语义）；启动日志不受影响
    expect(code).not.toBe(0);
  });

  it("对照：未设置 RELEASE_SHA 时维持 logger 缺省 dev（防御性可观测，不假造身份）", async () => {
    const { stdout } = await spawnWorker("");
    const startupLine = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"))
      .find((line) => line.includes("storage_cleanup_worker_started"));
    expect(startupLine).toBeTruthy();
    const parsed = JSON.parse(startupLine!) as Record<string, unknown>;
    expect(parsed.release).toBe("dev");
  });

  it("输出无凭据/连接串泄漏（launch rehearsal §13 合同不变）", async () => {
    const { stdout, stderr } = await spawnWorker(TEST_SHA);
    for (const output of [stdout, stderr]) {
      expect(output).not.toContain("build-placeholder@");
      expect(output).not.toMatch(/postgresql:\/\/[^\s"]*:[^\s"]*@/);
    }
  });
});
