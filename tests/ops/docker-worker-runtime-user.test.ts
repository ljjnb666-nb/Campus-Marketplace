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
    expect(ext).toContain('process.env.RELEASE_SHA !== process.env.EXPECTED_SHA');
    expect(ext).not.toContain('-e RELEASE_SHA=');
    expect(ext).toContain('docker exec "$pg" pg_dump');
    expect(ext).toContain("sha256sum");
    expect(ext).toContain("--read-only");
    expect(ext).toContain("readonly");
    expect(ext).toContain("--cap-drop ALL --security-opt no-new-privileges");
    expect(ext).toContain('sudo chown -R root:root "$ops_backups"');
    expect(ext).toContain("--user 1000:1000");
    expect(ext).toContain("PROOF_R2B_EACCES");
    expect(ext).toContain("PROOF_R2B_EROFS");
    expect(ext).toContain('ops_nonroot_rc" == 77');
    expect(ext).toContain('ops_write_rc" == 78');
    expect(ext).toContain('ops_expect healthy-ci 0 PASS pass NONE --mode ci');
    expect(ext).toContain('ops_expect invalid-mode 1 FAIL NONE INVALID_OPS_MODE');
    expect(ext).toContain("PRODUCTION_CONNECTIVITY_CANNOT_BE_SKIPPED");
    expect(ext).toContain('ops_expect corrupt-prod 1 FAIL fail backup_health --mode production');
    expect(ext).toContain('ops_before_meta');
    expect(ext).toContain('ops_after_status');
    expect(ext).not.toContain(".env.production");
  });

  it("R3A Prisma7 CLI experiment is isolated from release images and fails closed on drift", () => {
    const ext = readFileSync(
      path.join(process.cwd(), "scripts/ops/prisma7-cli-shadow-extension.sh"), "utf8",
    );
    const workflow = readFileSync(
      path.join(process.cwd(), ".github/workflows/worker-image-runtime.yml"), "utf8",
    );
    const cycle = readFileSync(
      path.join(process.cwd(), "scripts/ops/worker-isolated-cycle-proof.sh"), "utf8",
    );
    const dockerignore = readFileSync(path.join(process.cwd(), ".dockerignore"), "utf8");
    const imageProof = readFileSync(
      path.join(process.cwd(), "scripts/ops/worker-image-runtime-proof.sh"), "utf8",
    );
    expect(workflow).toContain("scripts/ops/prisma7-cli-shadow-extension.sh");
    expect(cycle).toContain("source scripts/ops/prisma7-cli-shadow-extension.sh");
    expect(cycle.indexOf("source scripts/ops/prisma7-cli-shadow-extension.sh"))
      .toBeGreaterThan(cycle.indexOf("source scripts/ops/ops-runner-isolated-extension.sh"));
    expect(dockerignore).toMatch(/^scripts\/ops\/prisma7-cli-shadow-extension\.sh$/m);
    expect(imageProof).toContain("/app/scripts/ops/prisma7-cli-shadow-extension.sh");
    expect(ext).toContain("prisma@7.10.1");
    expect(ext).toContain("--network bridge --read-only --cap-drop ALL");
    expect(ext).toContain('--user "$(id -u):$(id -g)"');
    expect(ext).toContain('--mount "type=bind,src=$sandbox,dst=/shadow"');
    expect(ext).toContain('--workdir /shadow -e HOME=/tmp');
    expect(ext).toContain('--tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=512m');
    expect(ext).toContain('npm_config_cache=/shadow/.npm-cache');
    expect(ext).toContain('rm -rf "$sandbox/.npm-cache"');
    expect(ext).toContain('diskFull: /ENOSPC/i');
    expect(ext).toContain('--entrypoint npm "campus-marketplace-migrator:$sha"');
    expect(ext).not.toContain('timeout 180s npm install');
    expect(ext).not.toContain("-e GITHUB_TOKEN=");

    expect(ext).toContain('pkg.version !== "7.10.1"');
    expect(ext).toContain('shadow_db="proof_prisma7_${GITHUB_RUN_ID}"');
    expect(ext).toContain('cp prisma/schema.prisma "$sandbox/prisma/schema.prisma"');
    expect(ext).toContain('cp -R prisma/migrations "$sandbox/prisma/migrations"');
    expect(ext).toContain('raw.replace(line, "")');
    expect(ext).toContain('datasource: { url: env("DATABASE_URL") }');
    expect(ext).toContain('--network "$network" --read-only --cap-drop ALL');
    expect(ext).toContain('--mount "type=bind,src=$sandbox,dst=/shadow,readonly"');
    for (const command of [
      "prisma7_cli schema-validate validate",
      "prisma7_cli migrate-initial migrate deploy",
      "prisma7_cli migrate-idempotent migrate deploy",
      "prisma7_cli migrate-status migrate status",
      'baseline_hash="$(catalog_hash "$database")"',
      'v7_hash="$(catalog_hash "$shadow_db")"',
      'docker exec "$pg" dropdb',
    ]) expect(ext).toContain(command);
    for (const invariant of ["'tables'", "'columns'", "'indexes'", "'constraints'", "'enums'", "'migrations'"]) {
      expect(ext).toContain(invariant);
    }
    expect(ext).toContain("excludes v7 Client/adapter/transaction/pool/app build");
    expect(ext).not.toContain("npm audit fix --force");
    expect(ext).not.toContain("npm install --prefix .");
    expect(ext).not.toContain(".env.production");
  });

  it("R3B generates a v7 ESM client and checks real PrismaPg pool/transaction contract without release changes", () => {
    const cli = readFileSync(
      path.join(process.cwd(), "scripts/ops/prisma7-cli-shadow-extension.sh"), "utf8",
    );
    const runtime = readFileSync(
      path.join(process.cwd(), "scripts/ops/prisma7-client-shadow-extension.sh"), "utf8",
    );
    const workflow = readFileSync(
      path.join(process.cwd(), ".github/workflows/worker-image-runtime.yml"), "utf8",
    );
    const ignore = readFileSync(path.join(process.cwd(), ".dockerignore"), "utf8");
    const imageProof = readFileSync(
      path.join(process.cwd(), "scripts/ops/worker-image-runtime-proof.sh"), "utf8",
    );
    const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    const schema = readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8");
    expect(packageJson.dependencies["@prisma/client"]).toBe("6.19.3");
    expect(packageJson.devDependencies.prisma).toBe("6.19.3");
    expect(packageJson.dependencies["@prisma/adapter-pg"]).toBeUndefined();
    expect(schema).toContain('provider = "prisma-client-js"');
    expect(schema).toContain('url      = env("DATABASE_URL")');
    expect(cli).toContain("prisma@7.10.1 @prisma/client@7.10.1");
    expect(cli).toContain("@prisma/adapter-pg@7.10.1 pg@8.16.3 tsx@4.20.5");
    expect(cli).toContain("source scripts/ops/prisma7-client-shadow-extension.sh");
    expect(cli.indexOf("source scripts/ops/prisma7-client-shadow-extension.sh"))
      .toBeGreaterThan(cli.indexOf('baseline_hash="$(catalog_hash "$database")"'));
    expect(workflow).toContain("scripts/ops/prisma7-client-shadow-extension.sh");
    expect(ignore).toMatch(/^scripts\/ops\/prisma7-client-shadow-extension\.sh$/m);
    expect(imageProof).toContain("/app/scripts/ops/prisma7-client-shadow-extension.sh");
    expect(runtime).toContain('output = "../generated/prisma"');
    expect(runtime).toContain('moduleFormat = "esm"');
    expect(runtime).toContain("provider = \"prisma-client\"");
    expect(runtime).toContain("--network none --read-only");
    expect(runtime).toContain("--cap-drop ALL --security-opt no-new-privileges");
    expect(runtime).toContain('connectionTimeoutMillis: 600');
    expect(runtime).toContain('max: 2');
    expect(runtime).toContain('idleTimeoutMillis: 10_000');
    expect(runtime).toContain("prisma.user.findMany");
    expect(runtime).toContain("await prisma.$transaction");
    expect(runtime).toContain("R3B_EXPECTED_ROLLBACK");
    expect(runtime).toContain("POOL_WAIT_NOT_BOUNDED");
    expect(runtime).toContain('backendPids.size === 2');
    expect(runtime).toContain('/timeout|timed out/i.test(err.message)');
    expect(runtime).toContain('POOL_HOLDERS_NOT_DISTINCT');
    expect(runtime).toContain('EXPECTED_SHADOW_DB=$shadow_db');
    expect(runtime).toContain("await prisma.$disconnect()");
    expect(runtime).toContain("excludes production Prisma extensions");
    expect(runtime).not.toContain("npm audit fix");
    expect(runtime).not.toContain(".env.production");
  });

  it("R3C uses authentic extension source with only a relocated generated-v7 Prisma import", () => {
    const probe = readFileSync(
      path.join(process.cwd(), "scripts/ops/prisma7-extensions-shadow-extension.sh"), "utf8",
    );
    const r3b = readFileSync(
      path.join(process.cwd(), "scripts/ops/prisma7-client-shadow-extension.sh"), "utf8",
    );
    const workflow = readFileSync(
      path.join(process.cwd(), ".github/workflows/worker-image-runtime.yml"), "utf8",
    );
    const dockerignore = readFileSync(path.join(process.cwd(), ".dockerignore"), "utf8");
    const runtimeGuard = readFileSync(
      path.join(process.cwd(), "scripts/ops/worker-image-runtime-proof.sh"), "utf8",
    );
    const soft = readFileSync(path.join(process.cwd(), "src/lib/prisma-soft-delete.ts"), "utf8");
    const ledger = readFileSync(
      path.join(process.cwd(), "src/lib/domain-events/domain-event-ledger-extension.ts"), "utf8",
    );
    expect(workflow).toContain("scripts/ops/prisma7-extensions-shadow-extension.sh");
    expect(workflow).toContain("src/lib/prisma-soft-delete.ts");
    expect(workflow).toContain("src/lib/domain-events/domain-event-ledger-extension.ts");
    expect(dockerignore).toMatch(/^scripts\/ops\/prisma7-extensions-shadow-extension\.sh$/m);
    expect(runtimeGuard).toContain("/app/scripts/ops/prisma7-extensions-shadow-extension.sh");
    expect(r3b).toContain("source scripts/ops/prisma7-extensions-shadow-extension.sh");
    expect(r3b.indexOf("source scripts/ops/prisma7-extensions-shadow-extension.sh"))
      .toBeGreaterThan(r3b.indexOf("PASS R3B Prisma7 client+adapter"));
    expect(soft).toContain('import { Prisma } from "@prisma/client";');
    expect(ledger).toContain('import { Prisma } from "@prisma/client";');
    expect(probe).toContain('cp src/lib/prisma-soft-delete.ts');
    expect(probe).toContain('cp src/lib/domain-events/domain-event-ledger-extension.ts');
    expect(probe).toContain('original.split(needle).length !== 2');
    expect(probe).toContain('relocated.replace(');
    expect(probe).toContain('import { Prisma } from "../generated/prisma/client.ts";');
    expect(probe).toContain("base.$extends(softDeleteExtension).$extends(domainEventLedgerExtension)");
    expect(probe).toContain('EXPECTED_SHADOW_DB=$shadow_db');
    expect(probe).toContain('OUTSIDE_SHADOW_DATABASE');
    expect(probe).toContain('SOFT_DELETE_EXPLICIT_DOMAIN_MUTATION_REQUIRED');
    expect(probe).toContain('DOMAIN_EVENT_APPEND_ONLY');
    expect(probe).toContain('findUniqueOrThrow');
    expect(probe).toContain('omit: { deletedAt: true }');
    expect(probe).toContain('EXPLICIT_DELETED_FILTER_IGNORED');
    expect(probe).toContain('CROSS_TENANT_WHERE_OVERRIDDEN');
    expect(probe).toContain('TX_LEDGER_PARTIAL_COMMIT');
    expect(probe).toContain('HARD_DELETE_ESCAPED_TRANSACTION');
    expect(probe).toContain('await base.$disconnect()');
    expect(probe).toContain('--read-only --cap-drop ALL');
    expect(probe).toContain('--mount "type=bind,src=$sandbox,dst=/shadow,readonly"');
    expect(probe).toContain("does not prove central RBAC");
    expect(probe).not.toContain("npm audit fix");
    expect(probe).not.toContain(".env.production");
  });

  it("R3D01 real Prisma7 Order/RentalOrder CAS and durable idempotent event/outbox proof is shadow-only", () => {
    const probe = readFileSync(
      path.join(process.cwd(), "scripts/ops/prisma7-order-rental-tx-shadow-extension.sh"), "utf8",
    );
    const upstream = readFileSync(
      path.join(process.cwd(), "scripts/ops/prisma7-extensions-shadow-extension.sh"), "utf8",
    );
    const workflow = readFileSync(
      path.join(process.cwd(), ".github/workflows/worker-image-runtime.yml"), "utf8",
    );
    const ignore = readFileSync(path.join(process.cwd(), ".dockerignore"), "utf8");
    const imageGuard = readFileSync(
      path.join(process.cwd(), "scripts/ops/worker-image-runtime-proof.sh"), "utf8",
    );
    expect(workflow).toContain("scripts/ops/prisma7-order-rental-tx-shadow-extension.sh");
    expect(ignore).toMatch(/^scripts\/ops\/prisma7-order-rental-tx-shadow-extension\.sh$/m);
    expect(imageGuard).toContain("/app/scripts/ops/prisma7-order-rental-tx-shadow-extension.sh");
    expect(upstream).toContain("source scripts/ops/prisma7-order-rental-tx-shadow-extension.sh");
    expect(probe).toContain("EXPECTED_SHADOW_DB=$shadow_db");
    expect(probe).toContain("UNSAFE_DATABASE");
    expect(probe).toContain("new PrismaClient(");
    expect(probe).toContain("new PrismaPg(");
    expect(probe).toContain("$extends(softDeleteExtension).$extends(domainEventLedgerExtension)");
    for (const name of ["product.create","rentalListing.create","order.create",
      "rentalOrder.create","outboxEvent.createMany","domainEvent.createMany",
      "rentalOrderStatusLog.create"]) {
      expect(probe).toContain(name);
    }
    expect(probe).toContain("productTransition(\"ACCEPTED\")");
    expect(probe).toContain("productTransition(\"CANCELLED\")");
    expect(probe).toContain("rentalTransition(\"PENDING_PICKUP\")");
    expect(probe).toContain("rentalTransition(\"CANCELLED\")");
    expect(probe).toContain("PRODUCT_DOUBLE_TRANSITION");
    expect(probe).toContain("RENTAL_DOUBLE_TRANSITION");
    expect(probe).toContain("PRODUCT_REPLAY_DUPLICATED");
    expect(probe).toContain("RENTAL_DUPLICATE_STATUS_LOG");
    expect(probe).toContain("DOMAIN_ROLLBACK_LEAK");
    expect(probe).toContain("OUTBOX_ROLLBACK_LEAK");
    expect(probe).toContain("UNIQUE_DEDUPE_NOT_ATOMIC");
    expect(probe).toContain("skipDuplicates:true");
    expect(probe).toContain("Promise.all([insertOnce(),insertOnce(),insertOnce()])");
    expect(probe).toContain("--read-only --cap-drop ALL");
    expect(probe).toContain('--mount "type=bind,src=$sandbox,dst=/shadow,readonly"');
    expect(probe).toContain("does NOT import canonical product/rental lifecycle");
    expect(probe).not.toContain("npm audit fix");
    expect(probe).not.toContain(".env.production");
  });

  it("R3D02A runs real canonical writers/registries with reversible source imports and shadow-only transactions", () => {
    const script = readFileSync(
      path.join(process.cwd(),"scripts/ops/prisma7-canonical-writer-shadow-extension.sh"),"utf8");
    const relocate = readFileSync(
      path.join(process.cwd(),"scripts/ops/prisma7-canonical-writer-relocate.cjs.txt"),"utf8");
    const probe = readFileSync(
      path.join(process.cwd(),"scripts/ops/prisma7-canonical-writer-probe.ts.txt"),"utf8");
    const upstream = readFileSync(
      path.join(process.cwd(),"scripts/ops/prisma7-order-rental-tx-shadow-extension.sh"),"utf8");
    const cli = readFileSync(
      path.join(process.cwd(),"scripts/ops/prisma7-cli-shadow-extension.sh"),"utf8");
    const workflow = readFileSync(
      path.join(process.cwd(),".github/workflows/worker-image-runtime.yml"),"utf8");
    const ignore = readFileSync(path.join(process.cwd(),".dockerignore"),"utf8");
    const image = readFileSync(
      path.join(process.cwd(),"scripts/ops/worker-image-runtime-proof.sh"),"utf8");
    for(const name of ["prisma7-canonical-writer-shadow-extension.sh",
      "prisma7-canonical-writer-relocate.cjs.txt","prisma7-canonical-writer-probe.ts.txt"]){
      expect(workflow).toContain("scripts/ops/"+name);
      expect(ignore).toContain("scripts/ops/"+name);
      expect(image).toContain("/app/scripts/ops/"+name);
    }
    expect(upstream).toContain("source scripts/ops/prisma7-canonical-writer-shadow-extension.sh");
    expect(cli).toContain("tsx@4.20.5 zod@4.1.5");
    for(const name of ["domain-events/domain-event.ts","domain-events/domain-event-registry.ts",
      "domain-events/domain-event-ledger-extension.ts","async/outbox.ts",
      "async/outbox-event-registry.ts","async/job-repository.ts","async/job-types.ts"]){
      expect(relocate).toContain(name);
    }
    expect(relocate).toContain("if(restored!==original)");
    expect(relocate).toContain("R3D02A_RELOCATION_COUNT_MISMATCH");
    expect(relocate).toContain("unique.set(change.to,change)");
    expect(relocate).toContain("original.split(change.from).length-1");
    expect(relocate).toContain("R3D02A_UNMAPPED_PRODUCTION_DEPENDENCY");
    expect(script).toContain("src/lib/domain-events/domain-event.ts");
    expect(script).toContain("src/lib/async/outbox.ts");
    expect(script).toContain("src/lib/async/job-repository.ts");
    expect(script).toContain("R3D02A_SHADOW_REQUIRED");
    expect(script).toContain("R3D02A sanitized machineCodes");
    expect(script).toContain("CLASSIFY_R3D02A");
    expect(script).toContain('--read-only --cap-drop ALL');
    expect(script).toContain('--mount "type=bind,src=$sandbox,dst=/shadow,readonly"');
    const registry = readFileSync(path.join(process.cwd(),
      "src/lib/domain-events/domain-event-registry.ts"),"utf8");
    const canonicalExport = "LIQUIDITY_TRANSACTION_COMPLETED_AGGREGATE_TYPE";
    expect(registry).toContain("export const "+canonicalExport+" =");
    expect(probe).toContain(canonicalExport);
    expect(probe).not.toContain("LIQUIDITY_TRANSACTION_COMPLETED_EVENT_AGGREGATE_TYPE");
    expect(probe).toContain("recordDomainEventTx(tx,domainIntent(completed))");
    expect(probe).toContain("recordOutboxEventTx(tx,outboxIntent(expired))");
    expect(probe).toContain("DOMAIN_EVENT_OCCURRENCE_CONFLICT");
    expect(probe).toContain("DOMAIN_EVENT_INTENT_CONTRACT_INVALID");
    expect(probe).toContain("OUTBOX_EVENT_INTENT_CONTRACT_INVALID");
    expect(probe).toContain("PROJECTION_INTENT_NOT_CANONICAL");
    expect(probe).toContain("ROLLBACK_ASYNCJOB_MUTATED");
    expect(probe).toContain("NON_SHADOW_DB");
    expect(probe).toContain("R3D02A_ABORT_AFTER_ALL_WRITES");
    expect(script).toContain("does not yet import the production order/rental lifecycle");
    expect(script).not.toContain(".env.production");
  });

  it("R3D02B01 proves exact AST production expiry and real governance/capability/outbox dependencies in v7 shadow", () => {
    const read=(p:string)=>readFileSync(path.join(process.cwd(),p),"utf8");
    const workflow=read(".github/workflows/worker-image-runtime.yml");
    const ignore=read(".dockerignore");
    const imageProof=read("scripts/ops/worker-image-runtime-proof.sh");
    const upstream=read("scripts/ops/prisma7-canonical-writer-shadow-extension.sh");
    const shell=read("scripts/ops/prisma7-product-expiry-shadow-extension.sh");
    const prepare=read("scripts/ops/prisma7-product-expiry-prepare.cjs.txt");
    const probe=read("scripts/ops/prisma7-product-expiry-probe.ts.txt");
    const original=read("src/lib/product-order-lifecycle.ts");
    const deps=[
      "prisma7-product-expiry-prepare.cjs.txt",
      "prisma7-product-expiry-probe.ts.txt",
      "prisma7-product-expiry-shadow-extension.sh"
    ];
    for(const name of deps){
      expect(workflow).toContain("scripts/ops/"+name);
      expect(ignore).toContain("scripts/ops/"+name);
      expect(imageProof).toContain("/app/scripts/ops/"+name);
    }
    expect(workflow).toContain("src/lib/product-order-lifecycle.ts");
    expect(upstream).toContain("source scripts/ops/prisma7-product-expiry-shadow-extension.sh");
    expect(prepare).toContain('ts.createSourceFile(');
    expect(prepare).toContain('source.slice(node.getStart(file),node.end)');
    expect(prepare).toContain('if(restored!==original)');
    for(const name of ["expireProductReservationTx","expireLockedProductReservation",
      "projectProductAfterReservationRelease","ACTIVE_PRODUCT_ORDER_STATUSES"]){
      expect(prepare).toContain(name);
      expect(original).toContain(name);
    }
    expect(shell).toContain('--network none --read-only --cap-drop ALL');
    expect(shell).toContain('NODE_PATH=/app/node_modules');
    expect(shell).toContain('--mount "type=bind,src=$sandbox,dst=/shadow,readonly"');
    expect(shell).toContain('EXPECTED_SHADOW_DB=$shadow_db');
    expect(probe).toContain('UNSAFE_DATABASE');
    expect(prepare).toContain('acquireGovernanceSubjectLocks');
    expect(prepare).toContain('evaluateMarketplaceCapability');
    expect(probe).toContain("CAPABILITY_DENIED_RELEASE_NOT_OFFLINE");
    expect(probe).toContain("ELIGIBLE_PRODUCT_NOT_EXPOSED_AFTER_RELEASE");
    expect(probe).toContain("NOT_DUE_CREATED_SIDE_EFFECT");
    expect(probe).toContain("CONCURRENT_EXPIRY_NOT_SERIALIZED");
    expect(probe).toContain("TX_ROLLBACK_ORDER_PRODUCT_OUTBOX_LEAK");
    expect(probe).toContain("R3D02B01_EXPECTED_ABORT_AFTER_OUTBOX");
    expect(shell).toContain("full product module initialization, actor accept/cancel and rental lifecycle not yet validated");
    expect(shell).not.toContain(".env.production");
  });


  it("R3D02B02 runs genuine actor accept/cancel on shadow v7 PG with notification and role fences", () => {
    const read=(p:string)=>readFileSync(path.join(process.cwd(),p),"utf8");
    const workflow=read(".github/workflows/worker-image-runtime.yml");
    const ignore=read(".dockerignore");
    const image=read("scripts/ops/worker-image-runtime-proof.sh");
    const upstream=read("scripts/ops/prisma7-product-expiry-shadow-extension.sh");
    const script=read("scripts/ops/prisma7-product-actor-shadow-extension.sh");
    const prepare=read("scripts/ops/prisma7-product-actor-prepare.cjs.txt");
    const probe=read("scripts/ops/prisma7-product-actor-probe.ts.txt");
    const original=read("src/lib/product-order-lifecycle.ts");
    for (const name of ["prisma7-product-actor-prepare.cjs.txt",
      "prisma7-product-actor-probe.ts.txt","prisma7-product-actor-shadow-extension.sh"]) {
      expect(workflow).toContain("scripts/ops/"+name);
      expect(ignore).toMatch(new RegExp("^scripts/ops/"+name.replaceAll(".","[.]")+"$","m"));
      expect(image).toContain("/app/scripts/ops/"+name);
    }
    expect(upstream).toContain("source scripts/ops/prisma7-product-actor-shadow-extension.sh");
    expect(prepare).toContain("ts.createSourceFile(");
    expect(prepare).toContain("source.slice(matches[0].getStart(ast),matches[0].end)");
    expect(prepare).toContain("if(restored!==original)");
    for(const name of ["acceptProductOrderTx","cancelProductOrderTx",
      "expireLockedProductReservation","projectProductAfterReservationRelease",
      "ACTIVE_PRODUCT_ORDER_STATUSES"]){
      expect(prepare).toContain(name);
      expect(original).toContain(name);
    }
    for(const mod of ["active-account-mutation.ts","rbac/service.ts",
      "notification-service.ts","notification-registry.ts",
      "email-config.ts","notification-delivery.ts"]){
      expect(script).toContain(mod);
    }
    expect(prepare).toContain("R3D02B02_UNMAPPED_ALIAS");
    expect(script).toContain("--network none --read-only --cap-drop ALL");
    expect(script).toContain('NODE_PATH=/app/node_modules');
    expect(script).toContain('--mount "type=bind,src=$sandbox,dst=/shadow,readonly"');
    expect(script).toContain("EXPECTED_SHADOW_DB=$shadow_db");
    expect(script).toContain("-e EMAIL_PROVIDER=disabled");
    expect(probe).toContain("UNSAFE_DATABASE");
    expect(probe).toContain("$extends(softDeleteExtension).$extends(domainEventLedgerExtension)");
    expect(probe).toContain("AUTH_ACCOUNT_INACTIVE");
    expect(probe).toContain("CROSS_CAMPUS_OUTSIDER_CANCELLED");
    expect(probe).toContain("STALE_CANDIDATE_BYPASSED");
    expect(probe).toContain("RACE_NOT_SERIALIZED");
    expect(probe).toContain("LATE_CANONICAL_OUTBOX");
    expect(probe).toContain("ROLLBACK_ORDER_PRODUCT_NOTIFICATION_LEAK");
    expect(probe).toContain("R3D02B02_EXPECTED_ABORT_AFTER_CANONICAL_NOTIFICATION");
    expect(probe).toContain("canonical Notification");
    expect(script).not.toContain(".env.production");
    expect(script).toContain("full module load");
  });


  it("R3D02C01 only runs exact production rental core functions with real governance/notification on isolated PG", () => {
    const read=(p:string)=>readFileSync(path.join(process.cwd(),p),"utf8");
    const ci=read(".github/workflows/worker-image-runtime.yml");
    const ignore=read(".dockerignore");
    const image=read("scripts/ops/worker-image-runtime-proof.sh");
    const upstream=read("scripts/ops/prisma7-product-actor-shadow-extension.sh");
    const script=read("scripts/ops/prisma7-rental-core-shadow-extension.sh");
    const prepare=read("scripts/ops/prisma7-rental-core-prepare.cjs.txt");
    const probe=read("scripts/ops/prisma7-rental-core-probe.ts.txt");
    const prod=read("src/lib/rental-order-machine.ts");
    const scripts=["prisma7-rental-core-prepare.cjs.txt",
      "prisma7-rental-core-probe.ts.txt","prisma7-rental-core-shadow-extension.sh"];
    for(const name of scripts) {
      expect(ci).toContain("scripts/ops/"+name);
      expect(ignore).toContain("scripts/ops/"+name);
      expect(image).toContain("/app/scripts/ops/"+name);
    }
    expect(ci).toContain("src/lib/rental-order-machine.ts");
    expect(upstream).toContain("source scripts/ops/prisma7-rental-core-shadow-extension.sh");
    expect(prepare).toContain("ts.createSourceFile");
    expect(prepare).toContain("source.slice(matches[0].getStart(ast),matches[0].end)");
    for(const name of ["approveRentalOrderTx","rejectRentalOrderTx","confirmPickupTx",
      "cancelRentalOrderTx","writeStatusLog","isRentalOrderRoleParticipant",
      "canCancelRentalOrder","counterpartyId"]) {
      expect(prepare).toContain(name);
      expect(prod).toContain(name);
    }
    expect(prepare).toContain("governance/active-account-mutation");
    expect(prepare).toContain("notifications/notification-service");
    expect(script).toContain("--network none --read-only --cap-drop ALL");
    expect(script).toContain('--mount "type=bind,src=$sandbox,dst=/shadow,readonly"');
    expect(script).toContain('EXPECTED_SHADOW_DB=$shadow_db');
    expect(script).toContain("EMAIL_PROVIDER=disabled");
    expect(script).not.toContain(".env.production");
    expect(probe).toContain("UNSAFE_DB");
    expect(probe).toContain("$extends(softDeleteExtension).$extends(domainEventLedgerExtension)");
    expect(probe).toContain("SUSPENDED_RENTER_ACCEPTED");
    expect(probe).toContain("APPROVE_REJECT_DOUBLE_WIN");
    expect(probe).toContain("PICKUP_CANCEL_DOUBLE_WIN");
    expect(probe).toContain("REPLAY_DELETED_EVIDENCE");
    expect(probe).toContain("REJECT_COPIED_FREE_TEXT");
    expect(probe).toContain("R3D02C01_EXPECTED_ABORT_AFTER_NOTIFICATION");
    expect(script).toContain("does not cover rental creation, return, extension");
  });


  it("R3D02C02 rental owner decision uses order row lock and status CAS against renter cancellation", () => {
    const read=(p:string)=>readFileSync(path.join(process.cwd(),p),"utf8");
    const src=read("src/lib/rental-order-machine.ts");
    const probe=read("scripts/ops/prisma7-rental-core-probe.ts.txt");
    const shell=read("scripts/ops/prisma7-rental-core-shadow-extension.sh");
    for(const fn of ["approveRentalOrderTx","rejectRentalOrderTx"]){
      const start=src.indexOf("export async function "+fn+"(");
      const end=src.indexOf("export async function ",start+1);
      const body=src.slice(start,end>start?end:src.length);
      expect(body).toContain("await prepareActiveAccountMutation(tx, input.userId)");
      expect(body).toContain('SELECT "id" FROM "RentalOrder" WHERE "id" = ${input.orderId} FOR UPDATE');
      expect(body.indexOf("FOR UPDATE")).toBeLessThan(body.indexOf("tx.rentalOrder.findFirst("));
      expect(body).toContain("tx.rentalOrder.updateMany({");
      expect(body).toContain("ownerId: input.userId, status: 'PENDING_APPROVAL'");
      expect(body).toContain("if (moved.count !== 1) return");
      expect(body).not.toContain("await tx.rentalOrder.update({");
    }
    expect(probe).toContain('for(const decision of ["approve","reject"] as const)');
    expect(probe).toContain("CROSS_CANCEL_NOT_WRITTEN_");
    expect(probe).toContain("pg_blocking_pids(");
    expect(probe).toContain("OWNER_ROW_LOCK_WAIT_NOT_OBSERVED_");
    expect(probe).toContain("OWNER_OVERWROTE_RENTER_CANCEL_");
    expect(probe).toContain("CROSS_CANCEL_STATE_LOG_NOTIFICATION_DRIFT_");
    expect(probe).toContain("R3D02C02 deterministic real PG renter CANCEL");
    expect(shell).toContain("grep -qF 'PASS R3D02C02 deterministic real PG renter CANCEL");
  });


  it("R3D02C03 locks the original renter return request and runs real PG terminal/rollback proof", () => {
    const read=(p:string)=>readFileSync(path.join(process.cwd(),p),"utf8");
    const src=read("src/lib/rental-order-machine.ts");
    const prepare=read("scripts/ops/prisma7-rental-core-prepare.cjs.txt");
    const probe=read("scripts/ops/prisma7-rental-core-probe.ts.txt");
    const shell=read("scripts/ops/prisma7-rental-core-shadow-extension.sh");
    const start=src.indexOf("export async function requestReturnTx(");
    const end=src.indexOf("export async function confirmReturnTx(",start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const fn=src.slice(start,end);
    expect(fn).toContain("await prepareActiveAccountMutation(tx, input.userId, activeAccountSeams)");
    expect(fn).toContain('SELECT "id" FROM "RentalOrder" WHERE "id" = ${input.orderId} FOR UPDATE');
    expect(fn.indexOf("FOR UPDATE")).toBeLessThan(fn.indexOf("tx.rentalOrder.findFirst("));
    expect(fn).toContain("tx.rentalOrder.updateMany({");
    expect(fn).toContain("renterId: input.userId");
    expect(fn).toContain("status: { in: ['IN_RENTAL', 'OVERDUE', 'PICKED_UP'] }");
    expect(fn).toContain("if (moved.count !== 1)");
    expect(fn).not.toContain("await tx.rentalOrder.update({");
    expect(prepare).toContain('"requestReturnTx"');
    expect(prepare).toContain("ActiveAccountMutationSeams");
    expect(prepare).toContain("RENTAL_RETURN_REQUESTED_KIND");
    expect(probe).toContain("RETURN_ROW_LOCK_WAIT_ABSENT");
    expect(probe).toContain("pg_blocking_pids(");
    expect(probe).toContain("RETURN_RESURRECTED_COMPLETED");
    expect(probe).toContain("INACTIVE_RENTER_RETURN");
    expect(probe).toContain("RETURN_REPLAY_DUPLICATE");
    expect(probe).toContain("R3D02C03_FORCED_ABORT_AFTER_RETURN_WRITE");
    expect(shell).toContain("PASS R3D02C03 real PostgreSQL terminal row-lock wait");
    expect(shell).toContain("not full original confirmReturnTx");
  });


  it("R3D02C04 locks original return confirmation, never overwrites evidence and uses canonical liquidity writer", () => {
    const read=(p:string)=>readFileSync(path.join(process.cwd(),p),"utf8");
    const src=read("src/lib/rental-order-machine.ts");
    const prep=read("scripts/ops/prisma7-rental-core-prepare.cjs.txt");
    const shell=read("scripts/ops/prisma7-rental-core-shadow-extension.sh");
    const proof=read("scripts/ops/prisma7-rental-core-probe.ts.txt");
    const canonical=read("src/lib/analytics/liquidity-domain-events.ts");
    const start=src.indexOf("export async function confirmReturnTx(");
    const end=src.indexOf("export async function cancelRentalOrderTx(",start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const fn=src.slice(start,end);
    expect(fn).toContain("await prepareActiveAccountMutation(tx, input.userId)");
    expect(fn).toContain('SELECT "id" FROM "RentalOrder" WHERE "id" = ${orderId} FOR UPDATE');
    expect(fn.indexOf("FOR UPDATE")).toBeLessThan(fn.indexOf("tx.rentalOrder.findFirst("));
    expect(fn).toContain("[...new Set([...(order.returnRecord?.photos ?? []), ...photos])]");
    expect(fn).toContain("!order.returnRecord?.ownerConfirmed");
    expect(fn).toContain("role === 'owner' && order.status !== 'PENDING_RETURN'");
    expect(fn).toContain("tx.rentalOrder.updateMany({");
    expect(fn).toContain("where: { id: orderId, ownerId: userId, status: 'PENDING_RETURN' }");
    expect(fn).toContain('throw new Error("RENTAL_RETURN_ORDER_STATE_CONFLICT")');
    expect(fn).not.toContain("await tx.rentalOrder.update({");
    expect(prep).toContain('"confirmReturnTx"');
    expect(prep).toContain('"depositStatusAfterCompletion"');
    expect(prep).toContain('"incrementRentalCompletionCounters"');
    expect(prep).toContain("R3D02C04_CANONICAL_SOURCE_CHANGED");
    expect(prep).toContain("recordLiquidityTransactionCompletionFactsTx");
    expect(canonical).toContain("recordDomainEventTx(tx");
    expect(shell).toContain("src/lib/analytics/liquidity-domain-events.ts");
    expect(shell).toContain("PASS R3D02C04 authentic liquidity event/counter canonical writer import provenance");
    for(const marker of ["CANONICAL_COMPLETE_EVENTS",
      "CANONICAL_PROJECTION_JOB","ONCE_ONLY_PARTICIPATION_COUNTS",
      "MERGED_EVIDENCE_AND_OWNER_AUTHORITY","LATE_RENTER_CLOBBERED_OWNER",
      "CONCURRENT_OWNER_LEDGER_COUNTER_DUP","ROLLBACK_CROSS_DOMAIN_WRITES",
      "OWNER_CONFIRM_ROW_LOCK_NOT_OBSERVED","DISPUTE_OVERWRITTEN_BY_RETURN"]){
      expect(proof).toContain(marker);
    }
    expect(proof).toContain("pg_blocking_pids(");
    expect(proof).toContain("R3D02C04_FORCED_ABORT_AFTER_LEDGER");
    expect(shell).toContain("not fully verified");
  });


  it("R3D02C05A keeps original damage submission/response behind the rental order mutex", () => {
    const read=(p:string)=>readFileSync(path.join(process.cwd(),p),"utf8");
    const src=read("src/lib/rental-order-machine.ts");
    const prepare=read("scripts/ops/prisma7-rental-core-prepare.cjs.txt");
    const probe=read("scripts/ops/prisma7-rental-core-probe.ts.txt");
    const shell=read("scripts/ops/prisma7-rental-core-shadow-extension.sh");
    const names=["submitDamageClaimTx","respondDamageClaimTx"];
    for(const name of names){
      const start=src.indexOf("export async function "+name+"(");
      const end=src.indexOf("export async function ",start+1);
      expect(start).toBeGreaterThan(0);
      const fn=src.slice(start,end>start?end:src.length);
      expect(fn).toContain("prepareActiveAccountMutation(tx, input.userId)");
      expect(fn).toContain('SELECT "id" FROM "RentalOrder" WHERE "id" =');
      expect(fn.indexOf("FOR UPDATE")).toBeLessThan(fn.indexOf("tx.rentalDamageClaim.create(")>0
        ?fn.indexOf("tx.rentalDamageClaim.create("):
         fn.indexOf("tx.rentalDamageClaim.updateMany("));
      expect(prepare).toContain('"'+name+'"');
    }
    const submitStart=src.indexOf("export async function submitDamageClaimTx(");
    const submitEnd=src.indexOf("export async function respondDamageClaimTx(");
    const submit=src.slice(submitStart,submitEnd);
    expect(submit).toContain("where: { orderId: order.id, resolvedAt: null }");
    expect(submit).toContain("索赔金额必须大于零");
    const response=src.slice(submitEnd,src.indexOf("export async function initiateDisputeTx(",submitEnd));
    expect(response).toContain("select: { orderId: true }");
    expect(response).toContain("claim.orderId !== candidate.orderId");
    expect(response).toContain("RENTAL_CLAIM_ORDER_STATE_CONFLICT");
    expect(prepare).toContain("RENTAL_DAMAGE_CLAIM_RESPONDED_KIND");
    expect(probe).toContain("pg_blocking_pids(");
    expect(probe).toContain("CLAIM_SUBMIT_ROW_WAIT_NOT_OBSERVED");
    expect(probe).toContain("CLAIM_RESPONSE_ROW_WAIT_NOT_OBSERVED");
    expect(probe).toContain("DUPLICATE_UNRESOLVED_CLAIM_ALLOWED");
    expect(probe).toContain("CLAIM_COMPLETION_COUNT_ONCE");
    expect(shell).toContain("PASS R3D02C05A real dispute row-lock blocks stale response");
  });


  it("R3D02C05B extracts the original dispute writer and proves two commit orders on real PG", () => {
    const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
    const prepare = read("scripts/ops/prisma7-rental-core-prepare.cjs.txt");
    const probe = read("scripts/ops/prisma7-rental-core-probe.ts.txt");
    const shell = read("scripts/ops/prisma7-rental-core-shadow-extension.sh");
    const original = read("src/lib/rental-order-machine.ts");
    expect(original).toContain("export async function initiateDisputeTx(");
    expect(prepare).toContain('"initiateDisputeTx"');
    expect(prepare).toContain('"acquireGovernanceSubjectLocks"');
    expect(prepare).toContain('"createHoldTxLocked"');
    expect(prepare).toContain('"requireNewActivityAllowed"');
    expect(prepare).toContain('"isUniqueViolationOn"');
    expect(prepare).toContain('R3D02C05B_SOURCE_DRIFT_');
    expect(prepare).toContain('R3D02C05B authentic dispute/governance/hold/feature-flag AST declaration provenance');
    expect(shell).toContain("disputes/dispute-scope.ts disputes/dispute-sla.ts");
    expect(shell).toContain("feature-flags/feature-flag-registry.ts");
    expect(shell).toContain("rental-dispute-eligibility.ts");
    expect(probe).not.toContain("initiatedDisputeTx"); // No renamed pseudo-writer.
    expect(probe).toContain("initiateDisputeTx(tx,");
    expect(probe).toContain("pg_blocking_pids(");
    expect(probe).toContain("REAL_DISPUTE_WON_CLAIM");
    expect(probe).toContain("REVERSE_DISPUTE_DUPLICATE_COMPLETION");
    expect(probe).toContain("ORIGINAL_DISPUTE_ABORT_PARTIAL");
    expect(shell).toContain("PASS R3D02C05B original full dispute/claim concurrency");
    expect(shell).toContain("original dispute creates two canonical holds");
    expect(shell).toContain("claim completion then original dispute preserves exactly-once ledger");
  });

});
