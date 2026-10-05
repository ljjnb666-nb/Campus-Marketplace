import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// vitest 以仓库根为 cwd（npm run test）
const repoRoot = process.cwd();

/**
 * CI-OPT-01：CI workflow 调度合同静态 gate。
 *
 * 合同（branch protection required check name 视为外部冻结合同，
 * 本仓库无 administration 权限读取其配置，故按 name 精确锁定）：
 *
 * - OPT-A stale run cancellation：workflow 级 concurrency 存在；
 *   group 以 pull_request.number 为 PR fallback（同一 PR successive HEAD
 *   共享 group，stale run 可被新 HEAD run 取消）、以 github.run_id 为
 *   非 PR fallback（master 每次 push 独立 group：既不 cancel running，
 *   也不 replace pending，每个 merge commit 保留独立 exact-master
 *   post-merge evidence）；cancel-in-progress 仅在 pull_request 事件为真。
 * - OPT-B 并行 gate：e2e 不再 needs: verify；两个 job 各自自包含
 *   （独立 runner VM、独立 PG 库 campus / campus_e2e），均为
 *   required-capable gate。
 * - Release gate 不变量：verify 保留 typecheck / lint / migrate deploy
 *   （fresh + 幂等重跑）/ test:coverage / build；e2e 保留真实
 *   PostgreSQL / Redis / MinIO + production build + Playwright +
 *   teardown + 失败工件上传；任何 gate step 不得 continue-on-error / || true。
 * - 触发器不变：master push + 全部 pull_request，完整 post-merge CI。
 *
 * 实现按仓库既有约定（ops-check-topology.test.ts）使用结构化 /
 * 局部断言（stripComments + 块提取），不为此引入 YAML 库依赖。
 */

const ciYml = readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");

/** 必须永久稳定的 required check name（branch protection 外部冻结合同） */
export const CI_CHECK_NAMES = {
  verify: "verify (lint / typecheck / test / build)",
  e2e: "e2e (playwright critical paths)",
} as const;

/** 去掉 YAML 注释行（注释里的历史说明不参与契约判定） */
function stripComments(content: string): string[] {
  return content.split(/\r?\n/).filter((line) => !/^\s*#/.test(line));
}

/** 提取顶层（0 缩进）键块：从 `key:` 到下一个 0 缩进行 */
function extractTopLevelBlock(lines: string[], key: string): string[] {
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start < 0) {
    return [];
  }
  const block: string[] = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) {
      break;
    }
    block.push(lines[i]);
  }
  return block;
}

/** 提取 job 块（恰好两级缩进的 `  name:` 到下一个同级键或顶层键） */
function extractJobBlock(lines: string[], jobName: string): string[] {
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start < 0) {
    return [];
  }
  const block: string[] = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i]) || /^  [^ ]/.test(lines[i])) {
      break;
    }
    block.push(lines[i]);
  }
  return block;
}

const lines = stripComments(ciYml);
const onBlock = extractTopLevelBlock(lines, "on");
const concurrencyBlock = extractTopLevelBlock(lines, "concurrency");
const verifyBlock = extractJobBlock(lines, "verify");
const e2eBlock = extractJobBlock(lines, "e2e");
const verifyText = verifyBlock.join("\n");
const e2eText = e2eBlock.join("\n");
const concurrencyText = concurrencyBlock.join("\n");

/** 顶层 jobs: 下声明的全部 job 名（恰好两级缩进） */
function declaredJobNames(): string[] {
  const inJobs = extractTopLevelBlock(lines, "jobs").slice(1);
  return inJobs
    .filter((line) => /^  [^ ]/.test(line))
    .map((line) => line.replace(/^  /, "").replace(/:.*$/, ""));
}

describe("CI 调度合同：OPT-A stale PR run cancellation（CI-OPT-01）", () => {
  it("workflow 级存在 concurrency 块，且未下沉到任何 job 内", () => {
    expect(concurrencyBlock.length).toBeGreaterThan(0);
    expect(concurrencyBlock[0]).toBe("concurrency:");
    // job 内不得再有 concurrency（避免 job 级覆盖破坏 master 语义）
    expect(verifyText).not.toMatch(/^\s*concurrency:/m);
    expect(e2eText).not.toMatch(/^\s*concurrency:/m);
  });

  it("group PR fallback = pull_request.number：同 PR successive HEAD 共享 group，stale 可取消（INV-CI-01）", () => {
    // 同一 PR 的 HEAD A / HEAD B 落入同一 group → push B 时 A 可被 cancel；
    // 不同 PR number 各自独立 group → PR #A / PR #B 互不取消
    expect(concurrencyText).toMatch(/group:.*github\.event\.pull_request\.number/);
  });

  it("group 非 PR fallback = github.run_id：master 每次 run 独立 group（INV-CI-02）", () => {
    // 同 group 且 cancel-in-progress=false 时，GitHub 默认每个 group 只保留
    // 一个 pending run——连续 master pushes 会用新 pending 替换旧 pending。
    // run_id 唯一 group 使 M1/M2/M3 互不干扰：既不 cancel running，
    // 也不 replace pending，每个 merge commit 保留 exact-master evidence。
    expect(concurrencyText).toMatch(/group:.*\|\|\s*github\.run_id/);
    // 禁止退回 github.ref fallback（R1 review blocker：ref 共享 group 的
    // pending replacement 会丢失旧 merge commit 的 post-merge evidence）
    expect(concurrencyText).not.toMatch(/\|\|\s*github\.ref\b/);
  });

  it("cancel-in-progress 仅对 pull_request 为真（running master run 不被取消）", () => {
    // 注意：这只是 master evidence 保护的必要条件之一（不 cancel running），
    // 不是充分条件——pending 保护由 github.run_id 唯一 group 提供（见上）。
    expect(concurrencyText).toMatch(
      /cancel-in-progress:\s*\$\{\{\s*github\.event_name\s*==\s*'pull_request'\s*\}\}/,
    );
    // 禁止无条件取消（会吞掉 master evidence）
    expect(lines.join("\n")).not.toMatch(/cancel-in-progress:\s*true/);
  });
});

describe("CI 调度合同：OPT-B verify / e2e 并行（CI-OPT-01）", () => {
  it("恰好声明 verify 与 e2e 两个 gate job（check name 冻结合同）", () => {
    expect(declaredJobNames()).toEqual(["verify", "e2e"]);
    expect(verifyBlock.length).toBeGreaterThan(0);
    expect(e2eBlock.length).toBeGreaterThan(0);
  });

  it("e2e 不再 needs: verify —— 两个 gate 相互独立并行（INV-CI-03）", () => {
    expect(e2eText).not.toMatch(/^\s*needs:/m);
    expect(verifyText).not.toMatch(/^\s*needs:/m);
  });

  it("两个 job 均自包含：runs-on + checkout + setup-node + npm ci", () => {
    for (const [jobName, text] of [
      ["verify", verifyText],
      ["e2e", e2eText],
    ] as const) {
      expect(text, jobName).toMatch(/runs-on:\s*ubuntu-latest/);
      expect(text, jobName).toMatch(/uses:\s*actions\/checkout@v4/);
      expect(text, jobName).toMatch(/uses:\s*actions\/setup-node@v4/);
      expect(text, jobName).toMatch(/run:\s*npm ci/);
    }
  });

  it("环境隔离审计：verify 用 campus 库，e2e 用专用 campus_e2e 库（各有独立 Redis）", () => {
    expect(verifyText).toMatch(/POSTGRES_DB:\s*campus$/m);
    expect(e2eText).toMatch(/POSTGRES_DB:\s*campus_e2e$/m);
    expect(verifyText).toMatch(/image:\s*redis:7-alpine/);
    expect(e2eText).toMatch(/image:\s*redis:7-alpine/);
  });
});

describe("CI 调度合同：required check name 冻结（CI-OPT-01）", () => {
  it("check name 精确匹配，防止 rename 使 branch protection required checks 失效（INV-CI-06）", () => {
    expect(verifyText).toContain(`name: ${CI_CHECK_NAMES.verify}`);
    expect(e2eText).toContain(`name: ${CI_CHECK_NAMES.e2e}`);
  });
});

describe("CI 调度合同：verify release gate 不变量（CI-OPT-01）", () => {
  it("保留全部原 release gate 步骤（INV-CI-04）", () => {
    expect(verifyText).toMatch(/run:\s*npm ci/);
    expect(verifyText).toMatch(/run:\s*npx prisma generate/);
    expect(verifyText).toMatch(/run:\s*npm run typecheck/);
    expect(verifyText).toMatch(/run:\s*npm run lint/);
    expect(verifyText).toMatch(/run:\s*npm run test:coverage/);
    expect(verifyText).toMatch(/run:\s*npm run build/);
  });

  it("migration idempotency proof：migrate deploy 恰好执行两次（fresh + 幂等重跑）", () => {
    const deployCount = verifyText.match(/npx prisma migrate deploy/g)?.length ?? 0;
    expect(deployCount).toBe(2);
    expect(verifyText).toContain("Deploy database migrations (fresh)");
    expect(verifyText).toContain("Deploy database migrations (idempotent re-run)");
  });

  it("verify 仍声明真实 PostgreSQL 服务容器", () => {
    expect(verifyText).toMatch(/image:\s*postgres:16-alpine/);
    expect(verifyText).toMatch(/pg_isready -U postgres -d campus/);
  });
});

describe("CI 调度合同：e2e release gate 不变量（CI-OPT-01）", () => {
  it("保留 setup / Playwright / teardown 全链路（INV-CI-05）", () => {
    expect(e2eText).toMatch(/run:\s*npm run e2e:setup/);
    expect(e2eText).toMatch(/run:\s*npx playwright test/);
    expect(e2eText).toMatch(/run:\s*npm run e2e:teardown/);
    expect(e2eText).toMatch(/run:\s*npx playwright install --with-deps chromium/);
  });

  it("仍使用 production build 与真实 MinIO（digest pin）", () => {
    expect(e2eText).toMatch(/run:\s*npm run build/);
    expect(e2eText).toMatch(/ghcr\.io\/ljjnb666-nb\/minio@sha256:[0-9a-f]{64}/);
    expect(e2eText).toMatch(/E2E_DATABASE_URL:.*campus_e2e/);
    expect(e2eText).toMatch(/E2E_REDIS_URL:.*localhost:6379/);
    expect(e2eText).toMatch(/E2E_S3_ENDPOINT:.*localhost:9100/);
  });

  it("teardown 恒执行（if: always()），失败工件仍上传（if: failure()）", () => {
    const teardownIdx = e2eBlock.findIndex((line) => line.includes("npm run e2e:teardown"));
    expect(teardownIdx).toBeGreaterThan(0);
    expect(e2eBlock[teardownIdx - 1]).toMatch(/if:\s*always\(\)/);
    expect(e2eText).toMatch(/if:\s*failure\(\)/);
    expect(e2eText).toMatch(/actions\/upload-artifact@v4/);
  });
});

describe("CI 调度合同：触发器与失败语义（CI-OPT-01）", () => {
  it("post-merge master 完整 CI 不变：push: master + 全部 pull_request（INV-CI-08）", () => {
    expect(onBlock.length).toBeGreaterThan(0);
    expect(onBlock.join("\n")).toMatch(/push:/);
    expect(onBlock.join("\n")).toMatch(/branches:\s*\[master\]/);
    expect(onBlock.join("\n")).toMatch(/pull_request:/);
    // 禁止 paths 过滤让 master evidence 静默缺失
    expect(lines.join("\n")).not.toMatch(/paths-ignore:/);
    expect(lines.join("\n")).not.toMatch(/paths:/);
  });

  it("gate 步骤禁止静默失败：无 continue-on-error / || true / allow-failure（INV-CI-07）", () => {
    expect(lines.join("\n")).not.toContain("continue-on-error");
    expect(lines.join("\n")).not.toContain("|| true");
    expect(lines.join("\n")).not.toContain("allow-failure");
  });
});
