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
# R3D02C04: immutable original canonical DomainEvent liquidity writer.
mkdir -p "$sandbox/r3d02/lib/analytics"
cp src/lib/analytics/liquidity-domain-events.ts "$sandbox/r3d02/lib/analytics/liquidity-domain-events.ts"
# R3D02C05B: exact original pure dispute/flag modules (not emulated).
for p in \
 feature-flags/feature-flag-registry.ts \
 disputes/dispute-scope.ts disputes/dispute-sla.ts \
 rental-dispute-eligibility.ts; do
 target="$sandbox/r3d02/lib/$p"
 mkdir -p "$(dirname "$target")"
 cp "src/lib/$p" "$target"
done
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
const codes=[...new Set([...raw.matchAll(/\b(?:R3D02C0[1-6][AB]?_[A-Z0-9_]+|DOMAIN_EVENT_[A-Z0-9_]+|LIQUIDITY_[A-Z0-9_]+|P[0-9]{4})\b/g)].map(m=>m[0]))].slice(0,8);
const categories={
 prisma:/PrismaClient(?:KnownRequest|Validation|Initialization)Error/.test(raw),
 import:/ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/.test(raw),
 timeout:/timed out|timeout/i.test(raw),
 syntax:/SyntaxError|Transform failed|Unexpected token/.test(raw),
 type:/TypeError/.test(raw),reference:/ReferenceError/.test(raw),
 domain:/DomainEvent|DOMAIN_EVENT/.test(raw),
 runtime:/Error:|error:|ERROR:/.test(raw),
 assertion:/R3D02C05B_|R3D02C05A_|R3D02C04_|R3D02C01_/.test(raw)
};
const frames=[...raw.matchAll(/(?:\/shadow\/r3d02\/)?([a-z0-9-]+\.(?:ts|js)):(\d+):(\d+)/gi)]
 .slice(0,5).map(x=>({file:x[1],line:Number(x[2]),column:Number(x[3])}));
const marker=[...raw.matchAll(/\[worker-cycle\] PASS (R3D02C0[1-6][AB]?) [^\r\n]+/g)]
 .slice(-8).map(x=>x[1]);
console.log("[worker-cycle] R3D02C01 sanitized runtime codes="+JSON.stringify(codes)+
 " categories="+JSON.stringify(categories)+
 " frames="+JSON.stringify(frames)+
 " priorMarkers="+JSON.stringify(marker));
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

# R3D02C02 must observe the new independent cross-actor concurrency proof.
grep -qF 'PASS R3D02C02 deterministic real PG renter CANCEL vs owner APPROVE/REJECT row-lock authority and CAS' \
 "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C02 approve/reject-vs-cancel serializability not proven' >&2
 exit 1
}
echo '[worker-cycle] PASS R3D02C02 rental cross-actor row-lock CAS verified against real Prisma7 PostgreSQL'

# R3D02C03 is independent and must fail closed if any original-return
# semantic assertion or real PG row-blocking experiment disappears.
grep -qF 'PASS R3D02C03 original renter request return, canonical notification and replay' "$tmp/r3d02c01-runtime.log" || {
  echo '[worker-cycle][FAIL] R3D02C03 required real-PG return safety proof missing' >&2
  exit 1
}
grep -qF 'PASS R3D02C03 rental return ACTIVE guard and no side effects' "$tmp/r3d02c01-runtime.log" || {
  echo '[worker-cycle][FAIL] R3D02C03 required real-PG return safety proof missing' >&2
  exit 1
}
grep -qF 'PASS R3D02C03 real PostgreSQL terminal row-lock wait and safe fresh status CAS' "$tmp/r3d02c01-runtime.log" || {
  echo '[worker-cycle][FAIL] R3D02C03 required real-PG return safety proof missing' >&2
  exit 1
}
grep -qF 'PASS R3D02C03 original return, status log and notification atomic rollback' "$tmp/r3d02c01-runtime.log" || {
  echo '[worker-cycle][FAIL] R3D02C03 required real-PG return safety proof missing' >&2
  exit 1
}
echo '[worker-cycle] PASS R3D02C03 original renter return request, CAS, guard, replay and rollback on Prisma7 PostgreSQL'
echo '[worker-cycle] LIMIT R3D02C03 terminal opponent is a controlled database writer, not full original confirmReturnTx/claims/dispute; no production v7 cutover proof'

# R3D02C04: every independent original confirm-return assertion is mandatory.
grep -qF 'PASS R3D02C04 authentic liquidity event/counter canonical writer import provenance' "$tmp/r3d02c01-prepare.log" || {
 echo '[worker-cycle][FAIL] R3D02C04 exact liquidity writer provenance missing' >&2; exit 1;
}
grep -qF 'PASS R3D02C04 real original owner completion with canonical ledger, deposit, counters and durable photo union' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C04 required original return evidence absent' >&2; exit 1;
}
grep -qF 'PASS R3D02C04 damaged return defers ledger and preserves owner inspection against late renter' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C04 required original return evidence absent' >&2; exit 1;
}
grep -qF 'PASS R3D02C04 return roles, cross-campus and inactive actor fail closed' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C04 required original return evidence absent' >&2; exit 1;
}
grep -qF 'PASS R3D02C04 real concurrent owner confirmations one winner and no duplicate liquidity facts' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C04 required original return evidence absent' >&2; exit 1;
}
grep -qF 'PASS R3D02C04 abort restores RentalOrder/ReturnRecord/StatusLog/DomainEvent/counters' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C04 required original return evidence absent' >&2; exit 1;
}
grep -qF 'PASS R3D02C04 real PG dispute row-lock stops stale owner completion and side effects' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C04 required original return evidence absent' >&2; exit 1;
}
echo '[worker-cycle] PASS R3D02C04 original confirmReturnTx, canonical liquidity events/projection, deposit, evidence and rollback via real v7 PG'
echo '[worker-cycle] LIMIT R3D02C04 owner-authoritative completion retained; claim/dispute writer interaction and production v7 cutover not fully verified'

# R3D02C05A: mandatory authentic damage-claim/dispute cross-actor PG proof.
grep -qF 'PASS R3D02C05A original claim submission, duplicate fence, tenant/role and canonical notification' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C05A canonical claim/dispute proof missing' >&2
 exit 1
}
grep -qF 'PASS R3D02C05A original agreed claim completed canonical ledger and counters once' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C05A canonical claim/dispute proof missing' >&2
 exit 1
}
grep -qF 'PASS R3D02C05A renter rejects claim, preserves deposit and canonical completion' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C05A canonical claim/dispute proof missing' >&2
 exit 1
}
grep -qF 'PASS R3D02C05A real dispute row-lock blocks stale original claim filing' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C05A canonical claim/dispute proof missing' >&2
 exit 1
}
grep -qF 'PASS R3D02C05A real dispute row-lock blocks stale response and liquidity facts' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C05A canonical claim/dispute proof missing' >&2
 exit 1
}
grep -qF 'PASS R3D02C05A claim and notification atomic rollback after forced error' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C05A canonical claim/dispute proof missing' >&2
 exit 1
}
echo '[worker-cycle] PASS R3D02C05A original claim response and dispute-competitor serialization on real Prisma7 PostgreSQL'
echo '[worker-cycle] LIMIT R3D02C05A disputed opponent is controlled DB writer; complete initiateDisputeTx workflow and payment/refund remain UNVERIFIED'

# R3D02C05B: all REAL original dispute-vs-claim proofs are mandatory.
grep -qF 'PASS R3D02C05B authentic dispute/governance/hold/feature-flag AST declaration provenance' "$tmp/r3d02c01-prepare.log" || {
 echo '[worker-cycle][FAIL] R3D02C05B original dispute/claim proof missing' >&2
 exit 1
}
grep -qF 'PASS R3D02C05B original dispute creates two canonical holds, scoped SLA, notification and blocks stale claim' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C05B original dispute/claim proof missing' >&2
 exit 1
}
grep -qF 'PASS R3D02C05B actual dispute races original claim response, blocks stale completion and ledger' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C05B original dispute/claim proof missing' >&2
 exit 1
}
grep -qF 'PASS R3D02C05B claim completion then original dispute preserves exactly-once ledger and holds' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C05B original dispute/claim proof missing' >&2
 exit 1
}
grep -qF 'PASS R3D02C05B authentic dispute, DataHold, notification and order rollback' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C05B original dispute/claim proof missing' >&2
 exit 1
}
echo '[worker-cycle] PASS R3D02C05B original full dispute/claim concurrency, canonical holds, ledger and rollback via real PostgreSQL'
echo '[worker-cycle] LIMIT R3D02C05B isolated Prisma7 authentic original functions only; production migration, payout/refund and full dispute-resolution workflow UNVERIFIED'

# R3D02C06A mandatory real original extension + peak SQL proof markers.
grep -qF 'PASS R3D02C06A original extension, price and peak-capacity SQL exact source AST' "$tmp/r3d02c01-prepare.log" || {
 echo '[worker-cycle][FAIL] R3D02C06A extension/price/capacity proof missing' >&2
 exit 1
}
grep -qF 'PASS R3D02C06A original rental extension request/approve fee, canonical notes, role, replay and immutable price snapshot' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C06A extension/price/capacity proof missing' >&2
 exit 1
}
grep -qF 'PASS R3D02C06A original reject extension retains order price, time and unique notification' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C06A extension/price/capacity proof missing' >&2
 exit 1
}
grep -qF 'PASS R3D02C06A concurrent original owner approve/reject single winner and no repeated accounting' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C06A extension/price/capacity proof missing' >&2
 exit 1
}
grep -qF 'PASS R3D02C06A original peak-capacity SQL rejects approval after conflicting order reserves stock, pending remains until rejection' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C06A extension/price/capacity proof missing' >&2
 exit 1
}
grep -qF 'PASS R3D02C06A original extension approval uses current locked max-duration policy, not request snapshot' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C06A extension/price/capacity proof missing' >&2
 exit 1
}
grep -qF 'PASS R3D02C06A original extension request + canonical event atomic rollback' "$tmp/r3d02c01-runtime.log" || {
 echo '[worker-cycle][FAIL] R3D02C06A extension/price/capacity proof missing' >&2
 exit 1
}
echo '[worker-cycle] PASS R3D02C06A real original extension request/approve/reject and peak-capacity SQL on Prisma7 PostgreSQL'
echo '[worker-cycle] LIMIT R3D02C06A no original rental creation competitor, gateway payment or production v7 cutover proof'
