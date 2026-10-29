#!/usr/bin/env bash
# Sourced by image-runtime.test.sh after migrating an isolated PostgreSQL DB.
# Two *real*, non-root, precompiled CJS workers compete for the same durable
# AsyncJob/Outbox rows; only database facts are used as acceptance evidence.
# It does not assert deterministic scheduler overlap on the same row; the
# repository's advisory/lease concurrency integration suite covers that.
[[ -n "${NAME:-}" && -n "${TEMP_DIR:-}" && -n "${PREFIX:-}" && -n "${TAG:-}" ]] || {
  echo '[worker-concurrent][FAIL] must be invoked from isolated image proof' >&2
  exit 1
}
db_exec() {
  docker exec -i "${NAME}-db" psql -X -v ON_ERROR_STOP=1 -U proof -d proofdb "${@}"
}

db_exec >/dev/null <<'SQL'
INSERT INTO "AsyncJob"
  ("id","kind","schemaVersion","dedupeKey","payload","status","runAt","createdAt","updatedAt")
VALUES
  ('proof-concurrent-job','UNKNOWN_PROOF_KIND',1,'proof-concurrent-job-key','{}'::jsonb,
   'PENDING',NOW()-INTERVAL '1 minute',NOW(),NOW());
INSERT INTO "AsyncJob"
  ("id","kind","schemaVersion","dedupeKey","payload","status","runAt","attempts",
   "leaseOwner","leaseToken","leaseExpiresAt","createdAt","updatedAt")
VALUES
  ('proof-concurrent-stale-job','UNKNOWN_PROOF_KIND',1,'proof-concurrent-stale-key','{}'::jsonb,
   'RUNNING',NOW()-INTERVAL '2 minutes',1,'proof-crashed-worker','proof-stale-token',
   NOW()-INTERVAL '1 minute',NOW(),NOW());
INSERT INTO "OutboxEvent"
  ("id","eventType","schemaVersion","aggregateType","aggregateId","dedupeKey",
   "payload","status","availableAt","createdAt","updatedAt")
VALUES
  ('proof-concurrent-event','UNKNOWN_PROOF_EVENT',1,'ORDER','proof-nonexistent-order',
   'proof-concurrent-event-key','{}'::jsonb,'PENDING',NOW()-INTERVAL '1 minute',NOW(),NOW());
INSERT INTO "OutboxEvent"
  ("id","eventType","schemaVersion","aggregateType","aggregateId","dedupeKey",
   "payload","status","availableAt","attempts","leaseOwner","leaseToken",
   "leaseExpiresAt","createdAt","updatedAt")
VALUES
  ('proof-concurrent-stale-event','UNKNOWN_PROOF_EVENT',1,'ORDER','proof-nonexistent-order',
   'proof-concurrent-stale-event-key','{}'::jsonb,'PROCESSING',NOW()-INTERVAL '2 minutes',1,
   'proof-crashed-dispatcher','proof-stale-event-token',NOW()-INTERVAL '1 minute',NOW(),NOW());
SQL

snapshot() {
  db_exec -At <<'SQL'
SELECT
  (SELECT COUNT(*) FROM "AsyncJob"
   WHERE "id" IN ('proof-concurrent-job','proof-concurrent-stale-job')
     AND "status"='DEAD_LETTER'
     AND "lastErrorCode"='ASYNC_JOB_KIND_OR_SCHEMA_VERSION_UNKNOWN'
     AND "leaseToken" IS NULL
     AND (("id"='proof-concurrent-job' AND "attempts"=1)
       OR ("id"='proof-concurrent-stale-job' AND "attempts"=2)))
  +
  (SELECT COUNT(*) FROM "OutboxEvent"
   WHERE "id" IN ('proof-concurrent-event','proof-concurrent-stale-event')
     AND "status"='DEAD_LETTER'
     AND "lastErrorCode"='OUTBOX_EVENT_TYPE_OR_SCHEMA_VERSION_UNKNOWN'
     AND "leaseToken" IS NULL
     AND (("id"='proof-concurrent-event' AND "attempts"=1)
       OR ("id"='proof-concurrent-stale-event' AND "attempts"=2)));
SQL
}
worker_run() {
  local label="$1"
  timeout --signal=TERM --kill-after=10s 150s docker run --rm --pull never \
    --name "${NAME}-async-${label}" --network "${NAME}" \
    --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --cap-drop ALL --security-opt no-new-privileges \
    "${ENV_ARGS[@]}" -e EMAIL_PROVIDER=disabled \
    "${PREFIX}-async:${TAG}" --run-once > "${TEMP_DIR}/concurrent-${label}" 2>&1
}
worker_run a &
pid_a=$!
worker_run b &
pid_b=$!
rc_a=0
rc_b=0
wait "$pid_a" || rc_a=$?
wait "$pid_b" || rc_b=$?
if [[ "$rc_a" -ne 0 || "$rc_b" -ne 0 ]]; then
  echo "[worker-concurrent][FAIL] real worker processes failed exit_a=${rc_a} exit_b=${rc_b}" >&2
  exit 1
fi
for label in a b; do
  grep -qF '"event":"async_worker_started"' "${TEMP_DIR}/concurrent-${label}" || {
    echo '[worker-concurrent][FAIL] missing real worker startup event' >&2; exit 1;
  }
  if grep -qF '"event":"async_worker_cycle_failed"' "${TEMP_DIR}/concurrent-${label}"; then
    echo '[worker-concurrent][FAIL] worker cycle failure' >&2; exit 1;
  fi
done
[[ "$(snapshot)" == 4 ]] || {
  echo '[worker-concurrent][FAIL] expired lease / dead-letter count or attempts mismatch' >&2; exit 1;
}
PASS=$((PASS+1))

# Restart/replay must not claim terminal events again.
docker run --rm --pull never --network "${NAME}" --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL \
  --security-opt no-new-privileges "${ENV_ARGS[@]}" -e EMAIL_PROVIDER=disabled \
  "${PREFIX}-async:${TAG}" --run-once > "${TEMP_DIR}/concurrent-replay" 2>&1
grep -qF '"event":"async_worker_started"' "${TEMP_DIR}/concurrent-replay"
[[ "$(snapshot)" == 4 ]] || {
  echo '[worker-concurrent][FAIL] replay altered durable dead-letter/lease state' >&2; exit 1;
}
PASS=$((PASS+1))
echo '[worker-concurrent] PASS real concurrent CJS worker containers: 4/4 dead-letter and stable terminal replay'
