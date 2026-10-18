#!/usr/bin/env bash
# #157 R1B: actual isolated PostgreSQL + MinIO worker cycles, never production.
set -euo pipefail
if [[ $# -ne 1 || ! "$1" =~ ^[0-9a-f]{40}$ || -z "${GITHUB_RUN_ID:-}" ]]; then
  echo '[worker-cycle][FAIL] requires exact SHA and GitHub Actions run ID' >&2; exit 2
fi
sha="$1"; network="proof-net-${GITHUB_RUN_ID}"; pg="proof-pg-${GITHUB_RUN_ID}"
minio="proof-minio-${GITHUB_RUN_ID}"; database="proof_ci"
pg_password="synthetic-pg-only"; root_user="proofroot"; root_password="synthetic-root-only"
s3_user="proofaccess"; s3_password="synthetic-s3-only"
db_url="postgresql://postgres:${pg_password}@${pg}:5432/${database}?schema=public"
s3_url="http://${minio}:9000"
mc="ghcr.io/ljjnb666-nb/mc@sha256:eb4ea9884b77704230e2423e9004d2fa738dc272876b9cc41a297d29443b8780"
minio_image="ghcr.io/ljjnb666-nb/minio@sha256:a1a8bd4ac40ad7881a245bab97323e18f971e4d4cba2c2007ec1bedd21cbaba2"
for item in "$mc" "$minio_image"; do
  if [[ ! "$item" =~ @sha256:[0-9a-f]{64}$ ]]; then
    echo '[worker-cycle][FAIL] invalid pinned image digest' >&2
    exit 2
  fi
done
for tool in docker timeout; do command -v "$tool" >/dev/null 2>&1 || exit 2; done
for image in "campus-marketplace-migrator:${sha}" "campus-marketplace-cleanup:${sha}" "campus-marketplace-async-worker:${sha}"; do
  docker image inspect "$image" >/dev/null 2>&1 || { echo '[worker-cycle][FAIL] candidate image missing' >&2; exit 1; }
done
for name in "$pg" "$minio"; do
  if docker container inspect "$name" >/dev/null 2>&1; then
    echo '[worker-cycle][FAIL] refusing container collision' >&2; exit 1
  fi
done
if docker network inspect "$network" >/dev/null 2>&1; then
  echo '[worker-cycle][FAIL] refusing network collision' >&2; exit 1
fi

tmp="$(mktemp -d)"; made_net=0; made_pg=0; made_minio=0
cleanup() {
  ((made_pg == 0)) || docker rm -f "$pg" >/dev/null 2>&1 || true
  ((made_minio == 0)) || docker rm -f "$minio" >/dev/null 2>&1 || true
  ((made_net == 0)) || docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
docker network create "$network" >/dev/null; made_net=1
docker run -d --name "$pg" --network "$network" -e POSTGRES_DB="$database" \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$pg_password" postgres:16-alpine >/dev/null; made_pg=1
docker run -d --name "$minio" --network "$network" \
  -e MINIO_ROOT_USER="$root_user" -e MINIO_ROOT_PASSWORD="$root_password" \
  "$minio_image" server /data --console-address ':9001' >/dev/null; made_minio=1
wait_pg=0
for i in $(seq 1 45); do
  if docker exec "$pg" pg_isready -U postgres -d "$database" >/dev/null 2>&1; then wait_pg=1; break; fi
  sleep 2
done
[[ "$wait_pg" == 1 ]] || { echo '[worker-cycle][FAIL] postgres readiness' >&2; exit 1; }
wait_s3=0
for i in $(seq 1 45); do
  if docker run --rm --network "$network" --entrypoint /bin/sh "$mc" -c \
    "mc alias set proof '$s3_url' '$root_user' '$root_password' >/dev/null 2>&1 && mc ready proof >/dev/null 2>&1"; then
    wait_s3=1; break
  fi
  sleep 2
done
[[ "$wait_s3" == 1 ]] || { echo '[worker-cycle][FAIL] minio readiness' >&2; exit 1; }
docker run --rm --network "$network" --entrypoint /bin/sh "$mc" -c \
  "set -e; mc alias set proof '$s3_url' '$root_user' '$root_password' >/dev/null; mc mb --ignore-existing proof/campus-public >/dev/null; mc mb --ignore-existing proof/campus-private >/dev/null; mc admin user add proof '$s3_user' '$s3_password' >/dev/null; mc admin policy attach proof readwrite --user '$s3_user' >/dev/null"
echo '[worker-cycle] PASS isolated PostgreSQL and MinIO initialized'

for pass in 1 2; do
  if ! timeout 180s docker run --rm --network "$network" -e DATABASE_URL="$db_url" \
    "campus-marketplace-migrator:${sha}" >"$tmp/migrate-${pass}.log" 2>&1; then
    printf '[worker-cycle][FAIL] migrate deploy pass=%s\n' "$pass" >&2; exit 1
  fi
done
n="$(docker exec "$pg" psql -U postgres -d "$database" -Atc \
  'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL' 2>/dev/null)"
[[ "$n" =~ ^[1-9][0-9]*$ ]] || { echo '[worker-cycle][FAIL] migrated schema absent' >&2; exit 1; }
printf '[worker-cycle] PASS real Prisma migrations initial+idempotent count=%s\n' "$n"

worker_env=(
  -e NODE_ENV=production -e NEXTAUTH_URL=http://probe.invalid
  -e NEXTAUTH_SECRET=synthetic-worker-secret
  -e DATABASE_URL="$db_url"
  -e S3_ENDPOINT="$s3_url" -e S3_REGION=us-east-1
  -e S3_ACCESS_KEY_ID="$s3_user" -e S3_SECRET_ACCESS_KEY="$s3_password"
  -e S3_BUCKET_PUBLIC=campus-public -e S3_BUCKET_PRIVATE=campus-private
  -e S3_FORCE_PATH_STYLE=true -e ASSET_CLEANUP_INTERVAL_SECONDS=1800
  -e ASYNC_WORKER_POLL_MS=1000 -e ASYNC_WORKER_BATCH_SIZE=5
  -e ASYNC_WORKER_LEASE_SECONDS=60 -e ASYNC_WORKER_SHUTDOWN_GRACE_MS=15000
)
run_worker() {
  local label="$1" image="$2" expected="$3"; shift 3
  # No --user override: actual image entrypoint must execute at UID=1000.
  if ! timeout --signal=TERM --kill-after=10s 180s docker run --rm \
    --network "$network" --cap-drop ALL --security-opt no-new-privileges \
    "${worker_env[@]}" "$image" "$@" >"$tmp/$label.log" 2>&1; then
    printf '[worker-cycle][FAIL] %s nonzero (safe event names only):\n' "$label" >&2
    grep -oE '"event":"[a-zA-Z0-9_-]+"' "$tmp/$label.log" | sort -u >&2 || true
    exit 1
  fi
  grep -qF "\"event\":\"$expected\"" "$tmp/$label.log" || {
    printf '[worker-cycle][FAIL] %s startup missing\n' "$label" >&2; exit 1;
  }
  if grep -Eq '"event":"(storage_cleanup_cycle_failed|async_worker_cycle_failed|phase9_retention_cycle_failed)"' "$tmp/$label.log"; then
    printf '[worker-cycle][FAIL] %s reports cycle failure\n' "$label" >&2; exit 1
  fi
  printf '[worker-cycle] PASS real DB/S3 run-once %s\n' "$label"
}
run_worker cleanup-dry "campus-marketplace-cleanup:${sha}" storage_cleanup_worker_started --run-once --dry-run
run_worker cleanup-write "campus-marketplace-cleanup:${sha}" storage_cleanup_worker_started --run-once
run_worker async-idle "campus-marketplace-async-worker:${sha}" async_worker_started --run-once
# Fail-closed negative gate: a broken database endpoint must not become SUCCESS.
set +e
timeout --signal=TERM --kill-after=10s 50s docker run --rm \
  --network "$network" --cap-drop ALL --security-opt no-new-privileges \
  "${worker_env[@]}" -e DATABASE_URL="postgresql://postgres:${pg_password}@${pg}:1/${database}?schema=public" \
  "campus-marketplace-cleanup:${sha}" --run-once >"$tmp/bad-db.log" 2>&1
negative_rc=$?
set -e
if [[ "$negative_rc" -eq 0 || "$negative_rc" -eq 124 || "$negative_rc" -eq 137 ]]; then
  printf '[worker-cycle][FAIL] refused-DB not a bounded application failure (exit=%s)\n' "$negative_rc" >&2
  exit 1
fi
if ! grep -qF '"event":"storage_cleanup_cycle_failed"' "$tmp/bad-db.log"; then
  echo '[worker-cycle][FAIL] refused-DB did not reach the worker cycle error path' >&2
  exit 1
fi
echo '[worker-cycle] PASS refused-DB negative gate (worker cycle error); domain-fixture lease/retry still pending'
