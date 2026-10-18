#!/usr/bin/env bash
# Issue #157 R3A: disposable Prisma 7 CLI-only migration feasibility.
# Source only after Prisma 6 migrated an isolated PG in worker image CI.
# Does NOT prove v7 Client, driver adapters, pool/tx, or production safety.
set -euo pipefail
[[ "${sha:-}" =~ ^[a-f0-9]{40}$ && -n "${GITHUB_RUN_ID:-}" &&
   -n "${pg:-}" && -n "${network:-}" && -d "${tmp:-/does-not-exist}" ]] || {
  echo '[worker-cycle][FAIL] R3A requires isolated exact-HEAD fixture' >&2; exit 2;
}
shadow_db="proof_prisma7_${GITHUB_RUN_ID}"
sandbox="$tmp/prisma7-shadow"
[[ ! -e "$sandbox" ]] || { echo '[worker-cycle][FAIL] R3A sandbox collision' >&2; exit 1; }
mkdir -p "$sandbox/prisma"
cp prisma/schema.prisma "$sandbox/prisma/schema.prisma"
cp -R prisma/migrations "$sandbox/prisma/migrations"
node - "$sandbox/prisma/schema.prisma" <<'CONVERT_R3A'
const fs = require("node:fs");
const file = process.argv[2];
const raw = fs.readFileSync(file, "utf8");
const line = /^  url\s+= env\("DATABASE_URL"\)\s*$/gm;
if ([...raw.matchAll(line)].length !== 1 ||
    !raw.includes('provider = "postgresql"') ||
    !raw.includes('provider = "prisma-client-js"') ||
    (raw.match(/^datasource db \{$/gm) || []).length !== 1) {
  console.error("[worker-cycle][FAIL] R3A Prisma 6 schema signature drift");
  process.exit(1);
}
fs.writeFileSync(file, raw.replace(line, "").replace(/\n{3,}/g, "\n\n"));
CONVERT_R3A
cat >"$sandbox/package.json" <<'PACKAGE_R3A'
{"private":true,"type":"module","name":"prisma7-shadow-cli-proof"}
PACKAGE_R3A
cat >"$sandbox/prisma.config.ts" <<'CONFIG_R3A'
import { defineConfig, env } from "prisma/config";
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
CONFIG_R3A
# The package's install scripts are untrusted: execute them in a DIFFERENT
# container on default bridge, not in the GitHub runner host that holds the
# temporary GHCR login. This container receives NO GITHUB_TOKEN, registry
# config, DB URL, or project source. It only sees the disposable writable
# /shadow directory. Root filesystem and /tmp are isolated, capabilities dropped.
# The install is NOT release provenance/SBOM and cannot mutate candidate images.
install_rc=0
timeout 180s docker run --rm \
  --network bridge --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=512m \
  --mount "type=bind,src=$sandbox,dst=/shadow" \
  --workdir /shadow -e HOME=/tmp -e npm_config_cache=/shadow/.npm-cache \
  --entrypoint npm "campus-marketplace-migrator:$sha" \
  install --prefix /shadow --no-save --package-lock=false \
  --no-audit --no-fund prisma@7.10.1 @prisma/client@7.10.1 \
  @prisma/adapter-pg@7.10.1 pg@8.16.3 tsx@4.20.5 \
  >"$tmp/prisma7-install.log" 2>&1 || install_rc=$?
if [[ "$install_rc" != 0 ]]; then
  # Classify a failed bootstrap without disclosing arbitrary npm/registry logs
  # (they may include URLs, authorization or synthetic values).
  node - "$tmp/prisma7-install.log" "$install_rc" <<'CLASSIFY_R3A'
const fs = require("node:fs");
const raw = fs.readFileSync(process.argv[2],"utf8");
const rc = Number(process.argv[3]);
const categories = {
  network: /EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i,
  permission: /EACCES|EPERM|EROFS/i,
  registry: /E404|E403|E401|E429|404 Not Found/i,
  engine: /EBADENGINE|Unsupported engine/i,
  installScript: /postinstall|preinstall|prepare script|command failed/i,
  storage: /ENOSPC|ENOMEM|EIO/i,
  diskFull: /ENOSPC/i,
  memory: /ENOMEM/i,
  io: /\bEIO\b/i,
  docker: /docker: Error|permission denied while trying to connect to Docker/i,
};
const seen = Object.fromEntries(Object.entries(categories).map(([key,pattern])=>[key,pattern.test(raw)]));
console.log("[worker-cycle] R3A install failed exit=" + rc + " categories=" + JSON.stringify(seen) +
  " logLines=" + raw.split(/\r?\n/).length);
CLASSIFY_R3A
  echo '[worker-cycle][FAIL] R3A isolated Prisma 7 CLI install unavailable' >&2; exit 1;
fi
# Temporary npm cache contains untrusted registry material, never mount it to
# the subsequent read-only migration CLI container.
rm -rf "$sandbox/.npm-cache"
node - "$sandbox/node_modules/prisma/package.json" <<'CHECK_R3A'
const pkg = require(process.argv[2]);
if (pkg.version !== "7.10.1") {
  console.error("[worker-cycle][FAIL] R3A exact Prisma CLI version mismatch");
  process.exit(1);
}
CHECK_R3A
docker exec "$pg" createdb -U postgres "$shadow_db" >/dev/null 2>&1 || {
  echo '[worker-cycle][FAIL] R3A shadow database creation failed' >&2; exit 1;
}
shadow_url="postgresql://postgres:${pg_password}@${pg}:5432/${shadow_db}?schema=public"
# The real candidate migrator image hosts Node24, but its Prisma6 entrypoint is
# replaced by a separately installed Prisma7 JS CLI mounted read-only.
prisma7_cli() {
  local label="$1"; shift
  if ! timeout --signal=TERM --kill-after=10s 180s docker run --rm \
    --network "$network" --read-only --cap-drop ALL \
    --security-opt no-new-privileges \
    --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=64m \
    --mount "type=bind,src=$sandbox,dst=/shadow,readonly" \
    --workdir /shadow -e "DATABASE_URL=$shadow_url" \
    --entrypoint node "campus-marketplace-migrator:$sha" \
    /shadow/node_modules/prisma/build/index.js "$@" \
    >"$tmp/prisma7-$label.log" 2>&1; then
    printf '[worker-cycle][FAIL] R3A Prisma7 CLI stage=%s (raw output private)\n' "$label" >&2
    exit 1
  fi
  printf '[worker-cycle] PASS R3A CLI stage=%s\n' "$label"
}
prisma7_cli schema-validate validate
prisma7_cli migrate-initial migrate deploy
prisma7_cli migrate-idempotent migrate deploy
prisma7_cli migrate-status migrate status
# R3B client+driver adapter proof uses the same disposable database after CLI parity.
# It cannot bypass R3A catalog identity checks; invoked just before the DROP.

# Stable catalog fingerprint, ignoring DB-specific OIDs and timestamps. The
# existing Prisma 6 database and the Prisma 7-created second DB must match.
catalog_hash() {
  docker exec -i "$pg" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$1" -At <<'CATALOG_R3A'
WITH details AS (
  SELECT 'tables' AS k, tablename AS v FROM pg_tables WHERE schemaname='public'
  UNION ALL
  SELECT 'columns', table_name||'|'||column_name||'|'||data_type||'|'||
    coalesce(udt_name,'')||'|'||is_nullable||'|'||coalesce(column_default,'')
    FROM information_schema.columns WHERE table_schema='public'
  UNION ALL
  SELECT 'indexes', tablename||'|'||indexname||'|'||indexdef
    FROM pg_indexes WHERE schemaname='public'
  UNION ALL
  SELECT 'constraints', rel.relname||'|'||c.conname||'|'||pg_get_constraintdef(c.oid)
    FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid
    JOIN pg_namespace ns ON rel.relnamespace=ns.oid WHERE ns.nspname='public'
  UNION ALL
  SELECT 'enums', t.typname||'|'||e.enumlabel||'|'||e.enumsortorder
    FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
    JOIN pg_namespace ns ON t.typnamespace=ns.oid WHERE ns.nspname='public'
  UNION ALL
  SELECT 'migrations', migration_name||'|'||checksum||'|'||(finished_at IS NOT NULL)::text
    FROM "_prisma_migrations"
)
SELECT k||'='||md5(string_agg(v,E'\n' ORDER BY v))
FROM details GROUP BY k ORDER BY k;
CATALOG_R3A
}
baseline_hash="$(catalog_hash "$database")" || {
  echo '[worker-cycle][FAIL] R3A baseline catalog read unavailable' >&2; exit 1;
}
v7_hash="$(catalog_hash "$shadow_db")" || {
  echo '[worker-cycle][FAIL] R3A shadow catalog read unavailable' >&2; exit 1;
}
[[ -n "$baseline_hash" && "$baseline_hash" == "$v7_hash" ]] || {
  echo '[worker-cycle][FAIL] R3A Prisma6/7 SQL catalog mismatch' >&2; exit 1;
}
completed="$(docker exec "$pg" psql -X -U postgres -d "$shadow_db" -Atc \
  'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL' 2>/dev/null)" || {
  echo '[worker-cycle][FAIL] R3A v7 migration count unreadable' >&2; exit 1;
}
[[ "$completed" == "$n" && "$completed" =~ ^[1-9][0-9]*$ ]] || {
  echo '[worker-cycle][FAIL] R3A v7 migration count mismatch' >&2; exit 1;
}
# Run only after the immutable Prisma6/7 schema and migration fingerprints match.
source scripts/ops/prisma7-client-shadow-extension.sh
docker exec "$pg" dropdb -U postgres "$shadow_db" >/dev/null 2>&1 || {
  echo '[worker-cycle][FAIL] R3A disposable shadow DB drop failed' >&2; exit 1;
}
printf '[worker-cycle] PASS R3A Prisma7 CLI schema/migrations/idempotency/catalog parity version=7.10.1 count=%s\n' "$completed"
echo '[worker-cycle] LIMIT R3A excludes v7 Client/adapter/transaction/pool/app build and production trust'
