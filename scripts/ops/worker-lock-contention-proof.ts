/**
 * Issue #157 R1G: deterministic, real PostgreSQL row-lock contention.
 * Mounted read-only into the real nonroot image, never installed in runtime.
 * All job/event claims use production repository functions, not a SQL clone.
 */
import { existsSync, writeSync } from "node:fs";
import { prisma, withTransaction } from "../../src/lib/prisma";
import { claimDueAsyncJobs } from "../../src/lib/async/job-repository";
import { claimDueOutboxEvents } from "../../src/lib/async/outbox";

type Lane = "job" | "outbox";
const mode = process.argv[2];
const lane: Lane = mode?.endsWith("-job") ? "job" : "outbox";
const valid = new Set(["hold-job", "compete-job", "after-job", "hold-outbox", "compete-outbox", "after-outbox"]);
const id = lane === "job" ? "proof-r1g-job" : "proof-r1g-outbox";
const holder = "proof-r1g-holder-" + lane;

function ensure(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error("PROOF_R1G_INVARIANT_" + code);
}
function marker(text: string): void {
  writeSync(1, "PROOF_R1G_" + text + " " + lane + "\n");
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function claim(workerId: string): Promise<string[]> {
  return withTransaction(async (tx) => {
    const rows = lane === "job"
      ? await claimDueAsyncJobs(tx, { workerId, leaseSeconds: 120, batchSize: 1 })
      : await claimDueOutboxEvents(tx, { workerId, leaseSeconds: 120, batchSize: 1 });
    return rows.map((row) => row.id);
  });
}
async function state() {
  return lane === "job"
    ? prisma.asyncJob.findUniqueOrThrow({ where: { id } })
    : prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
}
async function main(): Promise<void> {
  ensure(valid.has(mode), "UNSUPPORTED_MODE");
  if (mode.startsWith("hold-")) {
    // The row UPDATE and its lock remain uncommitted while the separate
    // contender makes a real claim. Releasing is owned by the host gate.
    await withTransaction(async (tx) => {
      const rows = lane === "job"
        ? await claimDueAsyncJobs(tx, { workerId: holder, leaseSeconds: 120, batchSize: 1 })
        : await claimDueOutboxEvents(tx, { workerId: holder, leaseSeconds: 120, batchSize: 1 });
      ensure(rows.length === 1 && rows[0].id === id, "HOLDER_CLAIM");
      marker("LOCK_HELD");
      const deadline = Date.now() + 20000;
      while (!existsSync("/tmp/proof-r1g-sync/release-" + lane)) {
        ensure(Date.now() < deadline, "RELEASE_TIMEOUT");
        await sleep(75);
      }
    }, { timeout: 30000 });
    marker("COMMITTED");
  } else if (mode.startsWith("compete-")) {
    const rows = await claim("proof-r1g-competitor-" + lane);
    ensure(rows.length === 0, "SKIP_LOCKED_NOT_EMPTY");
    // At READ COMMITTED, A's mutation cannot be visible before it commits.
    const record = await state();
    ensure(record.status === "PENDING" && record.attempts === 0 &&
      record.leaseToken === null && record.leaseOwner === null, "UNCOMMITTED_STATE");
    marker("SKIP_LOCKED");
  } else {
    const rows = await claim("proof-r1g-late-" + lane);
    ensure(rows.length === 0, "DUPLICATE_AFTER_COMMIT");
    const record = await state();
    ensure(record.status === (lane === "job" ? "RUNNING" : "PROCESSING") &&
      record.attempts === 1 && record.leaseOwner === holder &&
      !!record.leaseToken && /^[0-9a-f-]{36}$/.test(record.leaseToken) &&
      !!record.leaseExpiresAt && record.leaseExpiresAt.getTime() > Date.now(),
      "COMMITTED_LEASE_STABLE");
    marker("LEASE_STABLE");
  }
  await prisma.$disconnect();
}
main().catch(() => {
  // Never print environment variables, connection strings or raw ORM errors.
  process.stderr.write("PROOF_R1G_FAIL bounded-probe-failure\n");
  process.exit(1);
});
