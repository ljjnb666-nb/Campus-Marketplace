import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  FUNNEL_CAPTURE_STREAMS,
  type ClaimedCaptureInterval,
  type FunnelCaptureStream,
} from "@/lib/analytics/funnel-capture-continuity";

/**
 * 10K-R2d-03B-01: This is an append-only UNVERIFIED claim journal, NOT an
 * attested deployment/fleet inventory. No HTTP ingress, flag activation,
 * percentage calculation or completeness proof is created in this phase.
 */
export type UnverifiedCaptureClaimInput = Readonly<{
  campusId: string;
  stream: FunnelCaptureStream;
  instanceId: string;
  releaseSha: string;
  from: Date;
  until: Date;
  captureEnabled: boolean;
}>;

export type PreparedUnverifiedCaptureClaim = Readonly<{
  claimKey: string;
  campusId: string;
  stream: FunnelCaptureStream;
  instanceId: string;
  releaseSha: string;
  claimedFrom: Date;
  claimedUntil: Date;
  captureEnabled: boolean;
  source: "UNVERIFIED";
}>;

const SHA = /^[0-9a-f]{40}$/;
const INSTANCE = /^[A-Za-z0-9_.:-]{1,128}$/;
const STREAMS: ReadonlySet<string> = new Set(FUNNEL_CAPTURE_STREAMS);

export class CaptureClaimContractError extends Error {
  readonly code = "FUNNEL_CAPTURE_CLAIM_INVALID";
  constructor() {
    super("FUNNEL_CAPTURE_CLAIM_INVALID");
    this.name = "CaptureClaimContractError";
  }
}

export function prepareUnverifiedCaptureClaim(
  input: UnverifiedCaptureClaimInput,
): PreparedUnverifiedCaptureClaim {
  if (!input || typeof input.campusId !== "string" ||
      input.campusId.length < 1 || input.campusId.length > 191 ||
      typeof input.stream !== "string" || !STREAMS.has(input.stream) ||
      typeof input.instanceId !== "string" || !INSTANCE.test(input.instanceId) ||
      typeof input.releaseSha !== "string" || !SHA.test(input.releaseSha) ||
      typeof input.captureEnabled !== "boolean" ||
      !(input.from instanceof Date) || !(input.until instanceof Date) ||
      !Number.isFinite(input.from.getTime()) ||
      !Number.isFinite(input.until.getTime()) ||
      input.from.getTime() >= input.until.getTime()) {
    throw new CaptureClaimContractError();
  }
  const from = new Date(input.from.getTime());
  const until = new Date(input.until.getTime());
  const canonical = [
    "FunnelCaptureClaim:v1", input.campusId, input.stream, input.instanceId,
    input.releaseSha, from.toISOString(), until.toISOString(),
    input.captureEnabled,
  ];
  const claimKey = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return {
    claimKey, campusId: input.campusId, stream: input.stream,
    instanceId: input.instanceId, releaseSha: input.releaseSha,
    claimedFrom: from, claimedUntil: until,
    captureEnabled: input.captureEnabled, source: "UNVERIFIED",
  };
}

/**
 * Transaction-only internal seam. Calling this doesn't authorize the
 * application, process, or operator to attest to a real deployment. Any
 * future caller MUST have an independently reviewed producer authority.
 */
export async function recordUnverifiedCaptureClaimTx(
  tx: Prisma.TransactionClient,
  input: UnverifiedCaptureClaimInput,
): Promise<{ recorded: boolean; claimKey: string }> {
  const prepared = prepareUnverifiedCaptureClaim(input);
  const inserted = await tx.funnelCaptureClaim.createMany({
    data: [prepared], skipDuplicates: true,
  });
  const row = await tx.funnelCaptureClaim.findUnique({
    where: { claimKey: prepared.claimKey },
    select: {
      claimKey: true, campusId: true, stream: true, instanceId: true,
      releaseSha: true, claimedFrom: true, claimedUntil: true,
      captureEnabled: true, source: true,
    },
  });
  const same = row !== null &&
    row.claimKey === prepared.claimKey &&
    row.campusId === prepared.campusId &&
    row.stream === prepared.stream &&
    row.instanceId === prepared.instanceId &&
    row.releaseSha === prepared.releaseSha &&
    row.claimedFrom.getTime() === prepared.claimedFrom.getTime() &&
    row.claimedUntil.getTime() === prepared.claimedUntil.getTime() &&
    row.captureEnabled === prepared.captureEnabled &&
    row.source === "UNVERIFIED";
  if (!same) throw new CaptureClaimContractError();
  return { recorded: inserted.count === 1, claimKey: prepared.claimKey };
}

/** Adapt a stored claim for the R2d-03A negative-only evaluator.
 * A journal row is still merely a claim, never a trusted instance census.
 * Re-check scope at the independent read service BEFORE calling this helper.
 */
export function asUnverifiedCaptureInterval(
  value: PreparedUnverifiedCaptureClaim,
): ClaimedCaptureInterval {
  return {
    campusId: value.campusId,
    stream: value.stream,
    instanceId: value.instanceId,
    releaseSha: value.releaseSha,
    from: value.claimedFrom,
    until: value.claimedUntil,
    captureEnabled: value.captureEnabled,
    source: "UNVERIFIED",
  };
}
