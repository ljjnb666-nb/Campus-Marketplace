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
    // Bound contention; an unavailable lock cannot silently prove continuity.
    await tx.$executeRaw`SET LOCAL lock_timeout = '1500ms'`;
    const scope = JSON.stringify([
      "UnverifiedHostLifecycleSequence:v1", data.hostId, data.sessionId,
    ]);
    await tx.$queryRaw<Array<{ locked: string }>>`
      SELECT pg_advisory_xact_lock(hashtextextended(${scope}::text, 0))::text AS locked
    `;

    const existing = await tx.hostLifecycleClaim.findUnique({
      where: { hostId_sessionId_sequence: {
        hostId: data.hostId, sessionId: data.sessionId, sequence: data.sequence,
      } },
      select: { claimKey: true },
    });
    if (existing) {
      if (existing.claimKey !== data.claimKey) throw new UnverifiedHostSequenceError();
      // Existing journal helper also checks full canonical persisted semantics.
      return result(await recordUnverifiedHostLifecycleClaimTx(tx, safe));
    }

    const tip = await tx.hostLifecycleClaim.findFirst({
      where: { hostId: data.hostId, sessionId: data.sessionId },
      orderBy: { sequence: "desc" },
      select: { sequence: true, observedAt: true, kind: true },
    });
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
