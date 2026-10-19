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
cp scripts/ops/prisma7-canonical-writer-relocate.cjs.txt "$sandbox/r3d02/relocate.cjs"
cp scripts/ops/prisma7-canonical-writer-probe.ts.txt "$sandbox/r3d02/probe.ts"
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
 # Do not stream raw registry/SQL stack traces or connection strings.
 # Only bounded machine code and boolean categories are exposed.
 node - "$tmp/r3d02-probe.log" <<'CLASSIFY_R3D02A'
const fs=require("node:fs");
const raw=fs.readFileSync(process.argv[2],"utf8");
const codes=[...raw.matchAll(/\b(?:R3D02A_[A-Z0-9_]+|DOMAIN_EVENT_[A-Z0-9_]+|OUTBOX_EVENT_[A-Z0-9_]+|P[0-9]{4}|ERR_[A-Z0-9_]+)\b/g)].map(m=>m[0]);
const categories={
 module:/ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/i.test(raw),
 syntax:/SyntaxError|Unexpected token|Transform failed/i.test(raw),
 prisma:/PrismaClientKnownRequestError|PrismaClientValidationError|PrismaClientInitializationError/i.test(raw),
 runtime:/TypeError|ReferenceError/i.test(raw),
 pool:/timeout|timed out|pool timeout/i.test(raw),
 registry:/INTENT_CONTRACT_INVALID|UNKNOWN_EVENT_TYPE|UNKNOWN_CONTRACT/i.test(raw)
};
// Parse-only diagnostics contain no DB URL, SQL payload, or arbitrary log lines.
// Limit to a known shadow source basename and numeric line/column.
const diagnostics=[...raw.matchAll(/(?:\/shadow\/)?(?:r3d02\/)?(?:lib\/)?([a-z0-9-]+\.tsx?):(\d+):(\d+):\s*ERROR:/gi)].slice(0,4).map(m=>({
 file:m[1],line:Number(m[2]),column:Number(m[3])
}));
console.log("[worker-cycle] R3D02A sanitized machineCodes="+
 JSON.stringify([...new Set(codes)].slice(0,6))+
 " categories="+JSON.stringify(categories)+
 " sourceLocations="+JSON.stringify(diagnostics)+
 " logLines="+raw.split(/\r?\n/).length);
CLASSIFY_R3D02A
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
