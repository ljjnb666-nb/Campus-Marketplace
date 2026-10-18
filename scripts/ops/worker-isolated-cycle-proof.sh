#!/usr/bin/env bash
# #157 R1B: actual isolated PostgreSQL + MinIO worker cycles, never production.
set -euo pipefail
if [[ $# -ne 1 || ! "$1" =~ ^[0-9a-f]{40}$ || -z "${GITHUB_RUN_ID:-}" ]]; then
  echo '[worker-cycle][FAIL] requires exact SHA and GitHub Actions run ID' >&2; exit 2
fi
sha="$1"; network="proof-net-${GITHUB_RUN_ID}"; pg="proof-pg-${GITHUB_RUN_ID}"
minio="proof-minio-${GITHUB_RUN_ID}"; database="proof_ci"
parallel_one="proof-async-a-${GITHUB_RUN_ID}"; parallel_two="proof-async-b-${GITHUB_RUN_ID}"
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
for name in "$pg" "$minio" "$parallel_one" "$parallel_two"; do
  if docker container inspect "$name" >/dev/null 2>&1; then
    echo '[worker-cycle][FAIL] refusing container collision' >&2; exit 1
  fi
done
if docker network inspect "$network" >/dev/null 2>&1; then
  echo '[worker-cycle][FAIL] refusing network collision' >&2; exit 1
fi

tmp="$(mktemp -d)"; made_net=0; made_pg=0; made_minio=0
cleanup() {
  # Including interrupted background real worker containers on failed assertions.
  docker rm -f "$parallel_one" "$parallel_two" >/dev/null 2>&1 || true
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

# R1C: controlled corrupt durable rows from the existing FAILCLOSED/LEASE
# integration contract. Isolated DB only; never production enqueue or user data.
docker exec -i "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" >/dev/null <<'SQL'
INSERT INTO "AsyncJob"
  ("id", "kind", "schemaVersion", "dedupeKey", "payload", "status", "runAt", "createdAt", "updatedAt")
VALUES ('proof-job-unknown', 'UNKNOWN_PROOF_KIND', 1, 'proof-r1c-job-unknown', '{}'::jsonb,
        'PENDING', NOW() - INTERVAL '1 minute', NOW(), NOW());
INSERT INTO "AsyncJob"
  ("id", "kind", "schemaVersion", "dedupeKey", "payload", "status", "runAt", "attempts",
   "leaseOwner", "leaseToken", "leaseExpiresAt", "createdAt", "updatedAt")
VALUES ('proof-job-stale', 'UNKNOWN_PROOF_KIND', 1, 'proof-r1c-job-stale', '{}'::jsonb,
        'RUNNING', NOW() - INTERVAL '2 minutes', 1,
        'proof-crashed-worker', 'proof-stale-job-token', NOW() - INTERVAL '1 minute', NOW(), NOW());
INSERT INTO "OutboxEvent"
  ("id", "eventType", "schemaVersion", "aggregateType", "aggregateId", "dedupeKey",
   "payload", "status", "availableAt", "createdAt", "updatedAt")
VALUES ('proof-event-unknown', 'UNKNOWN_PROOF_EVENT', 1, 'ORDER', 'proof-nonexistent-order',
        'proof-r1c-event-unknown', '{}'::jsonb, 'PENDING', NOW() - INTERVAL '1 minute', NOW(), NOW());
INSERT INTO "OutboxEvent"
  ("id", "eventType", "schemaVersion", "aggregateType", "aggregateId", "dedupeKey",
   "payload", "status", "availableAt", "attempts",
   "leaseOwner", "leaseToken", "leaseExpiresAt", "createdAt", "updatedAt")
VALUES ('proof-event-stale', 'UNKNOWN_PROOF_EVENT', 1, 'ORDER', 'proof-nonexistent-order',
        'proof-r1c-event-stale', '{}'::jsonb, 'PROCESSING', NOW() - INTERVAL '2 minutes', 1,
        'proof-crashed-dispatcher', 'proof-stale-event-token', NOW() - INTERVAL '1 minute', NOW(), NOW());
SQL

# Evaluate actual DB outcomes after running the exact image entrypoint.
# Expected: both PENDING rows claim once, both expired leases reclaim once,
# unknown handlers fail closed, no stale leaseToken retained after deadletter.
r1c_snapshot() {
  docker exec -i "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" -At <<'SQL'
SELECT
 (SELECT COUNT(*) FROM "AsyncJob"
  WHERE "id" IN ('proof-job-unknown','proof-job-stale')
    AND "status" = 'DEAD_LETTER'
    AND "lastErrorCode" = 'ASYNC_JOB_KIND_OR_SCHEMA_VERSION_UNKNOWN'
    AND "leaseToken" IS NULL
    AND (("id"='proof-job-unknown' AND "attempts"=1)
      OR ("id"='proof-job-stale' AND "attempts"=2)))
 +
 (SELECT COUNT(*) FROM "OutboxEvent"
  WHERE "id" IN ('proof-event-unknown','proof-event-stale')
    AND "status" = 'DEAD_LETTER'
    AND "lastErrorCode" = 'OUTBOX_EVENT_TYPE_OR_SCHEMA_VERSION_UNKNOWN'
    AND "leaseToken" IS NULL
    AND (("id"='proof-event-unknown' AND "attempts"=1)
      OR ("id"='proof-event-stale' AND "attempts"=2)));
SQL
}
run_worker async-fixtures "campus-marketplace-async-worker:${sha}" async_worker_started --run-once
first_snapshot="$(r1c_snapshot)"
if [[ "$first_snapshot" != 4 ]]; then
  echo '[worker-cycle][FAIL] AsyncJob/Outbox failclosed-lease contract count != 4' >&2
  exit 1
fi
# Replaying terminal rows must not re-run handlers or increment attempts.
run_worker async-replay "campus-marketplace-async-worker:${sha}" async_worker_started --run-once
if [[ "$(r1c_snapshot)" != 4 ]]; then
  echo '[worker-cycle][FAIL] terminal replay changed status, lease or attempts' >&2
  exit 1
fi
echo '[worker-cycle] PASS real nonroot AsyncJob/Outbox expired-lease/replay 4/4'

# R1D: valid PRODUCT reservation due on an isolated campus. Mirror the minimal
# fixture shape from WORKER-INT-01 in phase9a-async-core.test.ts: real User,
# membership, Product, Order, due canonical AsyncJob and transactionally
# materialized Outbox/Notifications by the real nonroot worker. No real people.
docker exec -i "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" >/dev/null <<'SQL'
INSERT INTO "Campus" ("id","name","slug","schoolName","createdAt","updatedAt")
VALUES ('proof-campus','Worker fixture campus','worker-proof-campus','Fixture campus',NOW(),NOW());
INSERT INTO "User" ("id","name","email","passwordHash","schoolName","campusId","createdAt","updatedAt")
VALUES
 ('proof-seller','Proof Seller','proof-seller@fixture.invalid','not-an-auth-password','Fixture campus','proof-campus',NOW(),NOW()),
 ('proof-buyer','Proof Buyer','proof-buyer@fixture.invalid','not-an-auth-password','Fixture campus','proof-campus',NOW(),NOW());
INSERT INTO "CampusMembership" ("id","userId","campusId","status","createdAt","updatedAt")
VALUES ('proof-seller-member','proof-seller','proof-campus','ACTIVE',NOW(),NOW()),
       ('proof-buyer-member','proof-buyer','proof-campus','ACTIVE',NOW(),NOW());
INSERT INTO "ProductCategory" ("id","name","slug","createdAt","updatedAt")
VALUES ('proof-category','Fixture product category','proof-product-category',NOW(),NOW());
INSERT INTO "Product"
 ("id","title","description","price","locationText","condition","status","sellerId","campusId","categoryId","createdAt","updatedAt")
VALUES
 ('proof-product','Isolated proof product','Disposable fixture',10.00,'Fixture gate','NEW','RESERVED',
  'proof-seller','proof-campus','proof-category',NOW(),NOW());
INSERT INTO "Order"
 ("id","orderNo","type","status","amount","buyerId","sellerId","productId",
  "productReservationExpiresAt","createdAt","updatedAt")
VALUES
 ('proof-order','PROOF-EXPIRE-ORDER','PRODUCT','PENDING',10.00,'proof-buyer','proof-seller','proof-product',
  NOW()-INTERVAL '2 minutes',NOW(),NOW());
INSERT INTO "AsyncJob"
 ("id","kind","schemaVersion","dedupeKey","payload","status","runAt","createdAt","updatedAt")
VALUES
 ('proof-expiry-job','PRODUCT_RESERVATION_EXPIRE',1,
  'PRODUCT_RESERVATION_EXPIRE:proof-order','{"orderId":"proof-order"}'::jsonb,
  'PENDING',NOW()-INTERVAL '2 minutes',NOW(),NOW());
SQL

valid_order_snapshot() {
  docker exec -i "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" -At <<'SQL'
SELECT
  (SELECT COUNT(*) FROM "Order"
   WHERE id='proof-order' AND "status"='CANCELLED'
     AND "productReservationResolution"='EXPIRED'
     AND "productReservationResolvedAt" IS NOT NULL)
  + (SELECT COUNT(*) FROM "Product"
     WHERE id='proof-product' AND "status"='ACTIVE')
  + (SELECT COUNT(*) FROM "AsyncJob"
     WHERE id='proof-expiry-job' AND "status"='COMPLETED' AND "attempts"=1
       AND "leaseToken" IS NULL AND "completedAt" IS NOT NULL)
  + (SELECT COUNT(*) FROM "OutboxEvent"
     WHERE "dedupeKey"='PRODUCT_RESERVATION_EXPIRED:proof-order'
       AND "status"='PUBLISHED' AND "publishedAt" IS NOT NULL)
  + (SELECT CASE WHEN
      (SELECT COUNT(*) FROM "Notification" n
       JOIN "OutboxEvent" e ON n."sourceEventId"=e.id
       WHERE n."orderId"='proof-order'
         AND e."dedupeKey"='PRODUCT_RESERVATION_EXPIRED:proof-order'
         AND n.title='商品预留已过期'
         AND n."dedupeKey"='OUTBOX:'||e.id||':IN_APP:'||n."userId"
         AND n."userId" IN ('proof-buyer','proof-seller'))=2
       AND (SELECT COUNT(*) FROM "Notification" WHERE "orderId"='proof-order')=2
       AND (SELECT COUNT(DISTINCT "userId") FROM "Notification"
            WHERE "orderId"='proof-order')=2 THEN 1 ELSE 0 END);
SQL
}
# Bounded synthetic DB diagnostics on failure only: only enum state labels and
# integer counts, not user identifiers, row payload, error strings, URLs/secrets.
valid_order_shape() {
  docker exec -i "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" -At <<'SQL'
SELECT
 COALESCE((SELECT "status"::text || ':' || COALESCE("productReservationResolution"::text,'NULL')
          FROM "Order" WHERE id='proof-order'),'MISSING') || '|' ||
 COALESCE((SELECT "status"::text FROM "Product" WHERE id='proof-product'),'MISSING') || '|' ||
 COALESCE((SELECT "status"::text || ':' || "attempts"::text
          FROM "AsyncJob" WHERE id='proof-expiry-job'),'MISSING') || '|' ||
 COALESCE((SELECT "status"::text FROM "OutboxEvent"
          WHERE "dedupeKey"='PRODUCT_RESERVATION_EXPIRED:proof-order'),'MISSING') || '|' ||
 (SELECT COUNT(*)::text FROM "Notification" WHERE "orderId"='proof-order');
SQL
}
# Phase 1: the production-mode worker deliberately starts with no EMAIL_PROVIDER.
# The order/Job must succeed, but EMAIL notification materialization is
# RETRYABLE (not DEAD_LETTER) and must publish zero incomplete notifications.
run_worker valid-expiry "campus-marketplace-async-worker:${sha}" async_worker_started --run-once
provider_missing="$(docker exec -i "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" -At <<'SQL'
SELECT CASE WHEN
  (SELECT COUNT(*) FROM "Order" WHERE id='proof-order'
    AND "status"='CANCELLED' AND "productReservationResolution"='EXPIRED')=1
  AND (SELECT COUNT(*) FROM "Product"
       WHERE id='proof-product' AND "status"='ACTIVE')=1
  AND (SELECT COUNT(*) FROM "AsyncJob"
       WHERE id='proof-expiry-job' AND "status"='COMPLETED' AND "attempts"=1)=1
  AND (SELECT COUNT(*) FROM "OutboxEvent"
       WHERE "dedupeKey"='PRODUCT_RESERVATION_EXPIRED:proof-order'
         AND "status"='PENDING' AND "attempts"=1
         AND "lastErrorCode"='EmailRuntimeConfigUnavailableError')=1
  AND (SELECT COUNT(*) FROM "Notification" WHERE "orderId"='proof-order')=0
THEN 1 ELSE 0 END;
SQL
)"
if [[ "$provider_missing" != 1 ]]; then
  printf '[worker-cycle][FAIL] email-config fail-closed contract, synthetic_shape=%s\n' "$(valid_order_shape)" >&2
  exit 1
fi
echo '[worker-cycle] PASS production-mode email missing: outbox retryable and zero premature notification'

# Phase 2: ONLY in this isolated no-real-email CI fixture, explicitly disable
# provider (supported by resolveEmailChannelConfig). This simulates recovery
# of the outbox materializer without contacting any external email provider.
# Advance only the retry clock field, not status/lease/attempts/business facts.
docker exec -i "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" >/dev/null <<'SQL'
UPDATE "OutboxEvent"
SET "availableAt"=NOW()-INTERVAL '1 second'
WHERE "dedupeKey"='PRODUCT_RESERVATION_EXPIRED:proof-order'
  AND "status"='PENDING' AND "attempts"=1;
SQL
worker_env+=(-e EMAIL_PROVIDER=disabled)
run_worker valid-expiry-recovery "campus-marketplace-async-worker:${sha}" async_worker_started --run-once
if [[ "$(valid_order_snapshot)" != 5 ]]; then
  printf '[worker-cycle][FAIL] valid expiry recovery still incomplete, synthetic_shape=%s\n' "$(valid_order_shape)" >&2
  exit 1
fi
safe_email_suppression="$(docker exec -i "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" -At <<'SQL'
SELECT CASE WHEN
  (SELECT COUNT(*) FROM "NotificationDelivery" d
   JOIN "Notification" n ON n.id=d."notificationId"
   WHERE n."orderId"='proof-order'
     AND d.channel='EMAIL' AND d.provider='disabled'
     AND d."suppressionCode"='PROVIDER_DISABLED' AND d."suppressedAt" IS NOT NULL)=2
  AND (SELECT COUNT(*) FROM "AsyncJob" WHERE kind='NOTIFICATION_DELIVERY')=0
  AND (SELECT COUNT(*) FROM "OutboxEvent"
       WHERE "dedupeKey"='PRODUCT_RESERVATION_EXPIRED:proof-order'
         AND "attempts"=2 AND "status"='PUBLISHED')=1
THEN 1 ELSE 0 END;
SQL
)"
if [[ "$safe_email_suppression" != 1 ]]; then
  echo '[worker-cycle][FAIL] disabled email must suppress both deliveries and enqueue no send jobs' >&2
  exit 1
fi
run_worker valid-expiry-replay "campus-marketplace-async-worker:${sha}" async_worker_started --run-once
if [[ "$(valid_order_snapshot)" != 5 ]]; then
  echo '[worker-cycle][FAIL] valid expiry replay changed canonical result or notifications' >&2
  exit 1
fi
echo '[worker-cycle] PASS real nonroot PRODUCT expiry -> PUBLISHED outbox + exactly two notifications, replay stable 5/5'

# R1E: launch TWO separate nonroot production-image worker processes against
# one canonical, already-due reservation. Verify durable end-to-end side effects
# remain single. Launch overlap is real; same-row contention is not guaranteed
# by a scheduler, so this is NOT a substitute for deterministic fencing tests.
docker exec -i "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" >/dev/null <<'SQL'
INSERT INTO "Product"
 ("id","title","description","price","locationText","condition","status","sellerId","campusId","categoryId","createdAt","updatedAt")
VALUES
 ('proof-parallel-product','Parallel worker fixture','Disposable isolated fixture',10.00,
  'Fixture gate','NEW','RESERVED','proof-seller','proof-campus','proof-category',NOW(),NOW());
INSERT INTO "Order"
 ("id","orderNo","type","status","amount","buyerId","sellerId","productId",
  "productReservationExpiresAt","createdAt","updatedAt")
VALUES
 ('proof-parallel-order','PROOF-PARALLEL-ORDER','PRODUCT','PENDING',10.00,
  'proof-buyer','proof-seller','proof-parallel-product',NOW()-INTERVAL '2 minutes',NOW(),NOW());
INSERT INTO "AsyncJob"
 ("id","kind","schemaVersion","dedupeKey","payload","status","runAt","createdAt","updatedAt")
VALUES
 ('proof-parallel-job','PRODUCT_RESERVATION_EXPIRE',1,
  'PRODUCT_RESERVATION_EXPIRE:proof-parallel-order',
  '{"orderId":"proof-parallel-order"}'::jsonb,
  'PENDING',NOW()-INTERVAL '2 minutes',NOW(),NOW());
SQL

# Two docker runs really start in parallel and use separate container names,
# host processes, logs and automatic cleanup. No --user override.
timeout --signal=TERM --kill-after=10s 180s docker run --rm --name "$parallel_one" \
  --network "$network" --cap-drop ALL --security-opt no-new-privileges \
  "${worker_env[@]}" "campus-marketplace-async-worker:${sha}" --run-once \
  >"$tmp/parallel-a.log" 2>&1 &
parallel_pid_a=$!
timeout --signal=TERM --kill-after=10s 180s docker run --rm --name "$parallel_two" \
  --network "$network" --cap-drop ALL --security-opt no-new-privileges \
  "${worker_env[@]}" "campus-marketplace-async-worker:${sha}" --run-once \
  >"$tmp/parallel-b.log" 2>&1 &
parallel_pid_b=$!
parallel_rc_a=0; parallel_rc_b=0
wait "$parallel_pid_a" || parallel_rc_a=$?
wait "$parallel_pid_b" || parallel_rc_b=$?
if [[ "$parallel_rc_a" != 0 || "$parallel_rc_b" != 0 ]]; then
  printf '[worker-cycle][FAIL] parallel worker process exits a=%s b=%s; safe event names:\n' \
    "$parallel_rc_a" "$parallel_rc_b" >&2
  for f in "$tmp/parallel-a.log" "$tmp/parallel-b.log"; do
    grep -oE '"event":"[a-zA-Z0-9_-]+"' "$f" | sort -u >&2 || true
  done
  exit 1
fi
for f in "$tmp/parallel-a.log" "$tmp/parallel-b.log"; do
  if ! grep -qF '"event":"async_worker_started"' "$f"; then
    echo '[worker-cycle][FAIL] parallel worker process missing startup event' >&2; exit 1
  fi
  if grep -qF '"event":"async_worker_cycle_failed"' "$f"; then
    echo '[worker-cycle][FAIL] parallel worker cycle failure event' >&2; exit 1
  fi
done
parallel_snapshot() {
  docker exec -i "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" -At <<'SQL'
SELECT
 (SELECT COUNT(*) FROM "Order" WHERE id='proof-parallel-order'
   AND "status"='CANCELLED' AND "productReservationResolution"='EXPIRED'
   AND "productReservationResolvedAt" IS NOT NULL)
 + (SELECT COUNT(*) FROM "Product"
    WHERE id='proof-parallel-product' AND "status"='ACTIVE')
 + (SELECT COUNT(*) FROM "AsyncJob"
    WHERE id='proof-parallel-job' AND "status"='COMPLETED'
      AND "attempts"=1 AND "leaseToken" IS NULL AND "completedAt" IS NOT NULL)
 + (SELECT CASE WHEN
    (SELECT COUNT(*) FROM "OutboxEvent" WHERE "aggregateId"='proof-parallel-order'
      AND "eventType"='PRODUCT_RESERVATION_EXPIRED')=1
    AND (SELECT COUNT(*) FROM "OutboxEvent"
         WHERE "dedupeKey"='PRODUCT_RESERVATION_EXPIRED:proof-parallel-order'
           AND "status"='PUBLISHED' AND "attempts"=1)=1
    THEN 1 ELSE 0 END)
 + (SELECT CASE WHEN
    (SELECT COUNT(*) FROM "Notification" n
     JOIN "OutboxEvent" e ON n."sourceEventId"=e.id
     WHERE n."orderId"='proof-parallel-order' AND n.title='商品预留已过期'
       AND e."dedupeKey"='PRODUCT_RESERVATION_EXPIRED:proof-parallel-order'
       AND n."dedupeKey"='OUTBOX:'||e.id||':IN_APP:'||n."userId"
       AND n."userId" IN ('proof-buyer','proof-seller'))=2
    AND (SELECT COUNT(*) FROM "Notification"
         WHERE "orderId"='proof-parallel-order')=2
    AND (SELECT COUNT(DISTINCT "userId") FROM "Notification"
         WHERE "orderId"='proof-parallel-order')=2
    THEN 1 ELSE 0 END)
 + (SELECT CASE WHEN
    (SELECT COUNT(*) FROM "NotificationDelivery" d
     JOIN "Notification" n ON n.id=d."notificationId"
     WHERE n."orderId"='proof-parallel-order' AND d.channel='EMAIL'
       AND d.provider='disabled' AND d."suppressionCode"='PROVIDER_DISABLED'
       AND d."suppressedAt" IS NOT NULL)=2
    THEN 1 ELSE 0 END);
SQL
}
if [[ "$(parallel_snapshot)" != 6 ]]; then
  echo '[worker-cycle][FAIL] parallel real container durable canonical snapshot != 6' >&2
  exit 1
fi
run_worker parallel-replay "campus-marketplace-async-worker:${sha}" async_worker_started --run-once
if [[ "$(parallel_snapshot)" != 6 ]]; then
  echo '[worker-cycle][FAIL] parallel replay altered idempotent durable snapshot' >&2
  exit 1
fi
echo '[worker-cycle] PASS two parallel nonroot image workers -> single job/outbox and two deduped notifications 6/6'

# R1F lives in a test-only extension and executes in this same isolated DB.
# Every nonzero probe/failed invariant aborts the mandatory image workflow.
source scripts/ops/worker-lease-fencing-extension.sh

# R1G: deterministic SAME-ROW PostgreSQL lock competition (job and outbox).
source scripts/ops/worker-lock-contention-extension.sh

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
# Prisma may reject during module initialization, before the main cycle handler.
# Accept only an explicit bounded Prisma connection-failure class or the worker
# cycle failure event. Never count an arbitrary nonzero Docker/Node exit as PASS.
started=0; cycle_failed=0; retention_failed=0; p1001=0; prisma_init=0; prisma_startup=0; refused=0; fatal=0
grep -qF '"event":"storage_cleanup_worker_started"' "$tmp/bad-db.log" && started=1 || true
grep -qF '"event":"storage_cleanup_cycle_failed"' "$tmp/bad-db.log" && cycle_failed=1 || true
grep -qF '"event":"phase9_retention_cycle_failed"' "$tmp/bad-db.log" && retention_failed=1 || true
grep -qF 'P1001' "$tmp/bad-db.log" && p1001=1 || true
grep -qF 'PrismaClientInitializationError' "$tmp/bad-db.log" && prisma_init=1 || true
# src/lib/prisma.ts explicitly runs $connect() at production startup and
# process.exit(1) on refusal, before the worker's cycle-level catch can log.
grep -qF '[prisma] 启动连接失败:' "$tmp/bad-db.log" && prisma_startup=1 || true
grep -qF 'ECONNREFUSED' "$tmp/bad-db.log" && refused=1 || true
grep -qF '[storage-cleanup-worker] fatal:' "$tmp/bad-db.log" && fatal=1 || true
printf '[worker-cycle] refused DB classification exit=%s started=%s cycle_failed=%s retention_failed=%s p1001=%s prisma_init=%s prisma_startup=%s refused=%s fatal=%s\n' \
  "$negative_rc" "$started" "$cycle_failed" "$retention_failed" "$p1001" "$prisma_init" "$prisma_startup" "$refused" "$fatal"
# Diagnostic on every negative result, including an unexpected FAIL. Output ONLY
# fixed event vocabulary and numeric categories; never print raw stdout/stderr,
# Prisma connection strings, synthetic passwords or stack frames.
for evidence in \
  storage_cleanup_worker_started \
  storage_cleanup_cycle_failed \
  phase9_retention_subtask_failed \
  phase9_retention_cycle_failed \
  storage_cleanup_cycle_completed \
  data_export_artifact_cleanup_failed; do
  observed=0
  grep -qF "\"event\":\"$evidence\"" "$tmp/bad-db.log" && observed=1 || true
  printf '[worker-cycle] NEG_EVENT name=%s observed=%s\n' "$evidence" "$observed"
done
for item in \
  PrismaClientKnownRequestError \
  PrismaClientUnknownRequestError \
  PrismaClientValidationError \
  PrismaClientRustPanicError \
  P1002 \
  P1017 \
  ENOTFOUND \
  EPIPE \
  EACCES \
  'docker: Error response from daemon' \
  'Error: ' \
  'UnhandledPromiseRejection' \
  'Node.js v' ; do
  seen=0
  grep -qF "$item" "$tmp/bad-db.log" && seen=1 || true
  case "$item" in
    *[[:space:]]*) printf '[worker-cycle] NEG_CATEGORY token=unstructured_error observed=%s\n' "$seen";;
    *) printf '[worker-cycle] NEG_CATEGORY token=%s observed=%s\n' "$item" "$seen";;
  esac
done
printf '[worker-cycle] NEG_COUNTS lines=%s bytes=%s\n' \
  "$(wc -l < "$tmp/bad-db.log" | tr -d ' ')" \
  "$(wc -c < "$tmp/bad-db.log" | tr -d ' ')"
# Local structural classification: reveal neither the log text nor its values.
# Counts/log shapes distinguish a process-level npx/tsx exit from JSON logger
# failures without publishing secrets, URLs, stack traces or arbitrary tokens.
if command -v node >/dev/null 2>&1; then
  node - "$tmp/bad-db.log" <<'SAFE_LOG_SHAPE'
const fs = require("node:fs");
const lines = fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/);
const counts = {
  json: 0, jsonError: 0, jsonInfo: 0, jsonWarn: 0,
  npmError: 0, npmNotice: 0, docker: 0,
  nodeRuntime: 0, prisma: 0, shell: 0, empty: 0, other: 0,
};
for (const raw of lines) {
  const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (!line) { counts.empty++; continue; }
  if (line.startsWith("{")) {
    try {
      const item = JSON.parse(line);
      if (item && typeof item === "object" && !Array.isArray(item)) {
        counts.json++;
        if (item.level === "error") counts.jsonError++;
        if (item.level === "info") counts.jsonInfo++;
        if (item.level === "warn") counts.jsonWarn++;
        continue;
      }
    } catch { /* unknown unstructured line, count only */ }
  }
  if (/^npm (?:error|ERR!)/i.test(line)) counts.npmError++;
  else if (/^npm notice/i.test(line)) counts.npmNotice++;
  else if (/^docker:/i.test(line)) counts.docker++;
  else if (/^(?:node:|Node\.js|internal\/)/i.test(line)) counts.nodeRuntime++;
  else if (/(?:PrismaClient|query engine|P10[0-9]{2})/i.test(line)) counts.prisma++;
  else if (/^(?:\/bin\/sh:|sh:|exec:)/i.test(line)) counts.shell++;
  else counts.other++;
}
for (const [label, count] of Object.entries(counts)) {
  console.log("[worker-cycle] NEG_SHAPE kind=" + label + " count=" + count);
}
SAFE_LOG_SHAPE
fi
if [[ "$started" -ne 1 || ( "$cycle_failed" -ne 1 && "$retention_failed" -ne 1 && "$p1001" -ne 1 && "$prisma_init" -ne 1 && "$prisma_startup" -ne 1 && "$refused" -ne 1 ) ]]; then
  echo '[worker-cycle][FAIL] refused-DB had no recognized connection error evidence' >&2
  exit 1
fi
echo '[worker-cycle] PASS refused-DB nonzero + classified connection failure; fixture lease/retry pending'
