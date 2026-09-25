import { execFile, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

// vitest 以仓库根为 cwd（npm run test）
const repoRoot = process.cwd();
const execFileAsync = promisify(execFile);

function hasDocker(): boolean {
  try {
    execSync("docker version --format ok", { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * RB-06 FINAL-03：Docker build context provenance gate。
 *
 * 冻结不变量（§4）：EVERY NON-GIT INPUT THAT MAY EXIST LOCALLY MUST BE
 * EXCLUDED FROM DOCKER BUILD CONTEXT —— Docker build input 必须是 committed
 * git tree 的确定性投影。`git status --porcelain`（deploy STEP 0）看不到
 * git ignored 文件，因此 .dockerignore 必须与 .gitignore 的本地/运行时产物
 * 对齐，否则 CLEAN_GIT_TREE != COMMITTED_ONLY_DOCKER_CONTEXT。
 *
 * 隐私意义：public/uploads 是 legacy/runtime upload area——部署主机本地遗留
 * 上传文件绝不能被烘进 immutable production image（本测试只验证 context
 * 语义；主机遗留文件的 inventory/quarantine 属既有 operational debt）。
 */

const PLACEHOLDER = "public/uploads/placeholders/product-cover.svg";

/** §8 静态合同最低要求：.dockerignore 必须包含的 pattern */
const REQUIRED_DOCKERIGNORE_PATTERNS = [
  "public/uploads/*",
  "next-env.d.ts",
  "*.log",
  ".vercel",
  ".tmp-test-uploads",
  ".playwright-mcp",
  "prisma/dev.db",
  "/*.png",
  "*.pem",
  "*.stackdump",
] as const;

/** §8：placeholder negation（Docker ignore 语义：先排目录再 re-include） */
const REQUIRED_NEGATIONS = [
  "!public/uploads/placeholders/",
  "!public/uploads/placeholders/**",
] as const;

describe("DOCKER_CONTEXT_PROVENANCE static gate", () => {
  it(".dockerignore 包含全部关键 runtime/local exclude patterns（§8）", () => {
    const content = readFileSync(path.join(repoRoot, ".dockerignore"), "utf8");
    for (const pattern of REQUIRED_DOCKERIGNORE_PATTERNS) {
      expect(
        content.split(/\r?\n/).some((line) => line.trim() === pattern),
        `.dockerignore 缺少 pattern: ${pattern}`,
      ).toBe(true);
    }
    for (const negation of REQUIRED_NEGATIONS) {
      expect(
        content.split(/\r?\n/).some((line) => line.trim() === negation),
        `.dockerignore 缺少 placeholder negation: ${negation}`,
      ).toBe(true);
    }
  });

  it(".dockerignore 与 .gitignore 的 runtime/local 语义对齐且未放宽既有 excludes", () => {
    const gitignore = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
    const dockerignore = readFileSync(path.join(repoRoot, ".dockerignore"), "utf8");
    // .gitignore 目录条目带尾部 /，规范化后比较（保持两份清单同源）
    const gitLines = new Set(
      gitignore.split(/\r?\n/).map((l) => l.trim().replace(/\/$/, "")),
    );
    const dockerLines = new Set(dockerignore.split(/\r?\n/).map((l) => l.trim()));
    for (const pattern of REQUIRED_DOCKERIGNORE_PATTERNS) {
      expect(gitLines.has(pattern), `${pattern} 应同样登记在 .gitignore（同源清单）`).toBe(true);
      expect(dockerLines.has(pattern), `${pattern} 必须在 .dockerignore 中`).toBe(true);
    }
    // 既有 excludes 不得放宽（§6）
    for (const kept of ["node_modules", ".next", "out", ".git", ".github", ".env", ".env.*", "tests", "coverage", "playwright-report", "test-results", "docs", ".vscode", ".idea", ".DS_Store", ".mimosa", "tsconfig.tsbuildinfo"]) {
      expect(dockerLines.has(kept), `既有 exclude 不得移除: ${kept}`).toBe(true);
    }
  });

  it("tracked placeholder 资产真实存在且被 git 跟踪（CTX-02 前置）", async () => {
    const abs = path.join(repoRoot, PLACEHOLDER);
    expect(existsSync(abs), `${PLACEHOLDER} 必须存在于工作树`).toBe(true);
    const { stdout } = await execFileAsync("git", ["ls-files", PLACEHOLDER], { cwd: repoRoot });
    expect(stdout.trim(), `${PLACEHOLDER} 必须被 git 跟踪`).toBe(PLACEHOLDER);
  });
});

// ---- §9-12：真实 Docker context canary（验证 .dockerignore 实际语义） ----

interface Canary {
  /** 相对仓库根的 canary 路径 */
  relPath: string;
  /** 是否需要测试自己创建（已存在的本地文件只验证 context 缺席，绝不删除） */
  create: boolean;
  label: string;
}

/** canary 路径硬校验：必须是仓库内的相对字面量路径，杜绝任何路径穿越形态 */
function resolveInsideRepo(rel: string): string {
  if (rel.includes("..") || path.isAbsolute(rel) || !/^[\w][\w./-]*$/.test(rel)) {
    throw new Error(`unsafe canary path: ${rel}`);
  }
  const abs = path.resolve(repoRoot, rel);
  if (abs !== repoRoot && !abs.startsWith(repoRoot + path.sep)) {
    throw new Error(`canary path escapes repo root: ${rel}`);
  }
  return abs;
}

describe.skipIf(!hasDocker())("DOCKER_CONTEXT_PROVENANCE dynamic canary（真实 docker build probe）", () => {
  const created: string[] = [];
  const imageTag = `campus-ctx-probe-${process.pid}-${Date.now()}`;
  let containerId = "";

  const canaries: Canary[] = [
    // CTX-01：runtime upload（legacy upload area 语义）
    { relPath: `public/uploads/DO-NOT-ENTER-IMAGE-${process.pid}.txt`, create: true, label: "CTX-01 public/uploads runtime file" },
    // CTX-03：Next.js 本地产物
    { relPath: "next-env.d.ts", create: true, label: "CTX-03 next-env.d.ts" },
    // CTX-04：仓库根本地截图
    { relPath: `debug-screenshot-${process.pid}.png`, create: true, label: "CTX-04 root png" },
    // CTX-05：本地开发数据库
    { relPath: "prisma/dev.db", create: true, label: "CTX-05 prisma/dev.db" },
    // CTX-06：本地日志
    { relPath: `local-debug-${process.pid}.log`, create: true, label: "CTX-06 local log" },
  ];

  afterEach(() => {
    for (const rel of created.splice(0)) {
      rmSync(resolveInsideRepo(rel), { force: true });
    }
  });

  it(
    "CTX-01..06：git ignored canary 不进 Docker context；tracked placeholder 进入 context",
    async () => {
      // 1) 准备 canary：只创建不存在的（本地已存在的 ignored 文件只验证缺席，
      //    绝不删除/污染本地状态）；public/uploads 目录按需创建。
      for (const canary of canaries) {
        const abs = resolveInsideRepo(canary.relPath);
        if (!existsSync(abs)) {
          mkdirSync(path.dirname(abs), { recursive: true });
          writeFileSync(abs, "RB-06 FINAL-03 canary: DO NOT ENTER IMAGE\n");
          created.push(canary.relPath);
          canary.create = true;
        } else {
          canary.create = false;
        }
      }

      // 2) 真实 docker build：context = 仓库根（.dockerignore 生效），
      //    probe Dockerfile 只做 COPY . /context（FROM scratch，零拉取）。
      try {
        await execFileAsync(
          "docker",
          ["build", "-q", "-f", "tests/ops/docker-context-probe.Dockerfile", "-t", imageTag, "."],
          { cwd: repoRoot, timeout: 300_000, maxBuffer: 10 * 1024 * 1024 },
        );
        const { stdout: cid } = await execFileAsync(
          "docker",
          // scratch 镜像无 CMD：create 只解析 config、不执行容器，
          // 提供占位 command 满足 daemon 校验即可
          ["create", imageTag, "/bin/true"],
          { timeout: 60_000 },
        );
        containerId = cid.trim();

        // 3) 列举 context 全部文件（export tar 条目形如 context/<path>，规范化去除前缀）
        const { stdout } = await execFileAsync(
          "bash",
          ["-c", `docker export ${containerId} | tar -tf -`],
          { cwd: repoRoot, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
        );
        const contextFiles = new Set(
          stdout
            .split(/\r?\n/)
            .map((l) => l.replace(/^\.\//, "").replace(/^context\//, ""))
            .filter((l) => l.length > 0),
        );

        // 4) canary 全部缺席（CTX-01/03/04/05/06）
        for (const canary of canaries) {
          const present = contextFiles.has(canary.relPath);
          expect(
            present,
            `${canary.label}（${canary.relPath}${canary.create ? "" : "，本地既有"}）不得进入 Docker build context`,
          ).toBe(false);
        }
        // 本地真实 legacy runtime uploads（public/uploads/avatar 等，若存在）同样缺席；
        // 仅 tracked placeholder 子树（及其父目录条目）允许在场（CTX-02）
        for (const entry of contextFiles) {
          if (entry.endsWith("/") || !entry.includes(".")) continue; // 纯目录条目无内容
          if (entry.startsWith("public/uploads/")) {
            expect(
              entry.startsWith("public/uploads/placeholders/"),
              `context 中出现 runtime upload: ${entry}`,
            ).toBe(true);
          }
        }

        // 5) tracked placeholder 必须在场（CTX-02，不得误删 tracked runtime asset）
        expect(
          contextFiles.has(PLACEHOLDER),
          `tracked placeholder ${PLACEHOLDER} 必须进入 Docker context`,
        ).toBe(true);
      } finally {
        if (containerId) {
          await execFileAsync("docker", ["rm", "-f", containerId]).catch(() => undefined);
        }
        await execFileAsync("docker", ["rmi", "-f", imageTag]).catch(() => undefined);
      }
    },
    420_000,
  );
});
