import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8");

type Stage = { effectiveUser: string; lines: string[] };

/**
 * Docker inherits USER when FROM refers to an earlier stage. A simple
 * Dockerfile-wide `toContain("USER node")` would incorrectly pass even if
 * async-runner reset itself to root after inheriting cleanup-runner.
 */
function parseStageUsers(source: string): Map<string, Stage> {
  const stages = new Map<string, Stage>();
  let current: Stage | null = null;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    const from = /^FROM\s+(\S+)\s+AS\s+([a-z0-9-]+)$/i.exec(line);
    if (from) {
      current = {
        effectiveUser: stages.get(from[1])?.effectiveUser ?? "root",
        lines: [],
      };
      stages.set(from[2], current);
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    const user = /^USER\s+([^\s#]+)/i.exec(line);
    if (user) current.effectiveUser = user[1];
  }
  return stages;
}

describe("Issue #157 persistent worker runtime UID contract (Dockerfile stage inheritance)", () => {
  const stages = parseStageUsers(dockerfile);

  it("runs both persistent database-writing workers as node, not image-default root", () => {
    expect(stages.get("cleanup-runner")?.effectiveUser).toBe("node");
    expect(stages.get("async-runner")?.effectiveUser).toBe("node");
    // Web runner is independently least-privilege and must not regress.
    expect(stages.get("runner")?.effectiveUser).toBe("node");
  });

  it("keeps the one-shot migrator and backup diagnostics at their existing UID", () => {
    // This slice deliberately does not change permissions to read host backup
    // mounts or to run schema migrations. Those need separate real-image proof.
    expect(stages.get("migrator")?.effectiveUser).toBe("root");
    expect(stages.get("ops-runner")?.effectiveUser).toBe("root");
  });

  it("creates both immutable release identity files before dropping privileges", () => {
    for (const name of ["cleanup-runner", "async-runner"]) {
      const stage = stages.get(name);
      expect(stage, name).toBeDefined();
      const lines = stage!.lines;
      const write = lines.findIndex((line) =>
        line.startsWith("RUN printf") && line.includes('> /app/.release-sha'),
      );
      const drop = lines.findIndex((line) => line === "USER node");
      const entrypoint = lines.findIndex((line) => line.startsWith("ENTRYPOINT"));
      expect(write, name).toBeGreaterThanOrEqual(0);
      expect(drop, name).toBeGreaterThan(write);
      expect(entrypoint, name).toBeGreaterThan(drop);
      expect(lines[entrypoint]).toContain("$(cat /app/.release-sha)");
      expect(lines[entrypoint]).toContain("export RELEASE_SHA");
    }
  });

  it("gives tsx only a bounded private /tmp while keeping the proof root filesystem readonly", () => {
    const proof = readFileSync(
      path.join(process.cwd(), "scripts/ops/worker-image-runtime-proof.sh"),
      "utf8",
    );
    expect(proof).toContain("--network none --read-only --cap-drop ALL");
    expect(proof).toContain("--tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=32m");
    expect(proof).toContain("--entrypoint node \"$image\" node_modules/tsx/dist/cli.mjs --version");
  });

  it("verifies isolated PostgreSQL/MinIO worker cycles are mandatory in the image workflow", () => {
    const ci = readFileSync(path.join(process.cwd(), ".github/workflows/worker-image-runtime.yml"), "utf8");
    const script = readFileSync(path.join(process.cwd(), "scripts/ops/worker-isolated-cycle-proof.sh"), "utf8");
    expect(ci).toContain("packages: read");
    expect(ci).toContain("worker-isolated-cycle-proof.sh");
    expect(ci).toContain("Real PostgreSQL MinIO worker run-once and refused-DB proof");
    expect(script).toContain("docker network create");
    expect(script).toContain("postgres:16-alpine");
    expect(script).toContain("for pass in 1 2");
    expect(script).toContain("campus-marketplace-migrator:");
    expect(script).toContain("run_worker cleanup-dry");
    expect(script).toContain("run_worker cleanup-write");
    expect(script).toContain("run_worker async-idle");
  });

  it("matches the exact existing CI MinIO and mc sha256 pins without truncation", () => {
    const ci = readFileSync(path.join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    const script = readFileSync(path.join(process.cwd(), "scripts/ops/worker-isolated-cycle-proof.sh"), "utf8");
    for (const name of ["minio", "mc"]) {
      const ref = ci.match(new RegExp("ghcr[.]io/ljjnb666-nb/" + name + "@sha256:([0-9a-f]+)"))?.[0];
      expect(ref).toBeDefined();
      expect(ref!.split("@sha256:")[1]).toHaveLength(64);
      expect(script).toContain(ref);
    }
    expect(script).toContain("invalid pinned image digest");
  });

  it("rejects colliding resources and failed-DB timeouts instead of faking green", () => {
    const script = readFileSync(path.join(process.cwd(), "scripts/ops/worker-isolated-cycle-proof.sh"), "utf8");
    expect(script).toContain("GITHUB_RUN_ID");
    expect(script).toContain("refusing container collision");
    expect(script).toContain("refusing network collision");
    expect(script).not.toContain(".env.production");
    expect(script).toContain("synthetic-pg-only");
    expect(script).toContain("synthetic-s3-only");
    expect(script).toContain("negative_rc");
    expect(script).toContain("-eq 124");
    expect(script).toContain("storage_cleanup_cycle_failed");
    // Refusal can fail fast at Prisma's production module-init $connect()
    // before the cleanup worker cycle catches the error.
    const prismaSource = readFileSync(path.join(process.cwd(), "src/lib/prisma.ts"), "utf8");
    expect(prismaSource).toContain('console.error("[prisma] 启动连接失败:"');
    expect(prismaSource).toContain("process.exit(1)");
    expect(script).toContain("prisma_startup=0");
    expect(script).toContain("prisma_startup=1");
    expect(script).toContain("[prisma] 启动连接失败:");

    expect(script).toContain("NEG_EVENT name=%s observed=%s");
    expect(script).toContain("NEG_CATEGORY token=%s observed=%s");
    expect(script).toContain("NEG_COUNTS lines=%s bytes=%s");
    expect(script).toContain("NEG_SHAPE kind=");
    expect(script).toContain("SAFE_LOG_SHAPE");
    expect(script).toContain('if (item.level === "error") counts.jsonError++');
    expect(script).toContain("counts.npmError++");
    expect(script).toContain("phase9_retention_cycle_failed");
    expect(script).toContain("retention_failed");
    expect(script).toContain('"$started" -ne 1');
    expect(script).toContain("trap cleanup EXIT");
  });

  it("keeps Prisma code generation in the build stage before cleanup runtime UID switch", () => {
    const stage = stages.get("cleanup-runner");
    expect(stage).toBeDefined();
    const generate = stage!.lines.findIndex((line) => line.includes("npx prisma generate"));
    const drop = stage!.lines.findIndex((line) => line === "USER node");
    expect(generate).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThan(generate);
  });
});
