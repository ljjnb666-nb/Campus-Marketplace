import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { CandidateFleetInstance } from "@/lib/analytics/funnel-fleet-roster-gap";
import type { UnverifiedHostLifecycleObservation } from "@/lib/analytics/funnel-host-lifecycle-replay";

/**
 * Phase 10K-R2d-03B-02B-02A. Internal, transaction-only sink for UNVERIFIED
 * host observation CANDIDATES. Nothing in this module is a credential check,
 * a host collector, a complete fleet census, or a KPI publication authority.
 */
export type PreparedUnverifiedHostLifecycleClaim = Readonly<{
  claimKey: string;
  hostId: string;
  sessionId: string;
  sequence: bigint;
  observedAt: Date;
  kind: UnverifiedHostLifecycleObservation["kind"];
  instanceId: string | null;
  releaseSha: string | null;
  role: CandidateFleetInstance["role"] | null;
  baselineJson: string | null;
  source: "UNVERIFIED";
}>;

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const RELEASE = /^[0-9a-f]{40}$/;
const MAX_BASELINE_INSTANCES = 128;
const MAX_BASELINE_BYTES = 32768;

export class HostLifecycleClaimContractError extends Error {
  readonly code = "HOST_LIFECYCLE_CLAIM_INVALID";
  constructor() {
    super("HOST_LIFECYCLE_CLAIM_INVALID");
    this.name = "HostLifecycleClaimContractError";
  }
}

function validInstance(value: unknown): value is CandidateFleetInstance {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.instanceId === "string" && ID.test(row.instanceId) &&
    typeof row.releaseSha === "string" && RELEASE.test(row.releaseSha) &&
    (row.role === "APP" || row.role === "ASYNC_WORKER");
}

function normalizeBaseline(rows: unknown): string {
  if (!Array.isArray(rows) || rows.length > MAX_BASELINE_INSTANCES) {
    throw new HostLifecycleClaimContractError();
  }
  const ids = new Set<string>();
  const sanitized: CandidateFleetInstance[] = [];
  for (const candidate of rows) {
    if (!validInstance(candidate) || ids.has(candidate.instanceId)) {
      throw new HostLifecycleClaimContractError();
    }
    ids.add(candidate.instanceId);
    // Explicit machine field allowlist: do not write arbitrary Docker labels,
    // environment, user IDs, free text, IP, credentials or event payloads.
    sanitized.push({
      instanceId: candidate.instanceId,
      releaseSha: candidate.releaseSha,
      role: candidate.role,
    });
  }
  sanitized.sort((a, b) =>
    a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0);
  const snapshot = JSON.stringify(sanitized);
  if (snapshot.length > MAX_BASELINE_BYTES) {
    throw new HostLifecycleClaimContractError();
  }
  return snapshot;
}

/** Canonical payload identity is deterministic and is NOT a signature. */
export function prepareUnverifiedHostLifecycleClaim(
  input: UnverifiedHostLifecycleObservation,
): PreparedUnverifiedHostLifecycleClaim {
  if (!input || input.origin !== "UNVERIFIED_HOST_OBSERVER" ||
      typeof input.hostId !== "string" || !ID.test(input.hostId) ||
      typeof input.sessionId !== "string" || !ID.test(input.sessionId) ||
      !Number.isSafeInteger(input.sequence) || input.sequence < 1 ||
      !(input.observedAt instanceof Date) ||
      !Number.isFinite(input.observedAt.getTime()) ||
      input.observedAt.getTime() < 0 ||
      !["BASELINE", "START", "STOP", "HEARTBEAT", "DISCONNECTED"].includes(input.kind)) {
    throw new HostLifecycleClaimContractError();
  }

  let baselineJson: string | null = null;
  let instanceId: string | null = null;
  let releaseSha: string | null = null;
  let role: CandidateFleetInstance["role"] | null = null;

  if (input.kind === "BASELINE") {
    if (input.instance !== undefined) throw new HostLifecycleClaimContractError();
    baselineJson = normalizeBaseline(input.instances);
  } else if (input.kind === "START" || input.kind === "STOP") {
    if (input.instances !== undefined || !validInstance(input.instance)) {
      throw new HostLifecycleClaimContractError();
    }
    instanceId = input.instance.instanceId;
    releaseSha = input.instance.releaseSha;
    role = input.instance.role;
  } else if (input.instance !== undefined || input.instances !== undefined) {
    throw new HostLifecycleClaimContractError();
  }

  const observedAt = new Date(input.observedAt.getTime());
  const canonical = [
    "HostLifecycleClaim:v1", input.hostId, input.sessionId, input.sequence,
    observedAt.toISOString(), input.kind,
    instanceId, releaseSha, role, baselineJson,
  ];
  const claimKey = createHash("sha256")
    .update(JSON.stringify(canonical)).digest("hex");

  return {
    claimKey, hostId: input.hostId, sessionId: input.sessionId,
    sequence: BigInt(input.sequence), observedAt, kind: input.kind,
    instanceId, releaseSha, role, baselineJson, source: "UNVERIFIED",
  };
}

/**
 * The only storage mutation seam in this phase; no route or scheduler calls it.
 * A future **independent host identity and signature verification** gate must
 * be implemented and reviewed before any external observation can be ingested.
 * This function must NOT accept "trusted=true", attest membership or publish.
 *
 * Unique (hostId,sessionId,sequence) forbids conflicting retry payloads.
 * Content-key collisions are checked against the actual persisted row.
 */
export async function recordUnverifiedHostLifecycleClaimTx(
  tx: Prisma.TransactionClient,
  observation: UnverifiedHostLifecycleObservation,
): Promise<{ recorded: boolean; claimKey: string }> {
  const data = prepareUnverifiedHostLifecycleClaim(observation);
  const insert = await tx.hostLifecycleClaim.createMany({
    data: [data], skipDuplicates: true,
  });
  const persisted = await tx.hostLifecycleClaim.findUnique({
    where: { hostId_sessionId_sequence: {
      hostId: data.hostId, sessionId: data.sessionId, sequence: data.sequence,
    } },
  });
  if (!persisted ||
      persisted.claimKey !== data.claimKey ||
      persisted.hostId !== data.hostId ||
      persisted.sessionId !== data.sessionId ||
      persisted.sequence !== data.sequence ||
      persisted.observedAt.getTime() !== data.observedAt.getTime() ||
      persisted.kind !== data.kind ||
      persisted.instanceId !== data.instanceId ||
      persisted.releaseSha !== data.releaseSha ||
      persisted.role !== data.role ||
      persisted.baselineJson !== data.baselineJson ||
      persisted.source !== "UNVERIFIED") {
    throw new HostLifecycleClaimContractError();
  }
  return { recorded: insert.count === 1, claimKey: data.claimKey };
}
