#!/usr/bin/env bash
# #157 R3D02B02: real original actor accept/cancel, lock-time authorization,
# concurrent transactions, canonical notification/outbox and rollback on v7 PG.
set -euo pipefail
[[ "$sha" =~ ^[0-9a-f]{40}$ && -n "$sandbox" && -n "$shadow_db" &&
   -n "$shadow_url" && -n "$network" &&
   -f "$sandbox/r3d02/product-expiry-extracted.ts" &&
   -f "$sandbox/r3d02/lib/governance/governance-lock.ts" &&
   -f "$sandbox/r3d02/lib/async/outbox.ts" &&
   -f "$sandbox/generated/prisma/client.ts" ]] || {
  echo '[worker-cycle][FAIL] R3D02B02 requires completed original expiry and v7 canonical writers' >&2
  exit 1
}
for p in \
 governance/active-account-mutation.ts rbac/service.ts \
 notifications/notification-service.ts notifications/notification-registry.ts \
 notifications/notification-delivery.ts notifications/email-config.ts \
 notifications/email-contract.ts notifications/email-escape.ts \
 logger.ts request-context.ts request-id.ts; do
  target="$sandbox/r3d02/lib/$p"
  mkdir -p "$(dirname "$target")"
  cp "src/lib/$p" "$target"
done
cp scripts/ops/prisma7-product-actor-prepare.cjs.txt "$sandbox/r3d02/actor-prepare.cjs"
cp scripts/ops/prisma7-product-actor-probe.ts.txt "$sandbox/r3d02/product-actor-probe.ts"
# NO network/DB creds during original production declaration extraction.
if ! timeout --signal=TERM --kill-after=10s 55s docker run --rm \
  --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=32m \
  --mount "type=bind,src=$sandbox,dst=/shadow" \
  --mount "type=bind,src=$PWD,dst=/source,readonly" \
  -e NODE_PATH=/app/node_modules \
  --entrypoint node "campus-marketplace-migrator:$sha" \
  /shadow/r3d02/actor-prepare.cjs \
  /source/src/lib/product-order-lifecycle.ts \
  /shadow/r3d02/product-actor-extracted.ts /shadow/r3d02/lib \
  >"$tmp/r3d02b02-prepare.log" 2>&1; then
  echo '[worker-cycle][FAIL] R3D02B02 original actor AST/dependency provenance' >&2
  exit 1
fi
grep -qF 'PASS R3D02B02 exact production actor AST functions and reversible authentic dependencies' \
 "$tmp/r3d02b02-prepare.log" || {
  echo '[worker-cycle][FAIL] R3D02B02 original provenance marker missing' >&2
  exit 1
}
# Same R3A-owned isolated PostgreSQL database as R3D02A/B01; immutable sandbox
# and exact-HEAD container; never mount real credentials, write to production, or
# fabricate safety-marker success on process failure.
if ! timeout --signal=TERM --kill-after=10s 175s docker run --rm \
  --network "$network" --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=128m \
  --mount "type=bind,src=$sandbox,dst=/shadow,readonly" \
  --workdir /shadow \
  -e "DATABASE_URL=$shadow_url" -e "EXPECTED_SHADOW_DB=$shadow_db" \
  -e EMAIL_PROVIDER=disabled -e NODE_ENV=test \
  --entrypoint node "campus-marketplace-migrator:$sha" \
  /shadow/node_modules/tsx/dist/cli.mjs /shadow/r3d02/product-actor-probe.ts \
  >"$tmp/r3d02b02-runtime.log" 2>&1; then
  # Keep exact raw diagnostics on transient CI host only, avoid publishing tokens/SQL.
  node - "$tmp/r3d02b02-runtime.log" <<'SAFE_FAILURE_CLASS'
const fs=require("node:fs");
const raw=fs.readFileSync(process.argv[2],"utf8");
const codes=[...raw.matchAll(/\b(?:R3D02B02_[A-Z0-9_]+|AUTH_[A-Z0-9_]+|NOTIFICATION_[A-Z0-9_]+|P[0-9]{4})\b/g)]
 .map(m=>m[0]).slice(0,6);
console.log("[worker-cycle] R3D02B02 sanitized codes="+JSON.stringify([...new Set(codes)])+
 " prisma="+/PrismaClient(?:KnownRequest|Validation|Initialization)Error/.test(raw)+
 " import="+/ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/.test(raw)+
 " timeout="+/timeout|timed out/i.test(raw));
SAFE_FAILURE_CLASS
  echo '[worker-cycle][FAIL] R3D02B02 authentic actor transaction shadow probe' >&2
  exit 1
fi
for marker in \
 'PASS R3D02B02 original seller accept and canonical dual notifications are idempotent' \
 'PASS R3D02B02 buyer/seller cancel, capability projection and canonical replay safety' \
 'PASS R3D02B02 original active-account lock-time denial, role and candidate/tenant fences' \
 'PASS R3D02B02 late accept/cancel share original EXPIRED canonical Outbox without direct notifications' \
 'PASS R3D02B02 concurrent authentic accept/cancel serialize to one winner and two notification intents' \
 'PASS R3D02B02 actor mutation, Product and canonical Notification fully roll back on forced abort'; do
  grep -qF "$marker" "$tmp/r3d02b02-runtime.log" || {
   echo '[worker-cycle][FAIL] R3D02B02 required behavior absent' >&2
   exit 1
  }
done
echo '[worker-cycle] PASS R3D02B02 original PRODUCT actor accept/cancel and real v7 PostgreSQL dependencies'
echo '[worker-cycle] LIMIT R3D02B02 tests AST-selected original entry functions; full module load, materializer dispatch, rental R3D02C, production v7 cutover NOT VERIFIED'
