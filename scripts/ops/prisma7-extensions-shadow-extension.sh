#!/usr/bin/env bash
# Issue #157 R3C: shadow-only execution of the real project's soft-delete and
# append-only ledger extension source with Prisma 7's generated client.
# This is NOT a production v7 migration or a tenant-authorization test.
set -euo pipefail
[[ "${sha:-}" =~ ^[0-9a-f]{40}$ && -n "${sandbox:-}" &&
   -f "${sandbox:-/missing}/generated/prisma/client.ts" &&
   -n "${shadow_db:-}" && -n "${shadow_url:-}" &&
   -n "${network:-}" && -n "${tmp:-}" ]] || {
  echo '[worker-cycle][FAIL] R3C shadow v7 client prerequisites missing' >&2; exit 1;
}
mkdir -p "$sandbox/r3c"
cp src/lib/prisma-soft-delete.ts "$sandbox/r3c/prisma-soft-delete.ts"
cp src/lib/domain-events/domain-event-ledger-extension.ts "$sandbox/r3c/domain-event-ledger-extension.ts"
# Import relocation ONLY. All extension logic stays byte-for-byte identical to
# production; no local shim/reimplementation that could give false confidence.
node - "$sandbox/r3c/prisma-soft-delete.ts" \
  "$sandbox/r3c/domain-event-ledger-extension.ts" <<'RELOCATE_R3C'
const fs = require("node:fs");
for (const file of process.argv.slice(2)) {
  const original = fs.readFileSync(file, "utf8");
  const needle = 'import { Prisma } from "@prisma/client";';
  if (original.split(needle).length !== 2 || original.includes("../generated/prisma/client.ts")) {
    console.error("[worker-cycle][FAIL] R3C original extension import drift");
    process.exit(1);
  }
  const relocated = original.replace(needle,
    'import { Prisma } from "../generated/prisma/client.ts";');
  if (relocated.replace('import { Prisma } from "../generated/prisma/client.ts";', needle) !== original) {
    console.error("[worker-cycle][FAIL] R3C unexpected source mutation");
    process.exit(1);
  }
  fs.writeFileSync(file, relocated);
}
RELOCATE_R3C
cat > "$sandbox/r3c-probe.ts" <<'PROBE_R3C'
import { PrismaClient } from "./generated/prisma/client.ts";
import { PrismaPg } from "@prisma/adapter-pg";
import { softDeleteExtension } from "./r3c/prisma-soft-delete.ts";
import { domainEventLedgerExtension } from "./r3c/domain-event-ledger-extension.ts";

function assert(value: unknown, code: string): asserts value {
  if (!value) throw new Error("R3C_" + code);
}
const url = process.env.DATABASE_URL!;
const expectedDb = process.env.EXPECTED_SHADOW_DB!;
assert(new URL(url).pathname === "/" + expectedDb, "OUTSIDE_SHADOW_DATABASE");
const base = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: url, max: 3,
    connectionTimeoutMillis: 1500, idleTimeoutMillis: 10_000
  }),
  log: ["error"]
});
const prisma = base.$extends(softDeleteExtension).$extends(domainEventLedgerExtension);
const id = {
  campusA: "r3c-campus-a", campusB: "r3c-campus-b",
  activeA: "r3c-active-a", deletedA: "r3c-deleted-a", activeB: "r3c-active-b",
  eventA: "r3c-event-commit", eventRollback: "r3c-event-rollback",
  otherCampus: "r3c-rollback-campus"
};
const event = (idValue: string, occurrenceKey: string) => ({
  id: idValue, eventType: "R3C_ISOLATED_PROOF", schemaVersion: 1,
  aggregateType: "USER", aggregateId: id.activeA, campusId: id.campusA,
  occurrenceKey, payload: { version: 1, proof: true }, occurredAt: new Date(),
});
const expectedRejection = async (
  operation: () => Promise<unknown>, code: string
) => {
  let rejected = false;
  try {
    await operation();
  } catch (err) {
    rejected = !!err && typeof err === "object" && "code" in err &&
      (err as {code: unknown}).code === code;
  }
  assert(rejected, "WRONG_REJECTION_" + code);
};

try {
  await base.$connect();
  for (const [campusId, suffix] of [[id.campusA,"a"],[id.campusB,"b"]] as const) {
    await base.campus.create({
      data: { id: campusId, name: "R3C "+suffix,
        slug: "r3c-"+suffix, schoolName: "isolated.example.invalid" }
    });
  }
  const user = async (userId: string, campusId: string, deleted: boolean) =>
    base.user.create({ data: {
      id: userId, name: userId, email: userId+"@example.invalid",
      passwordHash: "synthetic-not-a-real-credential",
      schoolName: "isolated.example.invalid", campusId,
      ...(deleted ? { deletedAt: new Date("2026-01-01T00:00:00Z") } : {})
    }});
  await user(id.activeA, id.campusA, false);
  await user(id.deletedA, id.campusA, true);
  await user(id.activeB, id.campusB, false);

  const active = await prisma.user.findMany({
    where: { campusId: id.campusA }, select: { id: true }
  });
  assert(active.length === 1 && active[0]?.id === id.activeA,
    "SOFT_DELETE_LIST_OR_TENANT_SCOPE");
  const unique = await prisma.user.findUnique({
    where: { id: id.deletedA }, select: { id: true }
  });
  assert(unique === null,"SOFT_DELETE_UNIQUE_SELECT_BYPASS");
  const uniqueActive = await prisma.user.findUnique({
    where: { id: id.activeA }, select: { id: true }
  });
  assert(uniqueActive?.id === id.activeA &&
    !Object.prototype.hasOwnProperty.call(uniqueActive, "deletedAt"),
    "UNIQUE_SELECT_SHAPE_LEAK");
  const omit = await prisma.user.findUnique({
    where: { id: id.deletedA }, omit: { deletedAt: true }
  });
  assert(omit === null,"SOFT_DELETE_UNIQUE_OMIT_BYPASS");
  await expectedRejection(
    () => prisma.user.findUniqueOrThrow({
      where: { id: id.deletedA }, select: { id: true }
    }), "P2025");
  const explicit = await prisma.user.findMany({
    where: { campusId: id.campusA, OR: [{deletedAt:{not:null}}] },
    select: { id: true }
  });
  assert(explicit.length === 1 && explicit[0]?.id === id.deletedA,
    "EXPLICIT_DELETED_FILTER_IGNORED");
  const counted = await prisma.user.count({
    where: { campusId: id.campusA }
  });
  assert(counted === 1,"SOFT_DELETE_COUNT");
  await expectedRejection(
    () => prisma.user.delete({where: {id:id.deletedA}}),
    "SOFT_DELETE_EXPLICIT_DOMAIN_MUTATION_REQUIRED");
  await expectedRejection(
    () => prisma.user.deleteMany({where:{campusId:id.campusA,deletedAt:{not:null}}}),
    "SOFT_DELETE_EXPLICIT_DOMAIN_MUTATION_REQUIRED");
  assert(await base.user.count({where:{campusId:id.campusA}}) === 2,
    "SOFT_DELETE_PHYSICAL_MUTATION");
  console.log("[worker-cycle] PASS R3C original soft-delete source list/unique/select/omit/count/explicit-filter/failclosed");

  const inside = await prisma.$transaction(async tx => {
    const attempt = await tx.user.updateMany({
      where: { id: id.activeB, campusId: id.campusA }, data: { bio: "forbidden" }
    });
    assert(attempt.count === 0,"CROSS_TENANT_WHERE_OVERRIDDEN");
    const hidden = await tx.user.updateMany({
      where: { id: id.deletedA, campusId:id.campusA }, data: { bio: "hidden" }
    });
    assert(hidden.count === 0,"TX_SOFT_DELETE_MUTATION_BYPASS");
    const visible = await tx.user.findMany({
      where: {campusId:id.campusB},select:{id:true}
    });
    assert(visible.length === 1 && visible[0]?.id === id.activeB,
      "TX_TENANT_SCOPED_READ");
    return visible.length;
  }, {timeout:6000,maxWait:3000});
  assert(inside === 1,"TX_RESULT");
  assert((await base.user.findUnique({where:{id:id.activeB}}))?.bio === null,
    "CROSS_TENANT_WRITE");
  console.log("[worker-cycle] PASS R3C scoped campus predicates and soft-delete inside interactive transaction");

  await prisma.domainEvent.create({
    data: event(id.eventA,"r3c-occurrence-commit")
  });
  const forbidden: [string, () => Promise<unknown>][] = [
    ["update", () => prisma.domainEvent.update({
      where:{id:id.eventA},data:{eventType:"ILLEGAL"}})],
    ["updateMany", () => prisma.domainEvent.updateMany({
      where:{id:id.eventA},data:{eventType:"ILLEGAL"}})],
    ["delete", () => prisma.domainEvent.delete({where:{id:id.eventA}})],
    ["deleteMany", () => prisma.domainEvent.deleteMany({where:{id:id.eventA}})],
    ["upsert", () => prisma.domainEvent.upsert({
      where:{id:id.eventA},update:{eventType:"ILLEGAL"},
      create:event("r3c-upsert-bypass","r3c-occurrence-upsert")
    })],
  ];
  for (const [,action] of forbidden) {
    await expectedRejection(action,"DOMAIN_EVENT_APPEND_ONLY");
  }
  assert((await base.domainEvent.findUnique({
    where:{id:id.eventA},select:{eventType:true}
  }))?.eventType === "R3C_ISOLATED_PROOF", "LEDGER_WAS_CHANGED");
  assert(await base.domainEvent.count() === 1,"LEDGER_INSERTED_EXTRA_ROW");
  console.log("[worker-cycle] PASS R3C original ledger source append-only mutation guard and committed insert");

  let rolledBack = false;
  try {
    await prisma.$transaction(async tx => {
      await tx.user.update({
        where:{id:id.activeA},data:{bio:"should-roll-back"}
      });
      await tx.domainEvent.create({
        data:event(id.eventRollback,"r3c-occurrence-rollback")
      });
      throw new Error("R3C_EXPECTED_ROLLBACK");
    },{timeout:6000,maxWait:3000});
  } catch(err) {
    rolledBack = err instanceof Error && err.message === "R3C_EXPECTED_ROLLBACK";
  }
  assert(rolledBack,"TX_EXPECTED_ABORT_NOT_DELIVERED");
  assert((await base.user.findUnique({where:{id:id.activeA}}))?.bio === null,
    "TX_USER_PARTIAL_COMMIT");
  assert(await base.domainEvent.count({where:{id:id.eventRollback}}) === 0,
    "TX_LEDGER_PARTIAL_COMMIT");

  const dummy = await base.campus.create({
    data:{id:id.otherCampus,name:"R3C tx-only",slug:"r3c-tx-only",
      schoolName:"isolated.example.invalid"}
  });
  assert(dummy.id === id.otherCampus,"HARD_DELETE_FIXTURE");
  let hardRollback = false;
  try {
    await prisma.$transaction(async tx=>{
      await tx.campus.delete({where:{id:id.otherCampus}});
      throw new Error("R3C_HARD_DELETE_ROLLBACK");
    },{timeout:6000,maxWait:3000});
  } catch(err) {
    hardRollback = err instanceof Error && err.message==="R3C_HARD_DELETE_ROLLBACK";
  }
  assert(hardRollback,"HARD_DELETE_TX_ABORT");
  assert(await base.campus.count({where:{id:id.otherCampus}})===1,
    "HARD_DELETE_ESCAPED_TRANSACTION");
  console.log("[worker-cycle] PASS R3C v7 layered extensions preserve domain-event/user and hard-delete rollback atomicity");
} finally {
  await base.$disconnect();
}
PROBE_R3C

# Unprivileged, readonly ephemeral release-shell container; only shadow DB URL.
# Source and test live on a readonly sandbox mount; no secrets/production env.
if ! timeout --signal=TERM --kill-after=10s 120s docker run --rm \
  --network "$network" --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=128m \
  --mount "type=bind,src=$sandbox,dst=/shadow,readonly" \
  --workdir /shadow \
  -e "DATABASE_URL=$shadow_url" -e "EXPECTED_SHADOW_DB=$shadow_db" \
  --entrypoint node "campus-marketplace-migrator:$sha" \
  /shadow/node_modules/tsx/dist/cli.mjs /shadow/r3c-probe.ts \
  >"$tmp/r3c-probe.log" 2>&1; then
  # Never stream raw SQL errors; might contain connection URLs and test values.
  echo '[worker-cycle][FAIL] R3C original extension behavior on v7 shadow DB' >&2; exit 1;
fi
for mark in \
  'PASS R3C original soft-delete source list/unique/select/omit/count/explicit-filter/failclosed' \
  'PASS R3C scoped campus predicates and soft-delete inside interactive transaction' \
  'PASS R3C original ledger source append-only mutation guard and committed insert' \
  'PASS R3C v7 layered extensions preserve domain-event/user and hard-delete rollback atomicity'; do
  grep -qF "$mark" "$tmp/r3c-probe.log" || {
    echo '[worker-cycle][FAIL] R3C exact semantic marker missing' >&2; exit 1;
  }
done
echo '[worker-cycle] PASS R3C original soft-delete and ledger code on Prisma7 shadow: scoped tenant predicates/atomicity'
echo '[worker-cycle] LIMIT R3C does not prove central RBAC, automatic cross-tenant enforcement, real order state machines or production cutover'
