#!/usr/bin/env bash
# Issue #157 R3D02C01: ORIGINAL rental order approval/reject/pickup/cancel.
# This is an isolated real Prisma7 Client + PostgreSQL adapter proof only.
set -euo pipefail
[[ "$sha" =~ ^[a-f0-9]{40}$ && -n "$sandbox" && -n "$network" &&
  -n "$shadow_db" && -n "$shadow_url" &&
  -f "$sandbox/r3d02/lib/governance/active-account-mutation.ts" &&
  -f "$sandbox/r3d02/lib/notifications/notification-service.ts" &&
  -f "$sandbox/generated/prisma/client.ts" ]] || {
 echo '[worker-cycle][FAIL] R3D02C01 requires authentic R3D02B02 shadow prerequisites' >&2
 exit 1
}
cp scripts/ops/prisma7-rental-core-prepare.cjs.txt "$sandbox/r3d02/rental-prepare.cjs"
cp scripts/ops/prisma7-rental-core-probe.ts.txt "$sandbox/r3d02/rental-core-probe.ts"
# Networkless extraction of the unmodified production TS function declarations.
if ! timeout --signal=TERM --kill-after=10s 55s docker run --rm \
 --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
 --user "$(id -u):$(id -g)" \
 --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=32m \
 --mount "type=bind,src=$sandbox,dst=/shadow" \
 --mount "type=bind,src=$PWD,dst=/source,readonly" \
 -e NODE_PATH=/app/node_modules \
 --entrypoint node "campus-marketplace-migrator:$sha" \
 /shadow/r3d02/rental-prepare.cjs \
 /source/src/lib/rental-order-machine.ts \
 /shadow/r3d02/rental-core-extracted.ts /shadow/r3d02/lib \
 >"$tmp/r3d02c01-prepare.log" 2>&1; then
 node - "$tmp/r3d02c01-prepare.log" <<'SAFE_PREP'
const fs=require("node:fs"),raw=fs.readFileSync(process.argv[2],"utf8");
const errors=[...new Set([...raw.matchAll(/\bR3D02C01_[A-Z0-9_]+\b/g)].map(m=>m[0]))].slice(0,6);
console.log("[worker-cycle] R3D02C01 sanitized prep codes="+JSON.stringify(errors)+
 " parser="+/SyntaxError|ParseError|Transform failed/.test(raw));
SAFE_PREP
 echo '[worker-cycle][FAIL] R3D02C01 original rental source AST extraction' >&2
 exit 1
fi
grep -qF 'PASS R3D02C01 exact original rental approval/pickup/cancel AST declarations' \
 "$tmp/r3d02c01-prepare.log" || {
 echo '[worker-cycle][FAIL] R3D02C01 original source provenance marker absent' >&2;exit 1;
}
# Exact image and pre-existing isolated 47-migration PG shadow, never prod.
if ! timeout --signal=TERM --kill-after=10s 195s docker run --rm \
 --network "$network" --read-only --cap-drop ALL \
 --security-opt no-new-privileges \
 --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=128m \
 --mount "type=bind,src=$sandbox,dst=/shadow,readonly" \
 --workdir /shadow \
 -e "DATABASE_URL=$shadow_url" -e "EXPECTED_SHADOW_DB=$shadow_db" \
 -e EMAIL_PROVIDER=disabled -e NODE_ENV=test \
 --entrypoint node "campus-marketplace-migrator:$sha" \
 /shadow/node_modules/tsx/dist/cli.mjs /shadow/r3d02/rental-core-probe.ts \
 >"$tmp/r3d02c01-runtime.log" 2>&1; then
 node - "$tmp/r3d02c01-runtime.log" <<'SAFE_RUNTIME'
const fs=require("node:fs"),raw=fs.readFileSync(process.argv[2],"utf8");
const codes=[...new Set([...raw.matchAll(/\b(?:R3D02C01_[A-Z0-9_]+|P[0-9]{4})\b/g)].map(m=>m[0]))].slice(0,8);
console.log("[worker-cycle] R3D02C01 sanitized runtime codes="+JSON.stringify(codes)+
 " prisma="+/PrismaClient(?:KnownRequest|Validation|Initialization)Error/.test(raw)+
 " import="+/ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/.test(raw)+
 " timeout="+/timed out|timeout/i.test(raw));
SAFE_RUNTIME
 echo '[worker-cycle][FAIL] R3D02C01 original rental real PostgreSQL probe' >&2
 exit 1
fi
for marker in \
 'PASS R3D02C01 original owner approve/reject canonical status log, IN_APP notification and privacy' \
 'PASS R3D02C01 original renter/owner/outsider/ACTIVE gates and cancellation replay' \
 'PASS R3D02C01 original owner governance locks serialize approve vs reject' \
 'PASS R3D02C01 original pickup two-party evidence, role and replay protection' \
 'PASS R3D02C01 real concurrent pickup vs cancel same row lock only one winner' \
 'PASS R3D02C01 real rollback of original RentalOrder/StatusLog/canonical Notification'; do
 grep -qF "$marker" "$tmp/r3d02c01-runtime.log" || {
  echo '[worker-cycle][FAIL] R3D02C01 required semantic marker absent' >&2
  exit 1
 }
done
echo '[worker-cycle] PASS R3D02C01 original rental approval/pickup/cancel via Prisma7 shadow PostgreSQL'
echo '[worker-cycle] LIMIT R3D02C01 does not cover rental creation, return, extension, damage, dispute, reviews, full module, notification dispatcher, production v7 cutover'
