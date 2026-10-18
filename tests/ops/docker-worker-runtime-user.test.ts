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

  it("keeps Prisma code generation in the build stage before cleanup runtime UID switch", () => {
    const stage = stages.get("cleanup-runner");
    expect(stage).toBeDefined();
    const generate = stage!.lines.findIndex((line) => line.includes("npx prisma generate"));
    const drop = stage!.lines.findIndex((line) => line === "USER node");
    expect(generate).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThan(generate);
  });
});
