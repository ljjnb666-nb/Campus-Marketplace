/**
 * FINAL REPAIR B 审计修复（测试辅助）：
 * 以生产同款入口（scripts/ops/storage-cleanup-worker.ts）运行 cleanup
 * worker 子进程，供集成测试与本地取证复用。与 upload-boundary-harness
 * 同一进程管理模式（Windows shell:true + taskkill 整树终止）。
 */

import { execFileSync, spawn } from "node:child_process";
import path from "node:path";

export const WORKER_ENTRY = path.join(
  process.cwd(),
  "scripts",
  "ops",
  "storage-cleanup-worker.ts",
);

/** 生产 compose storage-cleanup 服务 ENTRYPOINT 的本地等价物 */
export function runWorker(args, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", WORKER_ENTRY, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        ...extraEnv,
      },
      // Windows 上 npx 是 .cmd，Node ≥18.20 必须 shell:true（否则 spawn EINVAL）
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** 以固定参数表运行一次性 worker（runWorker 的同步参数版） */
export function runWorkerWithEnv(args, extraEnv) {
  return runWorker(args, extraEnv);
}

/** 常驻 worker 的启动句柄（自动循环验证用） */
export function spawnWorkerLoop(extraEnv) {
  const child = spawn("npx", ["tsx", WORKER_ENTRY], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      ...extraEnv,
    },
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  child.stderr.on("data", (chunk) => (output += String(chunk)));
  return { child, getOutput: () => output };
}

/** Windows shell:true 下必须整树终止，避免孤儿 worker 干扰后续用例 */
export function killTree(child) {
  if (process.platform === "win32") {
    // 进程已自行退出（exitCode/signalCode 就绪）时无需 kill；
    // taskkill 的 "process not found" 竞态同样容忍——目标已是孤儿
    if (child.exitCode !== null || child.signalCode) {
      return;
    }
    try {
      // pid 来自本进程创建的 ChildProcess 对象（非外部输入）
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch {
      // already gone
    }
  } else {
    child.kill("SIGTERM");
  }
}

/**
 * 运行 prisma CLI 命令（固定参数 + env 注入连接串 + stdin 传 SQL，
 * 凭据不进 argv）。worker 集成测试用它创建/销毁一次性隔离数据库。
 */
export function runPrismaCommand(args, env, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["prisma", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      shell: process.platform === "win32",
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
