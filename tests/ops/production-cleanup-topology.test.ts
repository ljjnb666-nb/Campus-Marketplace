import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// vitest 以仓库根为 cwd（npm run test）
const repoRoot = process.cwd();

/**
 * LR-071 审计修复：生产 cleanup worker 拓扑静态 gate。
 *
 * 验证 compose.production.yml 的 storage-cleanup 服务满足生产契约：
 * - 恰好一个清理服务（单实例语义，compose 默认 scale=1）
 * - 仅 backend 网络、无任何 ports 发布
 * - 使用生产 env（.env.production）与生产 restart policy
 * - 入口为 cleanup-runner target 的清理 worker entrypoint
 * - 周期配置存在且有下限保护（ASSET_CLEANUP_INTERVAL_SECONDS）
 *
 * 同时验证 Dockerfile 存在专用 cleanup-runner target 且 entrypoint 指向
 * 清理 worker。解析采用与 image-immutability gate 相同的行级方式
 * （不引入 YAML 依赖）。
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

describe("生产 cleanup worker 拓扑 gate（LR-071 OPS recovery）", () => {
  it("compose.production.yml 恰好声明一个 storage-cleanup 服务", () => {
    const serviceDeclarations = stripComments(composeContent).filter(
      (line) => line === "  storage-cleanup:",
    );
    expect(serviceDeclarations).toHaveLength(1);
  });

  it("storage-cleanup 服务：无端口发布、仅 backend 网络、生产 env、restart policy", () => {
    const block = extractServiceBlock(stripComments(composeContent), "storage-cleanup");
    const text = block.join("\n");

    expect(block.length).toBeGreaterThan(0);

    // build 自专用 cleanup-runner target（实际构建验证见本地 docker build 证据）
    expect(text).toMatch(/target:\s*cleanup-runner/);
    // 生产 env 文件 + NODE_ENV=production
    expect(text).toMatch(/env_file:\s*\.env\.production/);
    expect(text).toMatch(/NODE_ENV:\s*production/);
    // restart policy（service-defaults 锚点提供 restart: unless-stopped）
    expect(text).toMatch(/\*service-defaults/);
    // 仅 backend 网络、无 ports 发布
    expect(text).toMatch(/-\s*backend/);
    expect(text).not.toMatch(/^\s*ports:/m);
    // 依赖 postgres 健康（不依赖 app：cleanup 与接流量能力解耦）
    expect(text).toMatch(/postgres:\n\s+condition:\s+service_healthy/);
    // 不得出现在任何 profile 之后被禁用（必须是默认启动的常驻服务）
    expect(text).not.toMatch(/profiles:/);
  });

  it("storage-cleanup 周期配置存在且有下限保护（防 1s 风暴）", () => {
    const block = extractServiceBlock(stripComments(composeContent), "storage-cleanup");
    const text = block.join("\n");
    expect(text).toMatch(/ASSET_CLEANUP_INTERVAL_SECONDS:\s*\$\{ASSET_CLEANUP_INTERVAL_SECONDS:-1800\}/);

    // worker 源码强制生产下限
    const worker = readFileSync(
      path.join(repoRoot, "scripts", "ops", "storage-cleanup-worker.ts"),
      "utf8",
    );
    expect(worker).toMatch(/MIN_PRODUCTION_INTERVAL_SECONDS = 60/);
    expect(worker).toMatch(/NODE_ENV === "production"/);
  });

  it("Dockerfile 存在 cleanup-runner target，entrypoint 指向清理 worker", () => {
    expect(dockerfileContent).toMatch(/FROM node:\$\{NODE_VERSION\}-bookworm-slim AS cleanup-runner/);
    expect(dockerfileContent).toMatch(
      /ENTRYPOINT \["npx", "tsx", "scripts\/ops\/storage-cleanup-worker\.ts"\]/,
    );
    // prisma client 在镜像内生成（运行期不依赖宿主生成产物）
    const targetIndex = dockerfileContent.indexOf("AS cleanup-runner");
    const targetBlock = dockerfileContent.slice(targetIndex);
    expect(targetBlock).toMatch(/npx prisma generate/);
  });

  it("cleanup worker 不应成为 /api/ready 依赖（readiness 解耦）", () => {
    // dependency-health 的依赖枚举固定为 database/redis/storage
    const health = readFileSync(
      path.join(repoRoot, "src", "lib", "dependency-health.ts"),
      "utf8",
    );
    expect(health).toMatch(/"database" \| "redis" \| "storage"/);
    expect(health).not.toMatch(/storage-cleanup|cleanup-worker/i);
  });
});
