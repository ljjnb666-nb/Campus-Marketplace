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

  it("requires real nonroot AsyncJob/Outbox expired-lease and failclosed replay proof", () => {
    const script = readFileSync(
      path.join(process.cwd(), "scripts/ops/worker-isolated-cycle-proof.sh"), "utf8",
    );
    const original = readFileSync(
      path.join(process.cwd(), "tests/integration/phase9a-async-core.test.ts"), "utf8",
    );
    // Reuse proven semantic contract; don't invent another queue implementation.
    expect(original).toContain("FAILCLOSED-01");
    expect(original).toContain("OUTBOX-FAILCLOSED-01");
    expect(original).toContain("J-LEASE-01");
    expect(script).toContain('INSERT INTO "AsyncJob"');
    expect(script).toContain('INSERT INTO "OutboxEvent"');
    expect(script).toContain("'RUNNING'");
    expect(script).toContain("'PROCESSING'");
    expect(script).toContain("proof-stale-job-token");
    expect(script).toContain("proof-stale-event-token");
    expect(script).toContain("ASYNC_JOB_KIND_OR_SCHEMA_VERSION_UNKNOWN");
    expect(script).toContain("OUTBOX_EVENT_TYPE_OR_SCHEMA_VERSION_UNKNOWN");
    expect(script).toContain("async-fixtures");
    expect(script).toContain("async-replay");
    expect(script).toContain('if [[ "$first_snapshot" != 4 ]]');
    expect(script).toContain('if [[ "$(r1c_snapshot)" != 4 ]]');
  });

  it("exercises a valid reservation expiry and real Outbox notification exactly-once in image", () => {
    const sql = readFileSync(
      path.join(process.cwd(), "scripts/ops/worker-isolated-cycle-proof.sh"), "utf8",
    );
    const source = readFileSync(
      path.join(process.cwd(), "tests/integration/phase9a-async-core.test.ts"), "utf8",
    );
    expect(source).toContain("WORKER-INT-01");
    expect(sql).toContain("'PRODUCT_RESERVATION_EXPIRE'");
    expect(sql).toContain("'PRODUCT_RESERVATION_EXPIRE:proof-order'");
    expect(sql).toContain("'PRODUCT_RESERVATION_EXPIRED:proof-order'");
    expect(sql).toContain("'proof-buyer'");
    expect(sql).toContain("'proof-seller'");
    expect(sql).toContain("valid_order_snapshot");
    expect(sql).toContain("EmailRuntimeConfigUnavailableError");
    expect(sql).toContain('worker_env+=(-e EMAIL_PROVIDER=disabled)');
    expect(sql).toContain("valid-expiry-recovery");
    expect(sql).toContain("PROVIDER_DISABLED");
    expect(sql).toContain("NOTIFICATION_DELIVERY");
    expect(sql).toContain("zero premature notification");
    expect(sql).toContain("no send jobs");
    expect(sql).toContain("run_worker valid-expiry");
    expect(sql).toContain("run_worker valid-expiry-replay");
    expect(sql).toContain('if [[ "$(valid_order_snapshot)" != 5 ]]');
    expect(sql).toContain("COUNT(DISTINCT");
    expect(sql).toContain("'PUBLISHED'");
    expect(sql).toContain("'COMPLETED'");
  });

  it("requires two real simultaneously launched nonroot worker containers and single durable effects", () => {
    const script = readFileSync(
      path.join(process.cwd(), "scripts/ops/worker-isolated-cycle-proof.sh"), "utf8",
    );
    const existing = readFileSync(
      path.join(process.cwd(), "tests/integration/phase9a-async-core.test.ts"), "utf8",
    );
    expect(existing).toContain("J-LEASE-02");
    expect(existing).toContain("OUTBOX-RACE-01");
    expect(existing).toContain("CRASH-REPLAY-01");
    expect(script).toContain('parallel_pid_a=$!');
    expect(script).toContain('parallel_pid_b=$!');
    expect(script).toContain('wait "$parallel_pid_a"');
    expect(script).toContain('wait "$parallel_pid_b"');
    expect(script).toContain('--name "$parallel_one"');
    expect(script).toContain('--name "$parallel_two"');
    expect(script).toContain('docker rm -f "$parallel_one" "$parallel_two"');
    expect(script).toContain("parallel_snapshot");
    expect(script).toContain("'proof-parallel-order'");
    expect(script).toContain('"attempts"=1');
    expect(script).toContain("'PUBLISHED'");
    expect(script).toContain("'PROVIDER_DISABLED'");
    expect(script).toContain("COUNT(DISTINCT");
    expect(script).toContain('if [[ "$(parallel_snapshot)" != 6 ]]');
    expect(script).toContain("run_worker parallel-replay");
  });

  it("keeps Prisma code generation in the build stage before cleanup runtime UID switch", () => {
    const stage = stages.get("cleanup-runner");
    expect(stage).toBeDefined();
    const generate = stage!.lines.findIndex((line) => line.includes("npx prisma generate"));
    const drop = stage!.lines.findIndex((line) => line === "USER node");
    expect(generate).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThan(generate);
  });
  it("enforces R1F real-image old-token execution fencing and bounded forced crash", () => {
    const cycle = readFileSync(path.join(process.cwd(), "scripts/ops/worker-isolated-cycle-proof.sh"), "utf8");
    const ext = readFileSync(path.join(process.cwd(), "scripts/ops/worker-lease-fencing-extension.sh"), "utf8");
    const harness = readFileSync(path.join(process.cwd(), "scripts/ops/worker-lease-fencing-proof.ts"), "utf8");
    const workflow = readFileSync(path.join(process.cwd(), ".github/workflows/worker-image-runtime.yml"), "utf8");
    const original = readFileSync(path.join(process.cwd(), "tests/integration/phase9a-async-core.test.ts"), "utf8");
    expect(cycle).toContain("source scripts/ops/worker-lease-fencing-extension.sh");
    expect(workflow).toContain("scripts/ops/worker-lease-fencing-extension.sh");
    expect(workflow).toContain("scripts/ops/worker-lease-fencing-proof.ts");
    const dockerignore = readFileSync(path.join(process.cwd(), ".dockerignore"), "utf8");
    expect(dockerignore).toMatch(/^scripts\/ops\/worker-lease-fencing-extension[.]sh$/m);
    expect(dockerignore).toMatch(/^scripts\/ops\/worker-lease-fencing-proof[.]ts$/m);
    expect(workflow).toContain("- .dockerignore");
    const imageProof = readFileSync(path.join(process.cwd(), "scripts/ops/worker-image-runtime-proof.sh"), "utf8");
    expect(imageProof).toContain("test-only crash probe leaked into runtime image");
    expect(imageProof).toContain("fs.existsSync(proofPath)");
    for (const contract of ["J-LEASE-02", "J-LEASE-03", "OUTBOX-RACE-01", "CRASH-REPLAY-01"]) {
      expect(original).toContain(contract);
    }
    expect(ext).toContain("--read-only");
    expect(ext).toContain("--cap-drop ALL --security-opt no-new-privileges");
    expect(ext).toContain("--mount");
    expect(ext).toContain("readonly");
    expect(ext).toContain('r1f_probe crash-b 77');
    expect(ext).toContain("PROOF_CRASH_AFTER_DOMAIN_COMMIT");
    expect(ext).toContain('r1f_probe stale-a 0');
    expect(ext).toContain('r1f_probe outbox-stale-a 0');
    expect(ext).toContain("run_worker fence-crash-replay");
    expect(ext).toContain("run_worker fence-terminal-replay");
    expect(ext).toContain("attempts=3");
    expect(ext).toContain("leaseExpiresAt");
    expect(ext).not.toContain("UPDATE \"AsyncJob\" SET status=");
    expect(ext).not.toContain("UPDATE \"OutboxEvent\" SET status=");
    expect(harness).toContain("claimDueAsyncJobs(tx,");
    expect(harness).toContain("executeClaimedAsyncJob({");
    expect(harness).toContain("completeAsyncJob(prisma,");
    expect(harness).toContain("beginOutboxMaterializeTx(tx,");
    expect(harness).toContain("publishOutboxEventTx(tx,");
    expect(harness).toContain("afterJobTxCommit:");
    expect(harness).toContain("process.exit(77)");
    expect(harness).toContain("STALE_ZERO_DOMAIN_SIDE_EFFECTS");
    expect(harness).not.toContain("console.error(error");
  });

  it("enforces R1G deterministic nonroot held-row claim contention on BOTH queue tables", () => {
    const cycle = readFileSync(path.join(process.cwd(), "scripts/ops/worker-isolated-cycle-proof.sh"), "utf8");
    const ext = readFileSync(path.join(process.cwd(), "scripts/ops/worker-lock-contention-extension.sh"), "utf8");
    const harness = readFileSync(path.join(process.cwd(), "scripts/ops/worker-lock-contention-proof.ts"), "utf8");
    const workflow = readFileSync(path.join(process.cwd(), ".github/workflows/worker-image-runtime.yml"), "utf8");
    const dockerignore = readFileSync(path.join(process.cwd(), ".dockerignore"), "utf8");
    const imageProof = readFileSync(path.join(process.cwd(), "scripts/ops/worker-image-runtime-proof.sh"), "utf8");

    expect(cycle).toContain("source scripts/ops/worker-lock-contention-extension.sh");
    expect(cycle.indexOf("source scripts/ops/worker-lock-contention-extension.sh"))
      .toBeGreaterThan(cycle.indexOf("source scripts/ops/worker-lease-fencing-extension.sh"));
    expect(cycle.indexOf("source scripts/ops/worker-lock-contention-extension.sh"))
      .toBeLessThan(cycle.indexOf("# Fail-closed negative gate"));
    for (const name of ["worker-lock-contention-proof.ts", "worker-lock-contention-extension.sh"]) {
      expect(workflow).toContain("scripts/ops/" + name);
      expect(dockerignore).toContain("scripts/ops/" + name);
      expect(imageProof).toContain("/app/scripts/ops/" + name);
    }
    expect(ext).toContain("for lane in job outbox");
    expect(ext).toContain('r1g_container "$r1g_holder_name" "hold-$lane"');
    expect(ext).toContain('r1g_container "$r1g_challenger_name" "compete-$lane"');
    expect(ext).toContain("PROOF_R1G_LOCK_HELD");
    expect(ext).toContain("PROOF_R1G_SKIP_LOCKED");
    expect(ext).toContain("PROOF_R1G_LEASE_STABLE");
    expect(ext).toContain("touch \"$tmp/proof-r1g-sync/release-$lane\"");
    expect(ext).toContain("--read-only");
    expect(ext).toContain("--cap-drop ALL --security-opt no-new-privileges");
    expect(ext).toContain("--mount");
    expect(ext).toContain("readonly");
    expect(ext).toContain('wait "$r1g_holder_pid"');
    expect(ext).toContain("dirty lock-state");
    expect(ext).not.toContain('UPDATE "AsyncJob"');
    expect(ext).not.toContain('UPDATE "OutboxEvent"');
    expect(harness).toContain("claimDueAsyncJobs(tx,");
    expect(harness).toContain("claimDueOutboxEvents(tx,");
    expect(harness).toContain("withTransaction(async (tx) =>");
    expect(harness).toContain('marker("LOCK_HELD")');
    expect(harness).toContain('marker("SKIP_LOCKED")');
    expect(harness).toContain('marker("LEASE_STABLE")');
    expect(harness).toContain("UNCOMMITTED_STATE");
    expect(harness).toContain("COMMITTED_LEASE_STABLE");
    expect(harness).toContain("RELEASE_TIMEOUT");
    expect(harness).not.toContain("console.error(error");
  });

  it("R2 prunes only unused Prisma CLI/config/merge AFTER codegen and before nonroot execution", () => {
    const cleanup = stages.get("cleanup-runner");
    const asyncRunner = stages.get("async-runner");
    const ops = stages.get("ops-runner");
    expect(cleanup).toBeDefined();
    expect(asyncRunner).toBeDefined();
    expect(ops).toBeDefined();
    const lines = cleanup!.lines;
    const generated = lines.findIndex((line) => line.includes("npx prisma generate"));
    const remove = lines.findIndex((line) =>
      line.includes("rm -rf node_modules/prisma node_modules/@prisma/config node_modules/deepmerge-ts"),
    );
    const user = lines.findIndex((line) => line === "USER node");
    expect(generated).toBeGreaterThanOrEqual(0);
    expect(remove).toBeGreaterThan(generated);
    expect(user).toBeGreaterThan(remove);
    expect(dockerfile).toContain("test -d node_modules/.prisma/client");
    expect(dockerfile).toContain("test ! -e node_modules/@prisma/config");
    expect(dockerfile).toContain("test ! -e node_modules/deepmerge-ts");
    expect(asyncRunner?.effectiveUser).toBe("node");
    expect(ops?.effectiveUser).toBe("root");
    for (const dir of ["prisma", "@prisma/config", "deepmerge-ts"]) {
      expect(ops!.lines).toContain(
        "COPY --from=deps /app/node_modules/" + dir + " ./node_modules/" + dir,
      );
    }
    const imageProof = readFileSync(
      path.join(process.cwd(), "scripts/ops/worker-image-runtime-proof.sh"), "utf8",
    );
    expect(imageProof).toContain("unused Prisma CLI dependency in worker runtime");
    expect(imageProof).toContain("/app/node_modules/.prisma/client");
    for (const dir of ["prisma", "@prisma/config", "deepmerge-ts"]) {
      expect(imageProof).toContain("/app/node_modules/" + dir);
    }
  });

  it("R2 locked dependency graph confirms only Prisma CLI references config and only config references deepmerge", () => {
    const lock = JSON.parse(readFileSync(path.join(process.cwd(), "package-lock.json"), "utf8")) as {
      packages: Record<string, {
        version?: string;
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      }>;
    };
    const packages = lock.packages;
    expect(packages["node_modules/prisma"]?.version).toBe("6.19.3");
    expect(packages["node_modules/@prisma/config"]?.version).toBe("6.19.3");
    expect(packages["node_modules/deepmerge-ts"]?.version).toBe("7.1.5");
    expect(packages["node_modules/@prisma/client"]?.version).toBe("6.19.3");
    const consumers = (dependency: string) => Object.entries(packages)
      .filter(([name, pkg]) => name !== "" &&
        (pkg.dependencies?.[dependency] || pkg.optionalDependencies?.[dependency]))
      .map(([name]) => name)
      .sort();
    expect(consumers("@prisma/config")).toEqual(["node_modules/prisma"]);
    expect(consumers("deepmerge-ts")).toEqual(["node_modules/@prisma/config"]);
    // Never strip the client, its generated code, engine, or tsx runtime.
    expect(packages["node_modules/tsx"]?.dependencies?.esbuild).toBeDefined();
    expect(dockerfile).not.toContain("rm -rf node_modules/@prisma/client");
    expect(dockerfile).not.toContain("rm -rf node_modules/.prisma");
    expect(dockerfile).not.toContain("rm -rf node_modules/tsx");
  });

  it("requires actual R2B ops-runner build, isolated root-only backup and failclosed diagnostic checks", () => {
    const workflow = readFileSync(
      path.join(process.cwd(), ".github/workflows/worker-image-runtime.yml"), "utf8",
    );
    const cycle = readFileSync(
      path.join(process.cwd(), "scripts/ops/worker-isolated-cycle-proof.sh"), "utf8",
    );
    const ext = readFileSync(
      path.join(process.cwd(), "scripts/ops/ops-runner-isolated-extension.sh"), "utf8",
    );
    const dockerignore = readFileSync(path.join(process.cwd(), ".dockerignore"), "utf8");
    const imageProof = readFileSync(
      path.join(process.cwd(), "scripts/ops/worker-image-runtime-proof.sh"), "utf8",
    );
    expect(workflow).toContain("scripts/ops/ops-runner-isolated-extension.sh");
    expect(workflow).toContain("--target ops-runner");
    expect(workflow).toContain("campus-marketplace-ops-check:${SOURCE_SHA}");
    expect(cycle).toContain("source scripts/ops/ops-runner-isolated-extension.sh");
    expect(cycle.indexOf("source scripts/ops/ops-runner-isolated-extension.sh"))
      .toBeGreaterThan(cycle.indexOf("source scripts/ops/worker-lock-contention-extension.sh"));
    expect(dockerignore).toMatch(/^scripts\/ops\/ops-runner-isolated-extension\.sh$/m);
    expect(imageProof).toContain("/app/scripts/ops/ops-runner-isolated-extension.sh");
    expect(ext).toContain('ops_image="campus-marketplace-ops-check:$sha"');
    expect(ext).toContain('docker exec "$pg" pg_dump');
    expect(ext).toContain("sha256sum");
    expect(ext).toContain("--read-only");
    expect(ext).toContain("readonly");
    expect(ext).toContain("--cap-drop ALL --security-opt no-new-privileges");
    expect(ext).toContain('sudo chown -R root:root "$ops_backups"');
    expect(ext).toContain("--user 1000:1000");
    expect(ext).toContain('ops_expect healthy-ci 0 PASS pass NONE --mode ci');
    expect(ext).toContain('ops_expect invalid-mode 1 FAIL NONE INVALID_OPS_MODE');
    expect(ext).toContain("PRODUCTION_CONNECTIVITY_CANNOT_BE_SKIPPED");
    expect(ext).toContain('ops_expect corrupt-prod 1 FAIL fail backup_health --mode production');
    expect(ext).toContain('ops_before_meta');
    expect(ext).toContain('ops_after_status');
    expect(ext).not.toContain(".env.production");
  });

});
