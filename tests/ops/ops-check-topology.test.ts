import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// vitest 以仓库根为 cwd（npm run test）
const repoRoot = process.cwd();

/**
 * LAUNCH_REHEARSAL_REPAIR R1（P1-01）：生产 ops-check 执行合同静态 gate。
 *
 * 合同：生产 connectivity/backup 检查的唯一权威执行位置是 compose 的
 * one-shot `ops-check` 服务（compose 安全基线不发布 5432/6379/9000，
 * 宿主机不可作为 connectivity authority；常驻 worker 不应长期持有
 * backup 目录权限）。本 gate 防止该合同静默漂移：
 * - compose：ops-check 服务存在、profile=ops、无 ports、仅 backend、
 *   backup 只读挂载（long syntax read_only + create_host_path:false）、
 *   BACKUP_DIR=/backups 覆盖、restart "no"、command=--mode production、
 *   immutable GIT_SHA image tag、release 与数据层依赖健康
 * - Dockerfile：ops-runner stage 存在，FROM cleanup-runner（复用产物层），
 *   release identity bake 进镜像（ENV RELEASE_SHA=${GIT_SHA}）
 * - deploy.sh：release artifact set 不含 ops-check（诊断工件，不扩部署生命周期）
 * - 文档：唯一 canonical 生产命令存在（防止 runbook 漂移）
 */

const composeContent = readFileSync(path.join(repoRoot, "compose.production.yml"), "utf8");
const dockerfileContent = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const deploySh = readFileSync(path.join(repoRoot, "scripts", "ops", "deploy.sh"), "utf8");
const observabilityDoc = readFileSync(path.join(repoRoot, "docs", "OBSERVABILITY.md"), "utf8");
const incidentDoc = readFileSync(path.join(repoRoot, "docs", "INCIDENT_RESPONSE.md"), "utf8");
const alertingDoc = readFileSync(path.join(repoRoot, "docs", "ALERTING.md"), "utf8");

/** 唯一 canonical 生产命令（文档与本 gate 必须保持同一字符串） */
export const CANONICAL_OPS_CHECK_COMMAND =
  "GIT_SHA=$(git rev-parse HEAD) docker compose --env-file .env.production -f compose.production.yml --profile ops run --rm --build ops-check";

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
    if (/^\S/.test(lines[i]) || /^  [a-z][a-z0-9-]*:/.test(lines[i])) {
      break;
    }
    block.push(lines[i]);
  }
  return block;
}

describe("生产 ops-check 执行合同静态 gate（R1 P1-01）", () => {
  const block = extractServiceBlock(stripComments(composeContent), "ops-check");
  const text = block.join("\n");

  it("compose.production.yml 恰好声明一个 ops-check 服务", () => {
    const serviceDeclarations = stripComments(composeContent).filter(
      (line) => line === "  ops-check:",
    );
    expect(serviceDeclarations).toHaveLength(1);
    expect(block.length).toBeGreaterThan(0);
  });

  it("ops-check 是 ops profile 的一次性服务：无 ports、restart no、默认 up 不启动", () => {
    expect(text).toMatch(/profiles:\s*\["ops"\]/);
    expect(text).not.toMatch(/^\s*ports:/m);
    expect(text).toMatch(/restart:\s*"no"/);
  });

  it("ops-check 仅 backend 网络，依赖 postgres/redis 健康（不依赖 app）", () => {
    expect(text).toMatch(/-\s*backend/);
    expect(text).toMatch(/postgres:\n\s+condition:\s+service_healthy/);
    expect(text).toMatch(/redis:\n\s+condition:\s+service_healthy/);
    expect(text).not.toMatch(/app:\n\s+condition:/);
  });

  it("BACKUP_DIR 合同：宿主机目录只读挂载到 /backups，服务内覆盖 BACKUP_DIR=/backups", () => {
    // long syntax：source 来自宿主机 BACKUP_DIR 权威变量
    expect(text).toMatch(/source:\s*\$\{BACKUP_DIR:\?/);
    expect(text).toMatch(/target:\s*\/backups/);
    // 只读 + 不静默创建宿主目录（目录缺失必须显式报错，绝不挂空目录）
    expect(text).toMatch(/read_only:\s*true/);
    expect(text).toMatch(/create_host_path:\s*false/);
    // 容器内检查器读到的固定容器路径
    expect(text).toMatch(/BACKUP_DIR:\s*\/backups/);
    // 不得使用可写 short syntax 挂载（防漂移回可写形态；long syntax 中
    // target 行为 "target: /backups"，含空格，不会命中本断言）
    expect(text).not.toContain(":/backups");
  });

  it("release identity：immutable GIT_SHA tag + ops-runner target（bake RELEASE_SHA）", () => {
    expect(text).toMatch(/target:\s*ops-runner/);
    expect(text).toMatch(/campus-marketplace-ops-check:\$\{GIT_SHA:-local\}/);
    expect(text).toMatch(/GIT_SHA:\s*\$\{GIT_SHA:-unknown\}/);
    const stageIndex = dockerfileContent.indexOf("FROM cleanup-runner AS ops-runner");
    expect(stageIndex).toBeGreaterThan(-1);
    const stageBlock = dockerfileContent.slice(stageIndex);
    // release identity 必须 bake 进 artifact（禁止运行时伪装）
    expect(stageBlock).toMatch(/ARG GIT_SHA=unknown/);
    expect(stageBlock).toMatch(/ENV RELEASE_SHA=\$\{GIT_SHA\}/);
    expect(stageBlock).toMatch(/ENTRYPOINT \["npx", "tsx", "scripts\/ops\/ops-check\.ts"\]/);
  });

  it("ops-check 以 --mode production 为默认 command（mode fail-closed 契约入口）", () => {
    expect(text).toMatch(/command:\s*\["--mode",\s*"production"\]/);
  });

  it("ops-check 不进入 deploy release artifact set（诊断工件，不扩部署生命周期）", () => {
    expect(deploySh).toMatch(/compose_run build app migrate storage-cleanup/);
    expect(deploySh).not.toMatch(/ops-check/);
  });

  it("文档保持唯一 canonical 生产命令（OBSERVABILITY / INCIDENT_RESPONSE / ALERTING）", () => {
    for (const [name, doc] of [
      ["OBSERVABILITY.md", observabilityDoc],
      ["INCIDENT_RESPONSE.md", incidentDoc],
      ["ALERTING.md", alertingDoc],
    ] as const) {
      expect(doc, `${name} 必须包含 canonical 命令`).toContain(CANONICAL_OPS_CHECK_COMMAND);
    }
    // runbook 不得再把 host 直跑当作生产权威方式（仅 development/CI 语境保留）
    expect(observabilityDoc).toMatch(/唯一 canonical 生产命令/);
  });
});
