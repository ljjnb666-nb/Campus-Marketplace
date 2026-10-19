#!/usr/bin/env bash
# Issue #157 R3D02B01: direct production function AST declarations + actual
# governance lock/capability/outbox source, on disposable Prisma7 shadow DB.
# R3D02A canonical writer test is prerequisite and remains mandatory.
set -euo pipefail
[[ "$sha" =~ ^[0-9a-f]{40}$ && -n "$sandbox" && -n "$network" &&
  -n "$shadow_db" && -n "$shadow_url" &&
  -f "$sandbox/r3d02/lib/async/outbox.ts" ]] || {
  echo '[worker-cycle][FAIL] R3D02B01 canonical writer/DB preconditions missing' >&2; exit 1;
}
mkdir -p "$sandbox/r3d02/lib/governance" "$sandbox/r3d02/lib/enforcement" "$sandbox/r3d02/lib/rbac"
for path in \
 src/lib/governance/governance-lock.ts \
 src/lib/enforcement/capability-gate.ts \
 src/lib/enforcement/errors.ts \
 src/lib/enforcement/risk-scope.ts \
 src/lib/metrics.ts \
 src/lib/rbac/errors.ts \
 src/lib/rbac/roles.ts \
 src/lib/rbac/permissions.ts \
 src/lib/product-reservation.ts; do
  mkdir -p "$sandbox/r3d02/lib/$(dirname "$(printf '%s' "$path" | cut -c 9-)")"
  cp "$path" "$sandbox/r3d02/lib/$(printf '%s' "$path" | cut -c 9-)"
done
cp scripts/ops/prisma7-product-expiry-prepare.cjs.txt "$sandbox/r3d02/prepare.cjs"
cp scripts/ops/prisma7-product-expiry-probe.ts.txt "$sandbox/r3d02/product-expiry-probe.ts"
# Governance helper's unused withTransaction import still resolves to a real
# adapter-based shadow transaction; do not stub, monkeypatch, or skip locks.
cat >>"$sandbox/r3d02/lib/prisma.ts" <<'SHADOW_TRANSACTION_R3D02B'
export const withTransaction = <T>(fn: (tx: any) => Promise<T>): Promise<T> =>
  prisma.$transaction(fn);
SHADOW_TRANSACTION_R3D02B
# Only temporary sandbox is writable; production source mounted readonly.
# AST extraction runs inside the exact Node24 migrator image with its actual
# TypeScript dependency via NODE_PATH. No network or DB credentials.
if ! timeout --signal=TERM --kill-after=10s 50s docker run --rm \
  --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=32m \
  --mount "type=bind,src=$sandbox,dst=/shadow" \
  --mount "type=bind,src=$PWD,dst=/source,readonly" \
  -e NODE_PATH=/app/node_modules \
  --entrypoint node "campus-marketplace-migrator:$sha" \
  /shadow/r3d02/prepare.cjs \
  /source/src/lib/product-order-lifecycle.ts \
  /shadow/r3d02/product-expiry-extracted.ts /shadow/r3d02/lib \
  >"$tmp/r3d02b-prepare.log" 2>&1; then
  echo '[worker-cycle][FAIL] R3D02B01 production function AST source extraction or import closure' >&2; exit 1;
fi
grep -qF 'PASS R3D02B01 exact lifecycle AST bodies and reversible policy import relocation' \
  "$tmp/r3d02b-prepare.log" || {
  echo '[worker-cycle][FAIL] R3D02B01 AST provenance marker missing' >&2; exit 1;
}
# Execute against ONLY the pre-existing, R3A/R3B/R3C/R3D01 validated
# disposable shadow DB. Sandbox mounted readonly; no image or production write.
if ! timeout --signal=TERM --kill-after=10s 140s docker run --rm \
  --network "$network" --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=128m \
  --mount "type=bind,src=$sandbox,dst=/shadow,readonly" \
  --workdir /shadow \
  -e "DATABASE_URL=$shadow_url" -e "EXPECTED_SHADOW_DB=$shadow_db" \
  --entrypoint node "campus-marketplace-migrator:$sha" \
  /shadow/node_modules/tsx/dist/cli.mjs /shadow/r3d02/product-expiry-probe.ts \
  >"$tmp/r3d02b-runtime.log" 2>&1; then
  echo '[worker-cycle][FAIL] R3D02B01 authentic product reservation expiry v7 shadow transaction proof' >&2; exit 1;
fi
for marker in \
 'PASS R3D02B01 authentic expiry commits with restricted seller OFFLINE and exactly one canonical outbox' \
 'PASS R3D02B01 real capability recheck releases eligible seller listing ACTIVE' \
 'PASS R3D02B01 pre-deadline no mutation or outbox' \
 'PASS R3D02B01 authentic governance-lock order-row CAS race produces one expiry' \
 'PASS R3D02B01 original expiry Order/Product/Outbox all roll back after forced abort'; do
  grep -qF "$marker" "$tmp/r3d02b-runtime.log" || {
    echo '[worker-cycle][FAIL] R3D02B01 exact behavioral marker missing' >&2; exit 1;
  }
done
echo '[worker-cycle] PASS R3D02B01 authentic PRODUCT expiry via original AST bodies + real governance/capability/outbox on v7 shadow'
echo '[worker-cycle] LIMIT R3D02B01 extracts function declarations; full product module initialization, actor accept/cancel and rental lifecycle not yet validated'

# R3D02B02 independently loads authentic actor functions after expiry passes.
source scripts/ops/prisma7-product-actor-shadow-extension.sh
