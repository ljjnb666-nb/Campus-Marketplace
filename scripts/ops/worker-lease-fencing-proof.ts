/**
 * Issue #157 R1F: isolated Docker-image execution harness.
 * This test-only file is read-only bind-mounted; it is NOT copied into a
 * production image or installed as a second queue/worker implementation.
 * Every claim/fence/crash operation delegates to production repository/runner.
 */
import { writeSync } from "node:fs";
import { prisma, withTransaction } from "../../src/lib/prisma";
import { claimDueAsyncJobs, completeAsyncJob } from "../../src/lib/async/job-repository";
import { executeClaimedAsyncJob } from "../../src/lib/async/job-runner";
import {
  beginOutboxMaterializeTx,
  claimDueOutboxEvents,
  publishOutboxEventTx,
} from "../../src/lib/async/outbox";

const jobId = "proof-fence-job";
const orderId = "proof-fence-order";
const eventKey = "PRODUCT_RESERVATION_EXPIRED:" + orderId;
const mode = process.argv[2];
function assert(value: unknown, what: string): asserts value {
  if (!value) throw new Error("PROOF_INVARIANT_" + what);
}
function marker(value: string): void {
  writeSync(1, "PROOF_PASS " + value + "\n");
}
async function claimJob(workerId: string): Promise<void> {
  const claimed = await withTransaction((tx) =>
    claimDueAsyncJobs(tx, { workerId, leaseSeconds: 60, batchSize: 1 }),
  );
  assert(claimed.length === 1 && claimed[0].id === jobId, "JOB_CLAIM_EXACTLY_ONE");
  marker("job-claim");
}
async function claimEvent(workerId: string): Promise<void> {
  const claimed = await withTransaction((tx) =>
    claimDueOutboxEvents(tx, { workerId, leaseSeconds: 60, batchSize: 1 }),
  );
  const event = await prisma.outboxEvent.findUnique({ where: { dedupeKey: eventKey } });
  assert(event && claimed.length === 1 && claimed[0].id === event.id, "OUTBOX_CLAIM_EXACTLY_ONE");
  marker("outbox-claim");
}
async function main(): Promise<void> {
  if (mode === "claim-a") {
    await claimJob("proof-fence-A");
  } else if (mode === "reclaim-b") {
    await claimJob("proof-fence-B");
  } else if (mode === "stale-a") {
    const token = process.env.PROOF_STALE_TOKEN;
    assert(token && /^[0-9a-f-]{36}$/.test(token), "STALE_TOKEN_FORMAT");
    const job = await prisma.asyncJob.findUniqueOrThrow({ where: { id: jobId } });
    assert(job.status === "RUNNING" && job.attempts === 2 &&
      job.leaseOwner === "proof-fence-B" && job.leaseToken !== token, "RECLAIM_AUTHORITY");
    const result = await executeClaimedAsyncJob({
      id: jobId, kind: "PRODUCT_RESERVATION_EXPIRE", schemaVersion: 1,
      payload: { orderId }, attempts: 1, maxAttempts: 8,
      leaseToken: token, previousStatus: "RUNNING",
    }, { leaseSeconds: 60 });
    assert(result.fencedBeforeExecution && !result.completed, "STALE_EXECUTION_FENCED");
    const completion = await completeAsyncJob(prisma, { id: jobId, leaseToken: token });
    assert(!completion.completed, "STALE_COMPLETION_FENCED");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const product = await prisma.product.findUniqueOrThrow({ where: { id: "proof-fence-product" } });
    const events = await prisma.outboxEvent.count({ where: { dedupeKey: eventKey } });
    assert(order.status === "PENDING" && order.productReservationResolution === null &&
      product.status === "RESERVED" && events === 0, "STALE_ZERO_DOMAIN_SIDE_EFFECTS");
    marker("stale-execution-completion-fenced");
  } else if (mode === "crash-b") {
    const job = await prisma.asyncJob.findUniqueOrThrow({ where: { id: jobId } });
    assert(job.status === "RUNNING" && job.attempts === 2 &&
      job.leaseOwner === "proof-fence-B" && !!job.leaseToken, "CRASH_OWNER");
    // Executes the real handler and COMMIT; terminates BEFORE completion marker.
    // The existing §70 test seam is used only in this isolated test process.
    await executeClaimedAsyncJob({
      id: job.id, kind: job.kind, schemaVersion: job.schemaVersion,
      payload: job.payload, attempts: job.attempts, maxAttempts: job.maxAttempts,
      leaseToken: job.leaseToken!, previousStatus: "RUNNING",
      dedupeKey: job.dedupeKey,
    }, {
      leaseSeconds: 60,
      seams: {
        afterJobTxCommit: async (claimed) => {
          assert(claimed.id === jobId, "CRASH_POINT_TARGET");
          writeSync(1, "PROOF_CRASH_AFTER_DOMAIN_COMMIT\n");
          process.exit(77);
        },
      },
    });
    throw new Error("PROOF_CRASH_NOT_TRIGGERED");
  } else if (mode === "outbox-a") {
    await claimEvent("proof-outbox-A");
  } else if (mode === "outbox-b") {
    await claimEvent("proof-outbox-B");
  } else if (mode === "outbox-stale-a") {
    const token = process.env.PROOF_STALE_TOKEN;
    assert(token && /^[0-9a-f-]{36}$/.test(token), "OUTBOX_STALE_TOKEN_FORMAT");
    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { dedupeKey: eventKey } });
    assert(event.status === "PROCESSING" && event.attempts === 2 &&
      event.leaseOwner === "proof-outbox-B" && event.leaseToken !== token, "OUTBOX_AUTHORITY");
    const began = await withTransaction((tx) =>
      beginOutboxMaterializeTx(tx, { id: event.id, leaseToken: token, leaseSeconds: 60 }),
    );
    const published = await withTransaction((tx) =>
      publishOutboxEventTx(tx, { id: event.id, leaseToken: token }),
    );
    const notifications = await prisma.notification.count({ where: { orderId } });
    assert(!began && !published && notifications === 0, "OUTBOX_STALE_FENCED");
    marker("stale-outbox-fenced");
  } else {
    throw new Error("PROOF_UNSUPPORTED_MODE");
  }
  await prisma.$disconnect();
}
main().catch(() => {
  // No raw Prisma error, DB URL, token, synthetic credentials or stack traces.
  process.stderr.write("PROOF_FAIL safe-invariant-or-runtime-error\n");
  process.exit(1);
});
