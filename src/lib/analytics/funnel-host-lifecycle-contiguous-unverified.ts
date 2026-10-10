import type { Prisma } from "@prisma/client";
import {
  HostLifecycleClaimContractError,
  prepareUnverifiedHostLifecycleClaim,
  recordUnverifiedHostLifecycleClaimTx,
  type PreparedUnverifiedHostLifecycleClaim,
} from "@/lib/analytics/funnel-host-lifecycle-claim-journal";
import type { UnverifiedHostLifecycleObservation } from
  "@/lib/analytics/funnel-host-lifecycle-replay";

/**
 * Phase 10K-R2d-03B-02B-02B-12A: transaction-only serialization of
 * UNVERIFIED candidate host claims, using existing immutable PG rows.
 *
 * NOT an identity verifier, cross-process trusted checkpoint, anti-tamper
 * source, deployment inventory, producer, or KPI publication permission.
 * Existing/privileged writers can bypass this opt-in internal seam.
 */
const MAX_SILENCE_MS = 15 * 60_000;
// Candidate-only cost gate. A trusted scalable checkpoint requires an
// independently managed cursor, not an unbounded scan of local journal rows.
const MAX_SESSION_SEQUENCE = BigInt(4096);
const ERROR_CODE = "UNVERIFIED_HOST_SEQUENCE_REFUSED" as const;

export class UnverifiedHostSequenceError extends Error {
  readonly code = ERROR_CODE;
  constructor() {
    super(ERROR_CODE);
    this.name = "UnverifiedHostSequenceError";
  }
}

export type UnverifiedHostSequenceResult = Readonly<{
  recorded: boolean;
  claimKey: string;
  source: "UNVERIFIED";
  independentProvisioningVerified: false;
  independentHostAuthenticated: false;
  deploymentMembershipComplete: false;
  captureContinuityProven: false;
  canPublish: false;
}>;

function result(value: { recorded: boolean; claimKey: string }): UnverifiedHostSequenceResult {
  return {
    ...value,
    source: "UNVERIFIED",
    independentProvisioningVerified: false,
    independentHostAuthenticated: false,
    deploymentMembershipComplete: false,
    captureContinuityProven: false,
    canPublish: false,
  };
}

/** Never reread a caller-mutable observation after its canonical snapshot. */
function toSafeObservation(
  data: PreparedUnverifiedHostLifecycleClaim,
): UnverifiedHostLifecycleObservation {
  return {
    origin: "UNVERIFIED_HOST_OBSERVER",
    hostId: data.hostId,
    sessionId: data.sessionId,
    sequence: Number(data.sequence),
    observedAt: new Date(data.observedAt.getTime()),
    kind: data.kind,
    ...(data.baselineJson === null ? {} : {
      instances: JSON.parse(data.baselineJson) as NonNullable<
        UnverifiedHostLifecycleObservation["instances"]
      >,
    }),
    ...(data.instanceId === null ? {} : {
      instance: {
        instanceId: data.instanceId,
        releaseSha: data.releaseSha!,
        role: data.role!,
      },
    }),
  };
}

/**
 * Serializable only among callers that use this seam in READ COMMITTED
 * transactions: a scoped PG transaction advisory lock prevents two callers
 * from evaluating the same old journal tip simultaneously. It is NOT a
 * PostgreSQL-wide constraint and DOES NOT confer external trust.
 *
 * The caller must own and commit/rollback the transaction. With an unknown
 * commit outcome, retrying identical input safely detects an existing slot;
 * this helper never assumes a lost response means the write failed.
 */
export async function recordContiguousUnverifiedHostClaimTx(
  tx: Prisma.TransactionClient,
  observation: UnverifiedHostLifecycleObservation,
): Promise<UnverifiedHostSequenceResult> {
  let data: PreparedUnverifiedHostLifecycleClaim;
  try {
    data = prepareUnverifiedHostLifecycleClaim(observation);
  } catch {
    throw new UnverifiedHostSequenceError();
  }
  const safe = toSafeObservation(data);
  try {
    const isolation = await tx.$queryRaw<Array<{ level: string }>>`
      SELECT current_setting('transaction_isolation') AS level
    `;
    if (isolation.length !== 1 || isolation[0].level !== "read committed") {
      throw new UnverifiedHostSequenceError();
    }
    // The transaction belongs to the caller: never override its
    // lock_timeout (or any other SET LOCAL setting). Fail closed immediately
    // if another cooperating writer owns this host/session scope.
    const scope = JSON.stringify([
      "UnverifiedHostLifecycleSequence:v1", data.hostId, data.sessionId,
    ]);
    const lock = await tx.$queryRaw<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${scope}::text, 0)) AS acquired
    `;
    if (lock.length !== 1 || lock[0]?.acquired !== true) {
      throw new UnverifiedHostSequenceError();
    }

    if (data.sequence > MAX_SESSION_SEQUENCE) throw new UnverifiedHostSequenceError();

    const scopeWhere = { hostId: data.hostId, sessionId: data.sessionId };
    const tip = await tx.hostLifecycleClaim.findFirst({
      where: scopeWhere,
      orderBy: { sequence: "desc" },
      select: { sequence: true, observedAt: true, kind: true },
    });
    if (tip) {
      if (tip.sequence > MAX_SESSION_SEQUENCE) throw new UnverifiedHostSequenceError();
      // Older internal writers could skip sequence numbers. Unique positive
      // sequence slots imply an exact 1..tip prefix only when COUNT == tip.
      // Keep the verification bounded and fail closed for oversized sessions.
      const count = await tx.hostLifecycleClaim.count({ where: scopeWhere });
      const genesis = await tx.hostLifecycleClaim.findUnique({
        where: { hostId_sessionId_sequence: {
          ...scopeWhere, sequence: BigInt(1),
        } },
        select: { kind: true },
      });
      if (BigInt(count) !== tip.sequence || genesis?.kind !== "BASELINE") {
        throw new UnverifiedHostSequenceError();
      }

      // A gap-free numeric prefix is not enough: the older writer could
      // persist a second BASELINE, backwards clock, oversized silence, or a
      // continuation after DISCONNECTED. Audit the bounded local prefix
      // before either an append or an exact-slot idempotent retry.
      const semantic = await tx.$queryRaw<Array<{ invalid: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM (
            SELECT "sequence", "kind", "observedAt",
                   LAG("kind") OVER (ORDER BY "sequence") AS "previousKind",
                   LAG("observedAt") OVER (ORDER BY "sequence") AS "previousAt"
            FROM "HostLifecycleClaim"
            WHERE "hostId" = ${data.hostId} AND "sessionId" = ${data.sessionId}
          ) AS "history"
          WHERE "sequence" > 1
            AND (
              "kind" = 'BASELINE'
              OR "previousKind" = 'DISCONNECTED'
              OR "observedAt" < "previousAt"
              OR "observedAt" > "previousAt" + INTERVAL '15 minutes'
            )
        ) AS "invalid"
      `;
      if (semantic.length !== 1 || semantic[0]?.invalid !== false) {
        throw new UnverifiedHostSequenceError();
      }
    }

    const existing = await tx.hostLifecycleClaim.findUnique({
      where: { hostId_sessionId_sequence: {
        ...scopeWhere, sequence: data.sequence,
      } },
      select: { claimKey: true },
    });
    if (existing) {
      if (existing.claimKey !== data.claimKey) throw new UnverifiedHostSequenceError();
      // Even exact retries cannot launder a known corrupt historical prefix.
      return result(await recordUnverifiedHostLifecycleClaimTx(tx, safe));
    }
    if (!tip) {
      if (data.sequence !== BigInt(1) || data.kind !== "BASELINE") {
        throw new UnverifiedHostSequenceError();
      }
    } else {
      const elapsed = data.observedAt.getTime() - tip.observedAt.getTime();
      if (data.sequence !== tip.sequence + BigInt(1) ||
          data.kind === "BASELINE" || tip.kind === "DISCONNECTED" ||
          elapsed < 0 || elapsed > MAX_SILENCE_MS) {
        throw new UnverifiedHostSequenceError();
      }
    }
    const written = await recordUnverifiedHostLifecycleClaimTx(tx, safe);
    if (!written.recorded) throw new UnverifiedHostSequenceError();
    return result(written);
  } catch {
    // Never echo SQL/connection errors, submitted host labels or hashes.
    throw new UnverifiedHostSequenceError();
  }
}
