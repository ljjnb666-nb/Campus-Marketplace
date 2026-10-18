#!/usr/bin/env bash
# R1G: deterministic, real UID1000 contenders against the exact same locked row.
# Sourced AFTER R1F; no production queue changes or external data.
r1g_holder_name="proof-r1g-h-$GITHUB_RUN_ID"
r1g_challenger_name="proof-r1g-c-$GITHUB_RUN_ID"
for name in "$r1g_holder_name" "$r1g_challenger_name"; do
  if docker container inspect "$name" >/dev/null 2>&1; then
    echo '[worker-cycle][FAIL] R1G container collision' >&2; exit 1
  fi
done
mkdir -m 755 "$tmp/proof-r1g-sync"
# Include original disposable isolated DB/network cleanup after test failure.
trap 'docker rm -f "$r1g_holder_name" "$r1g_challenger_name" "$probe" >/dev/null 2>&1 || true; cleanup' EXIT
docker exec -i "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" >/dev/null <<'SQL'
INSERT INTO "AsyncJob"
 ("id","kind","schemaVersion","dedupeKey","payload","status","runAt","createdAt","updatedAt")
VALUES ('proof-r1g-job','R1G_LOCK_ONLY_FIXTURE',1,'proof-r1g-locked-job',
 '{}'::jsonb,'PENDING',NOW()-INTERVAL '2 minutes',NOW(),NOW());
INSERT INTO "OutboxEvent"
 ("id","eventType","schemaVersion","aggregateType","aggregateId","dedupeKey",
  "payload","status","availableAt","createdAt","updatedAt")
VALUES ('proof-r1g-outbox','R1G_LOCK_ONLY_FIXTURE',1,'ORDER','proof-fence-order',
 'proof-r1g-locked-event','{}'::jsonb,'PENDING',NOW()-INTERVAL '2 minutes',NOW(),NOW());
SQL

r1g_container() {
  local name="$1" mode="$2"
  timeout --signal=TERM --kill-after=10s 90s docker run --rm \
    --name "$name" --network "$network" --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=32m \
    --cap-drop ALL --security-opt no-new-privileges \
    --mount "type=bind,src=$PWD/scripts/ops/worker-lock-contention-proof.ts,dst=/app/scripts/ops/worker-lock-contention-proof.ts,readonly" \
    --mount "type=bind,src=$tmp/proof-r1g-sync,dst=/tmp/proof-r1g-sync,readonly" \
    "${worker_env[@]}" \
    --entrypoint node "campus-marketplace-async-worker:$sha" \
    node_modules/tsx/dist/cli.mjs scripts/ops/worker-lock-contention-proof.ts "$mode"
}
for lane in job outbox; do
  # Holder writes its marker INSIDE an open transaction with the row lock.
  r1g_container "$r1g_holder_name" "hold-$lane" >"$tmp/r1g-hold-$lane.log" 2>&1 &
  r1g_holder_pid=$!
  r1g_held=0
  for i in $(seq 1 90); do
    if grep -qFx "PROOF_R1G_LOCK_HELD $lane" "$tmp/r1g-hold-$lane.log"; then
      r1g_held=1; break
    fi
    if ! kill -0 "$r1g_holder_pid" 2>/dev/null; then break; fi
    sleep 0.15
  done
  if [[ "$r1g_held" != 1 ]] || ! kill -0 "$r1g_holder_pid" 2>/dev/null; then
    echo "[worker-cycle][FAIL] R1G $lane holder failed before lock barrier" >&2; exit 1
  fi
  # Contender must finish BEFORE holder's transaction is released.
  if ! r1g_container "$r1g_challenger_name" "compete-$lane" >"$tmp/r1g-compete-$lane.log" 2>&1 ||
     ! grep -qFx "PROOF_R1G_SKIP_LOCKED $lane" "$tmp/r1g-compete-$lane.log"; then
    echo "[worker-cycle][FAIL] R1G $lane contender did not SKIP LOCKED" >&2; exit 1
  fi
  if ! kill -0 "$r1g_holder_pid" 2>/dev/null; then
    echo "[worker-cycle][FAIL] R1G $lane holder exited before contender returned" >&2; exit 1
  fi
  # Observer at READ COMMITTED cannot see A's uncommitted status/lease.
  if [[ "$lane" == job ]]; then
    r1g_before="$(docker exec "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" -Atc \
      "SELECT COUNT(*) FROM \"AsyncJob\" WHERE id='proof-r1g-job' AND status='PENDING' AND attempts=0 AND \"leaseToken\" IS NULL")"
  else
    r1g_before="$(docker exec "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" -Atc \
      "SELECT COUNT(*) FROM \"OutboxEvent\" WHERE id='proof-r1g-outbox' AND status='PENDING' AND attempts=0 AND \"leaseToken\" IS NULL")"
  fi
  [[ "$r1g_before" == 1 ]] || { echo "[worker-cycle][FAIL] R1G $lane dirty lock-state" >&2; exit 1; }
  touch "$tmp/proof-r1g-sync/release-$lane"
  if ! wait "$r1g_holder_pid" ||
     ! grep -qFx "PROOF_R1G_COMMITTED $lane" "$tmp/r1g-hold-$lane.log"; then
    echo "[worker-cycle][FAIL] R1G $lane holder failed commit" >&2; exit 1
  fi
  if ! r1g_container "$r1g_challenger_name" "after-$lane" >"$tmp/r1g-after-$lane.log" 2>&1 ||
     ! grep -qFx "PROOF_R1G_LEASE_STABLE $lane" "$tmp/r1g-after-$lane.log"; then
    echo "[worker-cycle][FAIL] R1G $lane duplicate claim or unstable winner" >&2; exit 1
  fi
  printf '[worker-cycle] PASS R1G real nonroot %s: held-row lock, skipped contender, single lease\n' "$lane"
done
