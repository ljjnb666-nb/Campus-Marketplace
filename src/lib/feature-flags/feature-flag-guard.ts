import type { Prisma } from "@prisma/client";
import {
  NEW_ACTIVITY_FLAG_KEYS,
  isFlagDisabledForScope,
  type FeatureFlagKey,
  type NewActivityKind,
} from "@/lib/feature-flags/feature-flag-registry";

/**
 * Lock namespace unique to Phase 10F. All business guards take SHARED tx locks;
 * updates take EXCLUSIVE tx lock for the exact key/scope. Changes and new
 * activities serialize even across separate server instances.
 *
 * Lock keys are ordered lexically (GLOBAL and CAMPUS keys with key prefix).
 * CALLER MUST acquire all preexisting governance USER/CAMPUS locks first.
 * Read only after acquiring the shared flag lock(s) in the SAME transaction.
 */
export const FEATURE_FLAG_LOCK_NAMESPACE = 730_506;

function lockIds(keys: readonly FeatureFlagKey[], campusId: string): string[] {
  return [...new Set(keys.flatMap((key) => [
    `${key}:GLOBAL`, `${key}:CAMPUS:${campusId}`,
  ]))].sort();
}

export class NewActivityDisabledError extends Error {
  readonly code = "NEW_ACTIVITY_DISABLED";
  readonly userMessage = "该操作已由平台暂时停用，请稍后再试";

  constructor() {
    super("该操作已由平台暂时停用，请稍后再试");
    this.name = "NewActivityDisabledError";
  }
}

export async function lockFeatureFlagExclusive(
  tx: Prisma.TransactionClient,
  key: FeatureFlagKey,
  scopeKey: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(
    ${FEATURE_FLAG_LOCK_NAMESPACE}::int, hashtext(${`${key}:${scopeKey}`})
  )`;
}

/**
 * Shared exact-scope fence for authorized operator reads. Readers of current
 * CAS state and revision history must serialize with writer commits too.
 */
export async function lockFeatureFlagSharedById(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(
    ${FEATURE_FLAG_LOCK_NAMESPACE}::int, hashtext(${id})
  )`;
}

/**
 * Central authoritative fail-closed guard. No UI-only or out-of-tx check.
 *
 * - GLOBAL TRUE OR campus TRUE blocks, regardless of opposing false.
 * - nonexistent overrides are permissive only after a successful DB read.
 * - DB outage, malformed scoped rows or malformed types deny new activity.
 * - Does not affect existing obligations and recovery/operations paths;
 *   only canonical creation/initiation seams should call this.
 */
export async function requireNewActivityAllowed(
  tx: Prisma.TransactionClient,
  input: { kind: NewActivityKind; campusId: string },
): Promise<void> {
  if (!input.campusId || typeof input.campusId !== "string" || !input.campusId.trim()) {
    throw new NewActivityDisabledError();
  }
  const keys: readonly FeatureFlagKey[] = NEW_ACTIVITY_FLAG_KEYS[input.kind];
  if (!keys) throw new NewActivityDisabledError();

  try {
    for (const id of lockIds(keys, input.campusId)) {
      await lockFeatureFlagSharedById(tx, id);
    }

    const rows = await tx.featureFlagOverride.findMany({
      where: {
        key: { in: [...keys] },
        scopeKey: { in: ["GLOBAL", `CAMPUS:${input.campusId}`] },
      },
      select: { key: true, scopeKey: true, campusId: true, disabled: true, version: true },
    });

    for (const row of rows) {
      const validScope =
        (row.scopeKey === "GLOBAL" && row.campusId === null) ||
        (row.scopeKey === `CAMPUS:${input.campusId}` &&
          row.campusId === input.campusId);
      if (
        !keys.includes(row.key as FeatureFlagKey) ||
        !validScope ||
        !Number.isSafeInteger(row.version) || row.version < 1 ||
        (row.disabled !== null && typeof row.disabled !== "boolean")
      ) {
        throw new NewActivityDisabledError();
      }
    }
    if (keys.some((key) => isFlagDisabledForScope(rows, key, input.campusId))) {
      throw new NewActivityDisabledError();
    }
  } catch {
    throw new NewActivityDisabledError();
  }
}
