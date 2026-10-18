#!/usr/bin/env bash
# R1F: sourced ONLY by worker-isolated-cycle-proof.sh after R1E fixtures.
# Uses the existing isolated DB and real nonroot candidate image; no queue clone.
probe="proof-fence-probe-${GITHUB_RUN_ID}"
if docker container inspect "$probe" >/dev/null 2>&1; then
  echo '[worker-cycle][FAIL] fencing probe name collision' >&2; exit 1
fi
trap 'docker rm -f "$probe" >/dev/null 2>&1 || true; cleanup' EXIT
r1f_probe() {
  local mode="$1" expected_rc="$2" expected_marker="$3" rc=0
  timeout --signal=TERM --kill-after=10s 150s docker run --rm \
    --name "$probe" --network "$network" --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=32m \
    --cap-drop ALL --security-opt no-new-privileges \
    --mount "type=bind,src=$PWD/scripts/ops/worker-lease-fencing-proof.ts,dst=/app/scripts/ops/worker-lease-fencing-proof.ts,readonly" \
    "${worker_env[@]}" -e "PROOF_STALE_TOKEN=$stale_token" \
    --entrypoint node "campus-marketplace-async-worker:$sha" \
    node_modules/tsx/dist/cli.mjs scripts/ops/worker-lease-fencing-proof.ts "$mode" \
    >"$tmp/fence-$mode.log" 2>&1 || rc=$?
  if [[ "$rc" -ne "$expected_rc" ]] || ! grep -qFx "$expected_marker" "$tmp/fence-$mode.log"; then
    printf '[worker-cycle][FAIL] R1F mode=%s expected_rc=%s actual_rc=%s marker=%s\n' \
      "$mode" "$expected_rc" "$rc" "$(grep -qFx "$expected_marker" "$tmp/fence-$mode.log" && echo 1 || echo 0)" >&2
    exit 1
  fi
  printf '[worker-cycle] PASS R1F mode=%s expected_rc=%s\n' "$mode" "$rc"
}
# Fixture shape mirrors WORKER-INT-01; time-only advances are the sole direct
# post-fixture DB mutations. All claims/ownership/completion use production APIs.
docker exec -i "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" >/dev/null <<'SQL'
INSERT INTO "Product"
 ("id","title","description","price","locationText","condition","status","sellerId","campusId","categoryId","createdAt","updatedAt")
VALUES ('proof-fence-product','Lease proof','Isolated fixture',10.00,'Fixture gate','NEW','RESERVED',
 'proof-seller','proof-campus','proof-category',NOW(),NOW());
INSERT INTO "Order"
 ("id","orderNo","type","status","amount","buyerId","sellerId","productId",
 "productReservationExpiresAt","createdAt","updatedAt")
VALUES ('proof-fence-order','PROOF-FENCE-ORDER','PRODUCT','PENDING',10.00,
 'proof-buyer','proof-seller','proof-fence-product',NOW()-INTERVAL '2 minutes',NOW(),NOW());
INSERT INTO "AsyncJob"
 ("id","kind","schemaVersion","dedupeKey","payload","status","runAt","createdAt","updatedAt")
VALUES ('proof-fence-job','PRODUCT_RESERVATION_EXPIRE',1,
 'PRODUCT_RESERVATION_EXPIRE:proof-fence-order',
 '{"orderId":"proof-fence-order"}'::jsonb,'PENDING',NOW()-INTERVAL '2 minutes',NOW(),NOW());
SQL
stale_token=""
r1f_probe claim-a 0 'PROOF_PASS job-claim'
stale_token="$(docker exec "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" -Atc \
  "SELECT \"leaseToken\" FROM \"AsyncJob\" WHERE id='proof-fence-job' AND \"leaseOwner\"='proof-fence-A' AND attempts=1")"
[[ "$stale_token" =~ ^[0-9a-f-]{36}$ ]] || { echo '[worker-cycle][FAIL] first lease absent' >&2; exit 1; }
advance_job="$(docker exec "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" -Atc \
  "UPDATE \"AsyncJob\" SET \"leaseExpiresAt\"=NOW()-INTERVAL '1 second' WHERE id='proof-fence-job' AND status='RUNNING' AND \"leaseOwner\"='proof-fence-A'")"
[[ "$advance_job" == 'UPDATE 1' ]] || { echo '[worker-cycle][FAIL] job clock advance rejected' >&2; exit 1; }
r1f_probe reclaim-b 0 'PROOF_PASS job-claim'
r1f_probe stale-a 0 'PROOF_PASS stale-execution-completion-fenced'
stale_token=""
# Intentional exit(77) from the existing §70 AFTER-DOMAIN-COMMIT seam, before
# completion marker; real candidate image + real database + production runner.
r1f_probe crash-b 77 'PROOF_CRASH_AFTER_DOMAIN_COMMIT'
pre="$(docker exec "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" -Atc "$(cat <<'SQL'
SELECT CASE WHEN
 (SELECT COUNT(*) FROM "Order" WHERE id='proof-fence-order' AND status='CANCELLED'
   AND "productReservationResolution"='EXPIRED')=1
 AND (SELECT COUNT(*) FROM "Product" WHERE id='proof-fence-product' AND status='ACTIVE')=1
 AND (SELECT COUNT(*) FROM "AsyncJob" WHERE id='proof-fence-job'
   AND status='RUNNING' AND attempts=2 AND "leaseOwner"='proof-fence-B'
   AND "leaseToken" IS NOT NULL AND "completedAt" IS NULL)=1
 AND (SELECT COUNT(*) FROM "OutboxEvent"
   WHERE "dedupeKey"='PRODUCT_RESERVATION_EXPIRED:proof-fence-order' AND status='PENDING')=1
 AND (SELECT COUNT(*) FROM "Notification" WHERE "orderId"='proof-fence-order')=0
 THEN 1 ELSE 0 END;
SQL
)")"
[[ "$pre" == 1 ]] || { echo '[worker-cycle][FAIL] crash boundary durable state invalid' >&2; exit 1; }

r1f_probe outbox-a 0 'PROOF_PASS outbox-claim'
stale_token="$(docker exec "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" -Atc \
  "SELECT \"leaseToken\" FROM \"OutboxEvent\" WHERE \"dedupeKey\"='PRODUCT_RESERVATION_EXPIRED:proof-fence-order' AND \"leaseOwner\"='proof-outbox-A' AND attempts=1")"
[[ "$stale_token" =~ ^[0-9a-f-]{36}$ ]] || { echo '[worker-cycle][FAIL] first outbox lease absent' >&2; exit 1; }
advance_outbox="$(docker exec "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" -Atc \
  "UPDATE \"OutboxEvent\" SET \"leaseExpiresAt\"=NOW()-INTERVAL '1 second' WHERE \"dedupeKey\"='PRODUCT_RESERVATION_EXPIRED:proof-fence-order' AND status='PROCESSING' AND \"leaseOwner\"='proof-outbox-A'")"
[[ "$advance_outbox" == 'UPDATE 1' ]] || { echo '[worker-cycle][FAIL] outbox clock advance rejected' >&2; exit 1; }
r1f_probe outbox-b 0 'PROOF_PASS outbox-claim'
r1f_probe outbox-stale-a 0 'PROOF_PASS stale-outbox-fenced'
stale_token=""
# Reclaim after the real crash: only advance lease expiration clocks.
advance_job="$(docker exec "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" -Atc \
  "UPDATE \"AsyncJob\" SET \"leaseExpiresAt\"=NOW()-INTERVAL '1 second' WHERE id='proof-fence-job' AND status='RUNNING' AND \"leaseOwner\"='proof-fence-B'")"
advance_outbox="$(docker exec "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" -Atc \
  "UPDATE \"OutboxEvent\" SET \"leaseExpiresAt\"=NOW()-INTERVAL '1 second' WHERE \"dedupeKey\"='PRODUCT_RESERVATION_EXPIRED:proof-fence-order' AND status='PROCESSING' AND \"leaseOwner\"='proof-outbox-B'")"
[[ "$advance_job" == 'UPDATE 1' && "$advance_outbox" == 'UPDATE 1' ]] || {
  echo '[worker-cycle][FAIL] recovery clock advance rejected' >&2; exit 1;
}
r1f_snapshot() {
  docker exec "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" -Atc "$(cat <<'SQL'
SELECT CASE WHEN
 (SELECT COUNT(*) FROM "Order" WHERE id='proof-fence-order' AND status='CANCELLED'
   AND "productReservationResolution"='EXPIRED' AND "productReservationResolvedAt" IS NOT NULL)=1
 AND (SELECT COUNT(*) FROM "Product" WHERE id='proof-fence-product' AND status='ACTIVE')=1
 AND (SELECT COUNT(*) FROM "AsyncJob" WHERE id='proof-fence-job' AND status='COMPLETED'
   AND attempts=3 AND "leaseToken" IS NULL AND "leaseOwner" IS NULL
   AND "completedAt" IS NOT NULL)=1
 AND (SELECT COUNT(*) FROM "OutboxEvent" WHERE "aggregateId"='proof-fence-order'
   AND "eventType"='PRODUCT_RESERVATION_EXPIRED')=1
 AND (SELECT COUNT(*) FROM "OutboxEvent"
   WHERE "dedupeKey"='PRODUCT_RESERVATION_EXPIRED:proof-fence-order'
   AND status='PUBLISHED' AND attempts=3 AND "leaseToken" IS NULL)=1
 AND (SELECT COUNT(*) FROM "Notification" n JOIN "OutboxEvent" e
   ON n."sourceEventId"=e.id WHERE n."orderId"='proof-fence-order'
   AND n."dedupeKey"='OUTBOX:'||e.id||':IN_APP:'||n."userId")=2
 AND (SELECT COUNT(*) FROM "Notification" WHERE "orderId"='proof-fence-order')=2
 AND (SELECT COUNT(DISTINCT "userId") FROM "Notification" WHERE "orderId"='proof-fence-order')=2
 AND (SELECT COUNT(*) FROM "NotificationDelivery" d JOIN "Notification" n
   ON d."notificationId"=n.id WHERE n."orderId"='proof-fence-order'
   AND d.channel='EMAIL' AND d.provider='disabled'
   AND d."suppressionCode"='PROVIDER_DISABLED' AND d."suppressedAt" IS NOT NULL)=2
 THEN 1 ELSE 0 END;
SQL
)"
}
run_worker fence-crash-replay "campus-marketplace-async-worker:$sha" async_worker_started --run-once
[[ "$(r1f_snapshot)" == 1 ]] || { echo '[worker-cycle][FAIL] crash recovery snapshot invalid' >&2; exit 1; }
run_worker fence-terminal-replay "campus-marketplace-async-worker:$sha" async_worker_started --run-once
[[ "$(r1f_snapshot)" == 1 ]] || { echo '[worker-cycle][FAIL] replay duplicated side effects' >&2; exit 1; }
echo '[worker-cycle] PASS R1F stale job/outbox lease fencing, crash-after-COMMIT and recovery without duplicate effects'
