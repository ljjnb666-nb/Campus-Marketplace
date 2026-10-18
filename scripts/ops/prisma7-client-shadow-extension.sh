#!/usr/bin/env bash
# Issue #157 R3B: run the real v7-generated Prisma Client and PrismaPg adapter
# against the disposable PostgreSQL shadow database created by R3A.
# No production runtime/client/lockfile changes. Does not prove app extensions.
set -euo pipefail
[[ "${sha:-}" =~ ^[0-9a-f]{40}$ && -n "${sandbox:-}" &&
   -d "${sandbox:-/missing}" && -n "${shadow_db:-}" &&
   -n "${shadow_url:-}" && -n "${network:-}" ]] || {
  echo '[worker-cycle][FAIL] R3B requires R3A shadow prerequisites' >&2; exit 1;
}
# Fail closed if the original project generator/layout moves. v7's recommended
# prisma-client generator is deliberately used IN THE SHADOW ONLY; no import
# path changes are made to src/ or package-lock.json.
node - "$sandbox/prisma/schema.prisma" <<'SCHEMA_R3B'
const fs = require("node:fs");
const file = process.argv[2];
const source = fs.readFileSync(file,"utf8");
const expected = 'generator client {\n  provider = "prisma-client-js"\n}';
if (source.split(expected).length !== 2 ||
    (source.match(/^datasource db \{$/gm)||[]).length !== 1 ||
    /^\s*url\s*=/m.test(source)) {
  console.error("[worker-cycle][FAIL] R3B generator/schema drift");
  process.exit(1);
}
const generated = 'generator client {\n  provider = "prisma-client"\n' +
  '  output = "../generated/prisma"\n  moduleFormat = "esm"\n}';
fs.writeFileSync(file, source.replace(expected,generated));
SCHEMA_R3B
# Generate in a separate unprivileged container; exact pinned v7 CLI and client
# are already installed in sandbox by R3A. No GitHub token or database creds.
# /shadow is the ONLY writable host mount, with a bounded writable /tmp.
if ! timeout 150s docker run --rm --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=256m \
  --mount "type=bind,src=$sandbox,dst=/shadow" \
  --workdir /shadow -e HOME=/tmp \
  -e DATABASE_URL=postgresql://localhost:5432/synthetic_generate_only \
  --entrypoint node "campus-marketplace-migrator:$sha" \
  /shadow/node_modules/prisma/build/index.js generate \
  >"$tmp/r3b-generate.log" 2>&1; then
  echo '[worker-cycle][FAIL] R3B Prisma7 generated-client build unavailable' >&2; exit 1;
fi
[[ -f "$sandbox/generated/prisma/client.ts" ]] || {
  echo '[worker-cycle][FAIL] R3B v7 generated client missing' >&2; exit 1;
}
for pkg in "@prisma/client" "@prisma/adapter-pg" "pg" "tsx"; do
  [[ -f "$sandbox/node_modules/$pkg/package.json" ]] || {
    echo '[worker-cycle][FAIL] R3B sandbox adapter or runner package absent' >&2; exit 1;
  }
done
node - "$sandbox" <<'VERSIONS_R3B'
const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[2];
for (const name of ["@prisma/client","@prisma/adapter-pg"]) {
  const p = JSON.parse(fs.readFileSync(path.join(dir,"node_modules",name,"package.json"),"utf8"));
  if (p.version !== "7.10.1") {
    console.error("[worker-cycle][FAIL] R3B incompatible package version");
    process.exit(1);
  }
}
VERSIONS_R3B
# This actual TS probe runs exclusively inside the R3A shadow DB. No writes to
# existing v6 baseline tables except an untrusted empty read; DDL is on the
# shadow and run after the R3A catalog fingerprint has already passed.
cat > "$sandbox/r3b-probe.ts" <<'PROBE_R3B'
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.ts";

function assert(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error("R3B_" + code);
}
const url = process.env.DATABASE_URL!;
const shadow = process.env.EXPECTED_SHADOW_DB!;
assert(new URL(url).pathname === "/" + shadow, "NOT_SHADOW_DB");
const adapter = new PrismaPg({
  connectionString: url,
  max: 2,
  connectionTimeoutMillis: 600,
  idleTimeoutMillis: 10_000,
});
const prisma = new PrismaClient({ adapter, log: ["error"] });
let releaseHolders: (() => void) | undefined;
let holders: Promise<unknown>[] = [];
try {
  await prisma.$connect();
  const users = await prisma.user.findMany({ take: 1, select: { id: true } });
  assert(Array.isArray(users), "GENERATED_MODEL_READ");
  console.log("[worker-cycle] PASS R3B generated v7 user.findMany adapter read");

  await prisma.$executeRawUnsafe(
    'CREATE TABLE "__r3b_probe" (id INTEGER PRIMARY KEY, value TEXT NOT NULL)'
  );
  await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('INSERT INTO "__r3b_probe"(id,value) VALUES (1,\'commit\')');
  }, { timeout: 4000, maxWait: 2000 });
  let afterCommit = await prisma.$queryRawUnsafe<{ count: number }[]>(
    'SELECT COUNT(*)::int AS count FROM "__r3b_probe" WHERE id=1'
  );
  assert(afterCommit[0]?.count === 1,"COMMIT_MISSING");
  let expectedAbort = false;
  try {
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('INSERT INTO "__r3b_probe"(id,value) VALUES (2,\'rollback\')');
      throw new Error("R3B_EXPECTED_ROLLBACK");
    }, { timeout: 4000, maxWait: 2000 });
  } catch (e) {
    expectedAbort = e instanceof Error && e.message === "R3B_EXPECTED_ROLLBACK";
  }
  assert(expectedAbort,"ABORT_NOT_PRESERVED");
  const afterRollback = await prisma.$queryRawUnsafe<{ count: number }[]>(
    'SELECT COUNT(*)::int AS count FROM "__r3b_probe" WHERE id=2'
  );
  assert(afterRollback[0]?.count === 0,"ROLLBACK_LEAK");
  console.log("[worker-cycle] PASS R3B real v7 transaction COMMIT and forced ROLLBACK");

  let acquired = 0;
  const backendPids = new Set<number>();
  let signalReady!: () => void;
  const ready = new Promise<void>(resolve => { signalReady = resolve; });
  const hold = new Promise<void>(resolve => { releaseHolders = resolve; });
  const holder = () => prisma.$transaction(async tx => {
    const [backend] = await tx.$queryRawUnsafe<{ pid: number }[]>(
      "SELECT pg_backend_pid() AS pid"
    );
    assert(typeof backend?.pid === "number", "BACKEND_PID_UNREADABLE");
    backendPids.add(backend.pid);
    acquired++;
    if (acquired === 2) signalReady();
    await hold;
  }, { timeout: 7000, maxWait: 2200 });
  holders = [holder(), holder()];
  await Promise.race([
    ready,
    new Promise<never>((_,reject) =>
      setTimeout(() => reject(new Error("R3B_HOLDER_NOT_READY")), 3000))
  ]);
  assert(acquired === 2 && backendPids.size === 2,"POOL_HOLDERS_NOT_DISTINCT");
  const start = Date.now();
  let timeoutRejected = false;
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
  } catch (err) {
    // An arbitrary SQL/prisma/driver error must never count as a pool proof.
    timeoutRejected = err instanceof Error && /timeout|timed out/i.test(err.message);
  }
  const elapsed = Date.now()-start;
  assert(timeoutRejected && elapsed >= 350 && elapsed < 2400,"POOL_WAIT_NOT_BOUNDED");
  console.log("[worker-cycle] PASS R3B real pg adapter max=2 bounded acquire timeout=600ms");
} finally {
  releaseHolders?.();
  await Promise.allSettled(holders);
  await prisma.$disconnect();
}
PROBE_R3B
# Driver probe is executed in the real Node24 candidate migrator image but
# with its CLI entrypoint replaced. Sandbox and FS are read-only. No production
# credentials, only the isolated R3A PostgreSQL URL.
if ! timeout --signal=TERM --kill-after=10s 90s docker run --rm \
  --network "$network" --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=128m \
  --mount "type=bind,src=$sandbox,dst=/shadow,readonly" \
  --workdir /shadow \
  -e "DATABASE_URL=$shadow_url" -e "EXPECTED_SHADOW_DB=$shadow_db" \
  --entrypoint node "campus-marketplace-migrator:$sha" \
  /shadow/node_modules/tsx/dist/cli.mjs /shadow/r3b-probe.ts \
  >"$tmp/r3b-probe.log" 2>&1; then
  echo '[worker-cycle][FAIL] R3B v7 PrismaPg shadow runtime probe failed' >&2; exit 1;
fi
for expected in \
  'PASS R3B generated v7 user.findMany adapter read' \
  'PASS R3B real v7 transaction COMMIT and forced ROLLBACK' \
  'PASS R3B real pg adapter max=2 bounded acquire timeout=600ms'; do
  grep -qF "$expected" "$tmp/r3b-probe.log" || {
    echo '[worker-cycle][FAIL] R3B bounded runtime success markers missing' >&2; exit 1;
  }
done
echo '[worker-cycle] PASS R3B Prisma7 client+adapter basic model, commit/rollback and pool budget (shadow only)'
echo '[worker-cycle] LIMIT R3B excludes production Prisma extensions, Next bundle, identity/tenant gates and upgrade/rollback'
# R3C: test production extension source unchanged (except v7 Prisma import path).
source scripts/ops/prisma7-extensions-shadow-extension.sh
