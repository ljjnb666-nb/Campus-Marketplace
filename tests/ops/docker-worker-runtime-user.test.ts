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

  it("executes real isolated Postgres/MinIO worker cycles and idempotent migration", () => {
    const ci = readFileSync(path.join(process.cwd(), ".github/workflows/worker-image-runtime.yml"), "utf8");
    const proof = readFileSync(path.join(process.cwd(), "scripts/ops/worker-isolated-cycle-proof.sh"), "utf8");
    expect(ci).toContain("packages: read");
    expect(ci).toContain("worker-isolated-cycle-proof.sh");
    expect(ci).toContain("Real PostgreSQL MinIO worker run-once and refused-DB proof");
    expect(proof).toContain("docker network create");
    expect(proof).toContain("postgres:16-alpine");
    expect(proof).toContain("minio@sha256:");
    expect(proof).toContain("migrate deploy");
    expect(proof).toContain("for pass in 1 2");
    expect(proof).toContain('run_worker cleanup-dry');
    expect(proof).toContain('run_worker cleanup-write');
    expect(proof).toContain('run_worker async-idle');
  });

  it("uses the same complete 64-hex pinned MinIO and mc image digests as existing CI", () => {
    const baseline = readFileSync(path.join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    const proof = readFileSync(path.join(process.cwd(), "scripts/ops/worker-isolated-cycle-proof.sh"), "utf8");
    for (const name of ["minio", "mc"]) {
      const refs = [...baseline.matchAll(
        new RegExp("ghcr\\.io/ljjnb666-nb/" + name + "@sha256:[a-f0-9]+", "g"),
      )].map((match) => match[0]);
      expect(refs.length).toBeGreaterThan(0);
      expect(refs[0].split("@sha256:")[1]).toHaveLength(64);
      expect(refs.every((ref) => ref === refs[0])).toBe(true);
      expect(proof).toContain(refs[0]);
    }
    expect(proof).toContain('invalid pinned image digest');
    expect(proof).toContain('@sha256:[0-9a-f]{64}
    const proof = readFileSync(path.join(process.cwd(), "scripts/ops/worker-isolated-cycle-proof.sh"), "utf8");
    expect(proof).toContain("GITHUB_RUN_ID");
    expect(proof).toContain("refusing container collision");
    expect(proof).toContain("refusing network collision");
    expect(proof).not.toContain(".env.production");
    expect(proof).toContain("synthetic-pg-only");
    expect(proof).toContain("synthetic-s3-only");
    expect(proof).toContain('negative_rc');
    expect(proof).toContain('"$negative_rc" -eq 124');
    expect(proof).toContain('storage_cleanup_cycle_failed');
    expect(proof).toContain("trap cleanup EXIT");
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
);
  });

  it("refuses production dependencies, collisions and a timed-out negative gate", () => {
    const proof = readFileSync(path.join(process.cwd(), "scripts/ops/worker-isolated-cycle-proof.sh"), "utf8");
    expect(proof).toContain("GITHUB_RUN_ID");
    expect(proof).toContain("refusing container collision");
    expect(proof).toContain("refusing network collision");
    expect(proof).not.toContain(".env.production");
    expect(proof).toContain("synthetic-pg-only");
    expect(proof).toContain("synthetic-s3-only");
    expect(proof).toContain('negative_rc');
    expect(proof).toContain('"$negative_rc" -eq 124');
    expect(proof).toContain('storage_cleanup_cycle_failed');
    expect(proof).toContain("trap cleanup EXIT");
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
