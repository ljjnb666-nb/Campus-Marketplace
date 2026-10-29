#!/usr/bin/env bash
# Real business flow adapted from PR #161's validated worker-isolated-cycle proof.
# Uses existing isolated PostgreSQL/MinIO services and *compiled CJS* images
# built from exact PR HEAD. No production network or real mail provider.
# Sourced after image-runtime.test.sh migrator and worker-concurrent proof.
[[ -n "${NAME:-}" && -n "${TEMP_DIR:-}" && -n "${PREFIX:-}" && -n "${TAG:-}" ]] || {
  echo '[worker-business][FAIL] requires isolated image proof setup' >&2; exit 1;
}
pg="${NAME}-db"
database=proofdb
tmp="${TEMP_DIR}"
# Explicitly inject an invalid sender while choosing the real 'resend' mode.
# Docker --env-file sets valid synthetic email values; a bare '-e NAME' does not
# reliably erase those values. This is a deterministic production config error,
# detected during transaction materialization BEFORE any provider HTTP call.
worker_env=("${ENV_ARGS[@]}" -e EMAIL_PROVIDER=resend -e EMAIL_FROM=not-an-email)
run_worker() {
  local label="$1" image="$2" expected="$3"; shift 3
  if ! timeout --signal=TERM --kill-after=10s 150s docker run --rm --pull never \
    --network "${NAME}" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --cap-drop ALL --security-opt no-new-privileges \
    "${worker_env[@]}" "$image" "$@" > "${tmp}/business-${label}.log" 2>&1; then
    printf '[worker-business][FAIL] %s nonzero (safe event names only)\n' "$label" >&2
    grep -oE '"event":"[a-zA-Z0-9_-]+"' "${tmp}/business-${label}.log" | sort -u >&2 || true
    exit 1
  fi
  grep -qF "\"event\":\"$expected\"" "${tmp}/business-${label}.log" || {
    echo "[worker-business][FAIL] missing startup event for $label" >&2; exit 1;
  }
  if grep -Eq '"event":"(storage_cleanup_cycle_failed|async_worker_cycle_failed)"' "${tmp}/business-${label}.log"; then
    echo "[worker-business][FAIL] worker cycle failed for $label" >&2; exit 1;
  fi
}

docker exec -i "$pg" psql -v ON_ERROR_STOP=1 -U proof -d "$database" >/dev/null <<'SQL'
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
  docker exec -i "$pg" psql -v ON_ERROR_STOP=1 -U proof -d "$database" -At <<'SQL'
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
  docker exec -i "$pg" psql -v ON_ERROR_STOP=1 -U proof -d "$database" -At <<'SQL'
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
# Phase 1: the production-mode worker deliberately receives invalid EMAIL_FROM.
# The order/Job must succeed, but EMAIL notification materialization is
# RETRYABLE (not DEAD_LETTER) and must publish zero incomplete notifications.
run_worker valid-expiry "${PREFIX}-async:${TAG}" async_worker_started --run-once
provider_missing="$(docker exec -i "$pg" psql -v ON_ERROR_STOP=1 -U proof -d "$database" -At <<'SQL'
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
docker exec -i "$pg" psql -v ON_ERROR_STOP=1 -U proof -d "$database" >/dev/null <<'SQL'
UPDATE "OutboxEvent"
SET "availableAt"=NOW()-INTERVAL '1 second'
WHERE "dedupeKey"='PRODUCT_RESERVATION_EXPIRED:proof-order'
  AND "status"='PENDING' AND "attempts"=1;
SQL
worker_env=("${ENV_ARGS[@]}" -e EMAIL_PROVIDER=disabled)
run_worker valid-expiry-recovery "${PREFIX}-async:${TAG}" async_worker_started --run-once
if [[ "$(valid_order_snapshot)" != 5 ]]; then
  printf '[worker-cycle][FAIL] valid expiry recovery still incomplete, synthetic_shape=%s\n' "$(valid_order_shape)" >&2
  exit 1
fi
safe_email_suppression="$(docker exec -i "$pg" psql -v ON_ERROR_STOP=1 -U proof -d "$database" -At <<'SQL'
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
run_worker valid-expiry-replay "${PREFIX}-async:${TAG}" async_worker_started --run-once
if [[ "$(valid_order_snapshot)" != 5 ]]; then
  echo '[worker-cycle][FAIL] valid expiry replay changed canonical result or notifications' >&2
  exit 1
fi
echo '[worker-cycle] PASS real nonroot PRODUCT expiry -> PUBLISHED outbox + exactly two notifications, replay stable 5/5'
PASS=$((PASS+1))
echo '[worker-business] PASS canonical order cancellation, product release, published outbox, two notifications and stable replay'
