/**
 * FINAL REPAIR B 审计修复（测试辅助）：
 * 以生产同款入口（scripts/ops/storage-cleanup-worker.ts）运行 cleanup
 * worker 子进程，供集成测试与本地取证复用。
 *
 * 进程管理（Windows 可靠性关键）：直接以 `node --import tsx <entry>` 启动
 * （不用 npx/.cmd 包装、不用 shell）——child.pid 即真实 node 进程，
 * killTree 的 taskkill /T /F 可精确终止整棵树，"包装进程已退出但 tsx
 * 孤儿继续运行"的竞态不会发生。prisma CLI 同理直接走
 * node_modules/prisma/build/index.js。
 */

import { execFileSync, spawn } from "node:child_process";
import path from "node:path";

export const WORKER_ENTRY = path.join(
  process.cwd(),
  "scripts",
  "ops",
  "storage-cleanup-worker.ts",
);

const PRISMA_CLI = path.join(
  process.cwd(),
  "node_modules",
  "prisma",
  "build",
  "index.js",
);

/** 生产 compose storage-cleanup 服务 ENTRYPOINT 的本地等价物（--run-once 模式） */
export function runWorker(args, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", WORKER_ENTRY, ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: "test", ...extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** 常驻 worker 的启动句柄（自动循环验证用，无 --run-once） */
export function spawnWorkerLoop(extraEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", WORKER_ENTRY], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "test", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  child.stderr.on("data", (chunk) => (output += String(chunk)));
  return { child, getOutput: () => output };
}

/** 终止 worker 进程树并等待其真正退出（循环测试必须保证无孤儿存活） */
export async function killTree(child) {
  if (process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        // pid 来自本进程创建的 ChildProcess 对象（非外部输入）
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } catch {
        // already gone
      }
    }
  } else {
    child.kill("SIGTERM");
  }
  // 等待 close 事件（有界）：防止孤儿 worker 污染后续用例
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      child.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/**
 * 运行 prisma CLI 命令（直接 node 入口 + env 注入连接串 + stdin 传 SQL，
 * 凭据不进 argv、无 shell）。worker 集成测试用它创建/销毁一次性隔离数据库。
 */
export function runPrismaCommand(args, env, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PRISMA_CLI, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
