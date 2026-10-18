#!/usr/bin/env bash
# R3D-02A: authentic production canonical writers against an isolated v7 shadow.
set -euo pipefail
[[ "$sha" =~ ^[0-9a-f]{40}$ && -f "$sandbox/generated/prisma/client.ts" &&
  -n "$shadow_url" && -n "$shadow_db" && -n "$network" ]] || {
 echo '[worker-cycle][FAIL] R3D02A prerequisites' >&2; exit 1;
}
mkdir -p "$sandbox/r3d02/lib"
for path in \
 src/lib/domain-events/domain-event.ts \
 src/lib/domain-events/domain-event-registry.ts \
 src/lib/domain-events/domain-event-ledger-extension.ts \
 src/lib/async/outbox.ts \
 src/lib/async/outbox-event-registry.ts \
 src/lib/async/job-repository.ts \
 src/lib/async/job-types.ts \
 src/lib/async/backoff.ts \
 src/lib/analytics/projection-contract.ts; do
 target="$sandbox/r3d02/lib/$(printf '%s' "$path" | cut -c 9-)"
 mkdir -p "$(dirname "$target")"
 cp "$path" "$target"
done
cp scripts/ops/prisma7-canonical-writer-relocate.cjs "$sandbox/r3d02/relocate.cjs"
cp scripts/ops/prisma7-canonical-writer-probe.ts "$sandbox/r3d02/probe.ts"
cat >"$sandbox/r3d02/lib/prisma.ts" <<'SHADOW'
import { PrismaClient } from "../../generated/prisma/client.ts";
import { PrismaPg } from "@prisma/adapter-pg";
const url=process.env.DATABASE_URL!;
if(new URL(url).pathname!=="/"+process.env.EXPECTED_SHADOW_DB)
 throw Error("R3D02A_SHADOW_REQUIRED");
export const prisma=new PrismaClient({adapter:new PrismaPg({
 connectionString:url,max:2,connectionTimeoutMillis:1200
})});
SHADOW
node "$sandbox/r3d02/relocate.cjs" "$sandbox/r3d02/lib" >"$tmp/r3d02-relocate.log" 2>&1 || {
 echo '[worker-cycle][FAIL] R3D02A original source import relocation' >&2; exit 1;
}
# Unrelated claim functions import a Prisma singleton; in this shadow-only
# module graph it is the REAL v7 client bound to this disposable database.
# The canonical writers under test all receive the caller's explicit tx.

if ! timeout --signal=TERM --kill-after=10s 120s docker run --rm \
 --network "$network" --read-only --cap-drop ALL --security-opt no-new-privileges \
 --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=128m \
 --mount "type=bind,src=$sandbox,dst=/shadow,readonly" \
 --workdir /shadow \
 -e "DATABASE_URL=$shadow_url" -e "EXPECTED_SHADOW_DB=$shadow_db" \
 --entrypoint node "campus-marketplace-migrator:$sha" \
 /shadow/node_modules/tsx/dist/cli.mjs /shadow/r3d02/probe.ts \
 >"$tmp/r3d02-probe.log" 2>&1; then
 echo '[worker-cycle][FAIL] R3D02A canonical writer live shadow test' >&2; exit 1;
fi
for marker in \
 'PASS R3D02A canonical domain event with projection job and collision fence' \
 'PASS R3D02A strict domain/outbox registry rejects malformed intents' \
 'PASS R3D02A canonical outbox atomic reservation expiry and replay dedupe' \
 'PASS R3D02A multi-writer Order/DomainEvent/Outbox/AsyncJob rollback'; do
 grep -qF "$marker" "$tmp/r3d02-probe.log" || {
   echo '[worker-cycle][FAIL] R3D02A semantic marker absent' >&2; exit 1;
 }
done
echo '[worker-cycle] PASS R3D02A authentic domain/outbox/job writers against Prisma7 shadow with registry and atomicity'
echo '[worker-cycle] LIMIT R3D02A does not yet import the production order/rental lifecycle or notification dispatcher'
