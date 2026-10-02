import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// vitest 以仓库根为 cwd（npm run test）
const repoRoot = process.cwd();

/**
 * Phase 9A：async-worker 生产拓扑静态 gate（§31/§35/§36/§72）。
 *
 * 验证 compose.production.yml 的 async-worker 服务满足生产契约：
 * - 恰好一个 async-worker 服务（单实例语义）
 * - 仅 backend 网络、无任何 ports 发布、不依赖 Redis 才能运行
 *   （PostgreSQL = durable queue authority）
 * - 使用生产 env 与生产 restart policy、依赖 postgres healthy
 * - Dockerfile 存在专用 async-runner target（复用 cleanup-runner 产物层）
 *   且 entrypoint 指向 async-worker，release identity 同 LR-R2 provenance
 * - deploy.sh 构建路径包含 async-worker（release artifact set）
 * 同时验证 storage-cleanup 原拓扑不退化（§37：两 worker 共存是 9A 的
 * 合法中间态，正式收敛属 9C）。解析采用与 image-immutability gate 相同的
 * 行级方式（不引入 YAML 依赖）。
 */

const composeContent = readFileSync(
  path.join(repoRoot, "compose.production.yml"),
  "utf8",
);
const dockerfileContent = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

/** 去掉 YAML 注释行（注释里的描述不参与契约判定） */
function stripComments(content: string): string[] {
  return content
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line));
}

/** 提取顶层服务块（两级缩进的 `  name:` 到下一个同级键） */
function extractServiceBlock(lines: string[], serviceName: string): string[] {
  const start = lines.findIndex((line) => line === `  ${serviceName}:`);
  if (start < 0) {
    return [];
  }
  const block: string[] = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    // 顶层键（无缩进）或下一个服务名（两格缩进的 `  xxx:`）都终止当前块
    if (/^\S/.test(lines[i]) || /^  [a-z][a-z0-9-]*:/.test(lines[i])) {
      break;
    }
    block.push(lines[i]);
  }
  return block;
}

describe("Phase 9A async-worker 生产拓扑 gate", () => {
  // Phase 9B（§48）：EMAIL 投递复用 async-worker——禁止新增 email-worker
  // 容器（不允许出现无 release provenance 的第二 runner）。
  it("Phase 9B：compose 不存在 email-worker / mail-worker 服务（EMAIL 复用 async-worker）", () => {
    const serviceNames = stripComments(composeContent)
      .map((line) => line.match(/^  ([a-z0-9-]+):$/)?.[1])
      .filter((name): name is string => Boolean(name));
    expect(serviceNames).toContain("async-worker");
    expect(serviceNames).not.toContain("email-worker");
    expect(serviceNames).not.toContain("mail-worker");
  });

  it("compose.production.yml 恰好声明一个 async-worker 服务", () => {
    const serviceDeclarations = stripComments(composeContent).filter(
      (line) => line === "  async-worker:",
    );
    expect(serviceDeclarations).toHaveLength(1);
  });

  it("async-worker 服务：无端口发布、仅 backend 网络、生产 env、restart policy、postgres 依赖", () => {
    const block = extractServiceBlock(stripComments(composeContent), "async-worker");
    const text = block.join("\n");

    expect(block.length).toBeGreaterThan(0);
    // build 自专用 async-runner target + GIT_SHA build arg（release identity 同源）
    expect(text).toMatch(/target:\s*async-runner/);
    expect(text).toMatch(/args:\s*\n\s+GIT_SHA:\s*\$\{GIT_SHA:-unknown\}/);
    // 运行时覆盖禁止（LR-R2 同一原则）
    expect(text).not.toMatch(/RELEASE_SHA:/);
    // immutable tag 契约
    expect(text).toMatch(/image:\s*campus-marketplace-async-worker:\$\{GIT_SHA:-local\}/);
    // 生产 env + NODE_ENV
    expect(text).toMatch(/env_file:\s*\.env\.production/);
    expect(text).toMatch(/NODE_ENV:\s*production/);
    // restart policy（service-defaults 锚点）
    expect(text).toMatch(/\*service-defaults/);
    // 仅 backend 网络、无 ports 发布
    expect(text).toMatch(/-\s*backend/);
    expect(text).not.toMatch(/^\s*ports:/m);
    // 依赖 postgres 健康；不依赖 app / redis（durable authority = PostgreSQL）
    expect(text).toMatch(/postgres:\n\s+condition:\s+service_healthy/);
    expect(text).not.toMatch(/redis:\n\s+condition:/);
    expect(text).not.toMatch(/app:\n\s+condition:/);
    // 默认启动的常驻服务（不经 profile 禁用）
    expect(text).not.toMatch(/profiles:/);
  });

  it("async-worker 轮询配置存在（poll/lease/batch/shutdown-grace env 覆盖）", () => {
    const block = extractServiceBlock(stripComments(composeContent), "async-worker");
    const text = block.join("\n");
    expect(text).toMatch(/ASYNC_WORKER_POLL_MS:\s*\$\{ASYNC_WORKER_POLL_MS:-1000\}/);
    expect(text).toMatch(/ASYNC_WORKER_LEASE_SECONDS:\s*\$\{ASYNC_WORKER_LEASE_SECONDS:-60\}/);
    expect(text).toMatch(/ASYNC_WORKER_BATCH_SIZE:\s*\$\{ASYNC_WORKER_BATCH_SIZE:-10\}/);
    // RB03：shutdown grace 默认 15s，compose stop_grace_period 与之对齐
    expect(text).toMatch(
      /ASYNC_WORKER_SHUTDOWN_GRACE_MS:\s*\$\{ASYNC_WORKER_SHUTDOWN_GRACE_MS:-15000\}/,
    );
    expect(text).toMatch(/stop_grace_period:\s*20s/);

    // worker 源码强制生产安全下限/上限（防 0 poll / 巨 batch 风暴 / 无界 drain）
    const worker = readFileSync(
      path.join(repoRoot, "scripts", "ops", "async-worker.ts"),
      "utf8",
    );
    expect(worker).toMatch(/MIN_PRODUCTION_POLL_MS = 250/);
    expect(worker).toMatch(/MIN_PRODUCTION_LEASE_SECONDS = 30/);
    expect(worker).toMatch(/MAX_PRODUCTION_BATCH_SIZE = 100/);
    expect(worker).toMatch(/MIN_PRODUCTION_SHUTDOWN_GRACE_MS = 1_000/);
    expect(worker).toMatch(/MAX_PRODUCTION_SHUTDOWN_GRACE_MS = 60_000/);
    expect(worker).toMatch(/NODE_ENV === "production"/);
    // bounded shutdown 事件合同（§14/RB03）
    expect(worker).toMatch(/async_worker_shutdown_timeout/);
    expect(worker).toMatch(/async_worker_shutdown_forced/);
  });

  it("worker 入口存在 --run-once 运维 escape hatch", () => {
    const worker = readFileSync(
      path.join(repoRoot, "scripts", "ops", "async-worker.ts"),
      "utf8",
    );
    expect(worker).toMatch(/--run-once/);
  });

  it("Dockerfile 存在 async-runner target：复用 cleanup-runner 产物层 + entrypoint 指向 async-worker", () => {
    expect(dockerfileContent).toMatch(/FROM cleanup-runner AS async-runner/);
    const targetIndex = dockerfileContent.indexOf("AS async-runner");
    const stageBlock = dockerfileContent.slice(targetIndex);
    expect(stageBlock).toMatch(/exec npx tsx scripts\/ops\/async-worker\.ts/);
  });

  it("async-runner 构建期 bake release identity（ARG GIT_SHA + ENV RELEASE_SHA + /app/.release-sha）", () => {
    const startIndex = dockerfileContent.indexOf("AS async-runner");
    expect(startIndex).toBeGreaterThan(-1);
    const stageBlock = dockerfileContent.slice(startIndex);
    expect(stageBlock).toMatch(/ARG GIT_SHA=unknown/);
    expect(stageBlock).toMatch(/ENV RELEASE_SHA=\$\{GIT_SHA\}/);
    expect(stageBlock).toMatch(/RUN printf '%s\\n' "\$\{GIT_SHA\}" > \/app\/\.release-sha/);
    // entrypoint 链：cat .release-sha → 显式 export → exec worker（env_file/-e
    // 运行时覆盖无效）；fail closed：set -eu 无 dev/unknown fallback
    expect(stageBlock).toMatch(/ENTRYPOINT \["\/bin\/sh", "-c",/);
    expect(stageBlock).toMatch(/cat \/app\/\.release-sha/);
    expect(stageBlock).toMatch(/export RELEASE_SHA/);
    expect(stageBlock).toMatch(/set -eu;/);
    expect(stageBlock).not.toMatch(/RELEASE_SHA=dev/);
    expect(stageBlock).not.toMatch(/RELEASE_SHA=unknown/);
  });

  it("deploy.sh release artifact set 包含 async-worker（构建 + 切换 + release log）", () => {
    const deploySh = readFileSync(path.join(repoRoot, "scripts", "ops", "deploy.sh"), "utf8");
    expect(deploySh).toMatch(
      /GIT_SHA="\$\{GIT_SHA\}" compose_run build app migrate storage-cleanup async-worker/,
    );
    // 切换 + 运行时验证（无 dry-run smoke：--run-once 会真实消费任务，绝不作发布 gate）
    expect(deploySh).toMatch(/compose_run up -d --no-deps async-worker/);
    expect(deploySh).toMatch(/campus-marketplace-async-worker:\$\{GIT_SHA\}/);
    expect(deploySh).toMatch(/ASYNC_WORKER_IMAGE=campus-marketplace-async-worker:\$\{GIT_SHA\}/);
  });

  it("§37 storage-cleanup 原拓扑不退化（两 worker 共存是 9A 合法中间态）", () => {
    const block = extractServiceBlock(stripComments(composeContent), "storage-cleanup");
    const text = block.join("\n");
    expect(block.length).toBeGreaterThan(0);
    expect(text).toMatch(/target:\s*cleanup-runner/);
    expect(text).toMatch(/image:\s*campus-marketplace-cleanup:\$\{GIT_SHA:-local\}/);
    expect(text).toMatch(/-\s*backend/);
    expect(text).not.toMatch(/^\s*ports:/m);
    // 9A 禁止删除/迁移既有 cleanup worker（正式收敛属 9C）
    expect(dockerfileContent).toMatch(/AS cleanup-runner/);
    expect(readFileSync(
      path.join(repoRoot, "scripts", "ops", "storage-cleanup-worker.ts"),
      "utf8",
    )).toMatch(/runStorageCleanup/);
  });
});

// ---- release identity runtime 回归（与 cleanup-worker-release-identity 同模式）----
// 运行真实 worker entrypoint（run-once + 合成不可达 DATABASE_URL）：启动日志
// 先于首个 DB 访问发出 → 单周期失败 exit 1。断言真实结构化 logger 输出的
// release 字段 = bake 的 RELEASE_SHA。

const TEST_SHA = ["1234567890abcdef", "1234567890abcdef", "12345678"].join("");
expect(TEST_SHA).toMatch(/^[a-f0-9]{40}$/);

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function spawnAsyncWorker(extraEnv: Record<string, string>): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(repoRoot, "scripts", "ops", "async-worker.ts"),
        "--run-once",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          NODE_ENV: "production",
          // 合成不可达占位（端口 9 = discard）：启动日志先于 DB 访问发出，
          // 随后单周期失败 → run-once exit 1。绝不使用真实连接串。
          DATABASE_URL: "postgresql://build-placeholder:build-placeholder@127.0.0.1:9/build",
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

describe("async-worker release identity runtime 回归（LR-R2 同模式）", () => {
  it("真实 entrypoint 启动日志 release = 构建期 RELEASE_SHA（非 dev）", async () => {
    const result = await spawnAsyncWorker({ RELEASE_SHA: TEST_SHA });
    expect(result.code).toBe(1);
    const startedLine = result.stdout
      .split("\n")
      .find((line) => line.includes("async_worker_started"));
    expect(startedLine, `stdout 应含 async_worker_started：${result.stdout}${result.stderr}`).toBeTruthy();
    const entry = JSON.parse(startedLine!) as { release?: string };
    expect(entry.release).toBe(TEST_SHA);
  }, 30_000);

  it("配置级 fatal：production 下 poll < 250ms → exit non-zero（防 DB 轮询风暴）", async () => {
    const result = await spawnAsyncWorker({
      RELEASE_SHA: TEST_SHA,
      ASYNC_WORKER_POLL_MS: "100",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/ASYNC_WORKER_POLL_MS/);
  }, 30_000);
});
