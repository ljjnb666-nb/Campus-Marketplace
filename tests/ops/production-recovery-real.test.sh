#!/usr/bin/env bash
# Real, disposable PostgreSQL backup -> restore -> authentication invalidation
# proof. Runs only on the repository CI service database. The production restore
# script is executed unchanged, but its docker-compose adapter is redirected to
# a new scratch database with NO application/worker containers.
set -euo pipefail

if [[ "${CI:-}" != "true" ||
      "${DATABASE_URL:-}" != "postgresql://postgres:postgres@localhost:5432/campus?schema=public" ]]; then
  echo "[recovery-proof] REFUSED: requires the exact isolated verify CI datasource" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
real_docker="$(command -v docker)"
sandbox="$(mktemp -d)"
proof_db="campus_restore_proof_$(date +%s)_${RANDOM}"
[[ "${proof_db}" =~ ^campus_restore_proof_[0-9]+_[0-9]+$ ]] || exit 1
mkdir -p "${sandbox}/bin" "${sandbox}/backups"

pg() {
  "${real_docker}" run --rm --network host -i \
    -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGUSER=postgres \
    -e PGPASSWORD=postgres postgres:16-alpine "${@}"
}
psql_db() { pg psql -X -v ON_ERROR_STOP=1 -U postgres -d "${1}" "${@:2}"; }

cleanup() {
  if [[ "${proof_db}" =~ ^campus_restore_proof_[0-9]+_[0-9]+$ ]]; then
    psql_db postgres -c "DROP DATABASE IF EXISTS \"${proof_db}\" WITH (FORCE)" >/dev/null 2>&1 ||
      echo "[recovery-proof][WARN] isolated database cleanup failed" >&2
  fi
  rm -rf -- "${sandbox}"
}
trap cleanup EXIT

# The fake Compose adapter forwards actual psql/pg_restore to real postgres:16.
# No production containers, docker-compose project or shared database is touched.
cat > "${sandbox}/bin/docker" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
printf 'compose %s\n' "$*" >> "${PROOF_SANDBOX}/events.log"
if [[ " $* " == *" ps -q app "* ||
      " $* " == *" ps -q storage-cleanup "* ||
      " $* " == *" ps -q async-worker "* ]]; then
  exit 0
fi
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  if [[ "${args[i]}" == "postgres" && "${args[i-1]:-}" == "-T" ]]; then
    exec "${PROOF_REAL_DOCKER}" run --rm --network host -i \
      -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGUSER=postgres \
      -e PGPASSWORD=postgres postgres:16-alpine "${args[@]:i+1}"
  fi
done
echo "[recovery-proof] unexpected compose command (fail-closed)" >&2
exit 1
WRAPPER
chmod 700 "${sandbox}/bin/docker"

cat > "${sandbox}/.env.production" <<ENV
POSTGRES_USER=postgres
POSTGRES_DB=${proof_db}
POSTGRES_PASSWORD=postgres
BACKUP_DIR=${sandbox}/backups
ENV

psql_db postgres -c "CREATE DATABASE \"${proof_db}\"" >/dev/null
psql_db "${proof_db}" >/dev/null <<'FIXTURE'
CREATE TABLE "User" ("id" text PRIMARY KEY, "passwordHash" text NOT NULL, "credentialRecoveryRequired" boolean NOT NULL DEFAULT false);
CREATE TABLE "Product" ("id" text PRIMARY KEY, "sellerId" text NOT NULL);
CREATE TABLE "ErrandTask" ("id" text PRIMARY KEY);
CREATE TABLE "ServiceListing" ("id" text PRIMARY KEY);
CREATE TABLE "RentalListing" ("id" text PRIMARY KEY);
CREATE TABLE "Order" ("id" text PRIMARY KEY);
CREATE TABLE "Campus" ("id" text PRIMARY KEY);
CREATE TABLE "UploadedAsset" ("id" text PRIMARY KEY);
CREATE TABLE "_prisma_migrations" ("finished_at" timestamp);
CREATE TABLE "AccountSession" ("id" text PRIMARY KEY, "revokedAt" timestamp);
CREATE TABLE "AccountChallenge" ("id" text PRIMARY KEY, "consumedAt" timestamp);
INSERT INTO "User" ("id", "passwordHash") VALUES ('restored-user', 'T0_OBSOLETE_PASSWORD_HASH');
INSERT INTO "Product" VALUES ('restored-product', 'restored-user');
INSERT INTO "_prisma_migrations" VALUES (CURRENT_TIMESTAMP);
INSERT INTO "AccountSession" VALUES
 ('live-session', NULL), ('already-revoked', TIMESTAMP '2026-01-01 00:00:00');
INSERT INTO "AccountChallenge" VALUES
 ('live-challenge', NULL), ('already-consumed', TIMESTAMP '2026-01-01 00:00:00');
FIXTURE

pg pg_dump -Fc -U postgres -d "${proof_db}" > "${sandbox}/backups/proof.dump"
(
  cd "${sandbox}/backups"
  sha256sum proof.dump > proof.dump.sha256
)
# Mutate database after snapshot to prove a real backward restore occurs.
psql_db "${proof_db}" >/dev/null <<'MUTATE'
-- T1 password rotation happens AFTER backup, but T2 restore reintroduces T0.
UPDATE "User" SET "passwordHash" = 'T1_ROTATED_PASSWORD_HASH'
WHERE "id" = 'restored-user';
UPDATE "AccountSession" SET "revokedAt" = CURRENT_TIMESTAMP WHERE "revokedAt" IS NULL;
UPDATE "AccountChallenge" SET "consumedAt" = CURRENT_TIMESTAMP WHERE "consumedAt" IS NULL;
MUTATE

export PROOF_SANDBOX="${sandbox}" PROOF_REAL_DOCKER="${real_docker}"
OPS_PROJECT_DIR="${sandbox}" PATH="${sandbox}/bin:${PATH}" \
  bash "${repo_root}/scripts/ops/restore-production-postgres.sh" \
    --production-restore --backup-file "${sandbox}/backups/proof.dump" \
    --target-db "${proof_db}" > "${sandbox}/restore.log" 2>&1 || {
  # Never dump connection strings or DB contents on failure.
  echo "[recovery-proof][FAIL] actual pg_dump/pg_restore and authorization gate failed" >&2
  grep -E 'FAILED:|PRODUCTION RESTORE OK|无法|失效' "${sandbox}/restore.log" |
    sed -E 's/campus_restore_proof_[0-9]+_[0-9]+/[isolated-db]/g' >&2 || :
  exit 1
}

result="$(psql_db "${proof_db}" -tAc "
 SELECT (SELECT COUNT(*) FROM \"User\" WHERE id = 'restored-user'
           AND \"passwordHash\" = 'T0_OBSOLETE_PASSWORD_HASH'
           AND \"credentialRecoveryRequired\" = TRUE),
        (SELECT COUNT(*) FROM \"AccountSession\" WHERE \"revokedAt\" IS NULL),
        (SELECT COUNT(*) FROM \"AccountChallenge\" WHERE \"consumedAt\" IS NULL),
        (SELECT COUNT(*) FROM \"AccountSession\" WHERE id = 'already-revoked'
         AND \"revokedAt\" = TIMESTAMP '2026-01-01 00:00:00'),
        (SELECT COUNT(*) FROM \"AccountChallenge\" WHERE id = 'already-consumed'
         AND \"consumedAt\" = TIMESTAMP '2026-01-01 00:00:00');
")"
[[ "${result}" == "1|0|0|1|1" ]] || {
  echo "[recovery-proof][FAIL] restored data/invalidated credentials contract mismatched" >&2
  exit 1
}
grep -q 'pg_restore' "${sandbox}/events.log" || {
  echo "[recovery-proof][FAIL] actual pg_restore was not invoked" >&2; exit 1;
}
grep -q 'psql -X' "${sandbox}/events.log" || {
  echo "[recovery-proof][FAIL] security SQL was not invoked" >&2; exit 1;
}
echo "[recovery-proof] PASS: T0/T1 dump/restore + obsolete hash quarantined + sessions/challenges revoked + idempotence"
