import { execFile, execSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// vitest 以仓库根为 cwd（npm run test）
const repoRoot = process.cwd();
const execFileAsync = promisify(execFile);

function hasBash(): boolean {
  try {
    execSync("bash -c 'echo ok'", { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

function hasDocker(): boolean {
  try {
    execSync("docker version --format ok", { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

describe("rollback / restore shell-level regression（tests/ops/rollback-restore.test.sh）", () => {
  it.skipIf(!hasBash())(
    "safe rollback 不碰 DB；hard 失败阻断回滚；SHA/确认缺失全部 fail",
    async () => {
      // 长耗时命令必须走异步 execFile：execSync 会阻塞 vitest worker 事件循环，
      // 导致 worker RPC（onTaskUpdate）超时误报 unhandled error
      const { stdout } = await execFileAsync("bash", ["tests/ops/rollback-restore.test.sh"], {
        cwd: repoRoot,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      expect(stdout).toMatch(/FAIL=0/);
    },
    150_000,
  );
});

describe("deploy release gate shell-level regression（tests/ops/deploy-gate.test.sh）", () => {
  it.skipIf(!hasBash())(
    "verifier PASS 才写 release log；FAIL/degraded/invalid SHA 一律 fail closed（不真实部署）",
    async () => {
      try {
        const { stdout } = await execFileAsync("bash", ["tests/ops/deploy-gate.test.sh"], {
          cwd: repoRoot,
          timeout: 180_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        expect(stdout).toMatch(/FAIL=0/);
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string };
        console.error("deploy-gate stdout:\n", e.stdout);
        console.error("deploy-gate stderr:\n", e.stderr);
        throw error;
      }
    },
    200_000,
  );
});

describe("backup status artifact shell-level regression（tests/ops/backup-status.test.sh）", () => {
  it.skipIf(!hasBash())(
    "成功/空 dump/offsite 失败三场景均产出正确 backup-status.json 且退出码语义正确",
    async () => {
      const { stdout } = await execFileAsync("bash", ["tests/ops/backup-status.test.sh"], {
        cwd: repoRoot,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      expect(stdout).toMatch(/FAIL=0/);
    },
    150_000,
  );
});

describe("compose production config（--env-file 统一插值来源）", () => {
  it.skipIf(!hasDocker())(
    "docker compose --env-file <synthetic> -f compose.production.yml config 在 shell 未导出任何生产变量时 PASS",
    async () => {
      const envFile = path.join(repoRoot, ".env.production");
      const syntheticFile = path.join(repoRoot, ".env.production.synthetic");
      const existedBefore = existsSync(envFile);
      const originalContent = existedBefore ? readFileSync(envFile, "utf8") : null;
      copyFileSync(syntheticFile, envFile);

      try {
        // 清空 shell 中可能存在的生产变量：插值必须只来自 --env-file
        const cleared = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              ![
                "SITE_ADDRESS",
                "POSTGRES_USER",
                "POSTGRES_PASSWORD",
                "POSTGRES_DB",
                "REDIS_PASSWORD",
                "GIT_SHA",
                "MINIO_ROOT_USER",
                "MINIO_ROOT_PASSWORD",
                "S3_ACCESS_KEY_ID",
                "S3_SECRET_ACCESS_KEY",
              ].includes(key),
          ),
        );
        const { stdout } = await execFileAsync(
          "docker",
          [
            "compose",
            "--env-file",
            ".env.production",
            "-f",
            "compose.production.yml",
            "--profile",
            "ops",
            "--profile",
            "selfhosted-minio",
            "config",
          ],
          {
            cwd: repoRoot,
            env: { NODE_ENV: "test", ...cleared },
            timeout: 120_000,
            maxBuffer: 10 * 1024 * 1024,
          },
        );
        // 插值来自 .env.production：synthetic 值必须出现在渲染结果中
        expect(stdout).toContain("campus.example.edu.cn");
        expect(stdout).toContain("campus_marketplace");
        // 关键服务全部渲染（config 输出以服务名组织）
        for (const service of [
          "caddy:",
          "app:",
          "postgres:",
          "redis:",
          "migrate:",
          "minio:",
          "minio-init:",
        ]) {
          expect(stdout).toContain(service);
        }
      } finally {
        if (originalContent !== null) {
          writeFileSync(envFile, originalContent);
        } else {
          rmSync(envFile);
        }
      }
    },
    150_000,
  );
});

describe("ops scripts 静态红线（关键路径绝不允许吞错）", () => {
  it("rollback/restore/backup 关键路径不得包含 '&& true' / '|| true'", () => {
    const criticalScripts = [
      "scripts/ops/rollback.sh",
      "scripts/ops/restore-production-postgres.sh",
      "scripts/ops/restore-postgres.sh",
      "scripts/ops/backup-postgres.sh",
    ];
    for (const file of criticalScripts) {
      const content = readFileSync(path.join(repoRoot, file), "utf8");
      expect(content, `${file} 不得包含 "&& true"`).not.toMatch(/&&\s*true/);
      expect(content, `${file} 不得包含 "|| true"`).not.toMatch(/\|\|\s*true/);
    }
  });

  it("rollback 必须显式选择目标镜像并在 up 前 hard assert", () => {
    const content = readFileSync(path.join(repoRoot, "scripts/ops/rollback.sh"), "utf8");
    // app 切换必须带 GIT_SHA=<target>（不允许 fallback 到 :local/当前 HEAD）
    expect(content).toMatch(/GIT_SHA="\$\{target_sha\}" compose_run up -d --no-deps --wait app/);
    // 必须用 compose config --images 做插值后镜像断言
    expect(content).toMatch(/config --images/);
    expect(content).toMatch(/campus-marketplace-app:\$\{target_sha\}/);
  });

  it("Caddy 公共资产只读出口存在且 bucket 前缀固定为 public 桶", () => {
    const content = readFileSync(path.join(repoRoot, "deploy/Caddyfile"), "utf8");
    expect(content).toMatch(/handle_path \/assets\/\*/);
    expect(content).toMatch(/rewrite \* \/campus-public\{uri\}/);
    // route 只指向 minio，private 桶名不得出现在资产 route 附近
    expect(content).not.toMatch(/campus-private/);
  });

  // ---- RB-06 FINAL-02：release gate 权威不可被 env override 替换 ----

  it("RELEASE_VERIFIER_BYPASS_ABSENT：deploy/rollback 不得包含 OPS_RELEASE_VERIFIER", () => {
    for (const file of ["scripts/ops/deploy.sh", "scripts/ops/rollback.sh"]) {
      const content = readFileSync(path.join(repoRoot, file), "utf8");
      expect(content, `${file} 不得包含 OPS_RELEASE_VERIFIER`).not.toContain(
        "OPS_RELEASE_VERIFIER",
      );
      // 唯一权威 verifier 必须被直接调用
      expect(content, `${file} 必须调用 release-readiness-check.ts`).toContain(
        "release-readiness-check.ts",
      );
    }
  });

  it("OPS_HEALTH_TIMEOUT_SEAM_SAFE：等待预算 seam 只接受正整数，无注入面", () => {
    for (const file of ["scripts/ops/deploy.sh", "scripts/ops/rollback.sh"]) {
      const content = readFileSync(path.join(repoRoot, file), "utf8");
      expect(content, `${file} 必须校验 OPS_HEALTH_TIMEOUT 为正整数`).toMatch(
        /\^\[1-9\]\[0-9\]\*\$/,
      );
    }
  });

  // ---- RB-06 FINAL-01：source artifact identity 静态合同 ----

  it("SOURCE_IDENTITY_GATE_ORDER：deploy.sh 的 source identity gate 必须先于 build/backup/migrate/app-up", () => {
    const content = readFileSync(path.join(repoRoot, "scripts/ops/deploy.sh"), "utf8");
    const identity = content.indexOf("SOURCE ARTIFACT IDENTITY");
    // 各生产副作用的首次出现位置
    const envCheck = content.indexOf("production-env-check");
    const build = content.indexOf('compose_run build');
    const backup = content.indexOf("backup-postgres.sh");
    const migrate = content.indexOf("run --rm migrate");
    const up = content.indexOf("up -d --no-deps --wait app");
    const gate = content.indexOf("release readiness gate");
    for (const [name, idx] of [
      ["production-env-check", envCheck],
      ["compose build", build],
      ["backup-postgres", backup],
      ["migrate", migrate],
      ["app up", up],
      ["release readiness gate", gate],
    ] as const) {
      expect(idx, `${name} 必须存在`).toBeGreaterThan(-1);
      expect(
        identity,
        `source identity gate 必须先于 ${name}`,
      ).toBeLessThan(idx);
    }
  });

  it("SOURCE_IDENTITY_CONTRACT_STATIC：40-hex 校验/HEAD 相等/commit 存在/clean tree 缺一不可，且禁止 SHA 截断", () => {
    const deploy = readFileSync(path.join(repoRoot, "scripts/ops/deploy.sh"), "utf8");
    // 40-hex 正则 + HEAD 解析 + 相等断言 + commit 存在 + porcelain clean
    expect(deploy).toMatch(/\^\[a-fA-F0-9\]\{40\}\$/);
    expect(deploy).toContain('rev-parse HEAD');
    expect(deploy).toContain("RELEASE_SOURCE_SHA_MISMATCH");
    expect(deploy).toContain('rev-parse --verify');
    expect(deploy).toContain("RELEASE_SOURCE_COMMIT_NOT_FOUND");
    expect(deploy).toContain("status --porcelain");
    expect(deploy).toContain("RELEASE_SOURCE_TREE_DIRTY");
    // 禁止截断任意输入后接受（GIT_SHA=...:0:40 / PREVIOUS_SHA:0:40）
    expect(deploy, "deploy.sh 不得截断 SHA").not.toMatch(/:0:40/);
    const rollback = readFileSync(path.join(repoRoot, "scripts/ops/rollback.sh"), "utf8");
    expect(rollback).toMatch(/\^\[a-fA-F0-9\]\{40\}\$/);
    expect(rollback, "rollback.sh 不得截断 SHA").not.toMatch(/:0:40/);
    expect(rollback).toMatch(/INVALID_EXPECTED_SHA/);
  });
});
