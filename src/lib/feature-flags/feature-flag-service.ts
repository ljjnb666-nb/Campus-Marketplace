import { Prisma, type Prisma as PrismaTypes } from "@prisma/client";

import { recordAdminAudit } from "@/lib/governance/admin-audit";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { withTransaction } from "@/lib/prisma";
import { loadAuthorizationContext, requirePermissionInContext } from "@/lib/rbac/service";
import {
  assertFeatureFlagKey,
  assertFlagMutationValue,
  type FeatureFlagKey,
} from "@/lib/feature-flags/feature-flag-registry";
import { lockFeatureFlagExclusive } from "@/lib/feature-flags/feature-flag-guard";

export type SetFeatureFlagInput = {
  actorId: string;
  key: FeatureFlagKey;
  campusId: string | null;
  disabled: boolean | null; // null = INHERIT tombstone, never history deletion
  expectedVersion: number; // 0 on create
  seams?: {
    beforeAudit?: (tx: PrismaTypes.TransactionClient) => Promise<void>;
    afterAuthorization?: (tx: PrismaTypes.TransactionClient) => Promise<void>;
  };
};

/** Authoritative core; caller must own transaction, no free-text/secret values. */
export async function setFeatureFlagTx(
  tx: PrismaTypes.TransactionClient,
  input: SetFeatureFlagInput,
) {
  assertFeatureFlagKey(input.key);
  assertFlagMutationValue(input.disabled);
  if (
    !input.actorId ||
    (input.campusId !== null && (typeof input.campusId !== "string" || !input.campusId.trim())) ||
    !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
  ) throw new Error("FEATURE_FLAG_MUTATION_INVALID");

  const scopeKey = input.campusId === null ? "GLOBAL" : `CAMPUS:${input.campusId}`;

  // Writer takes USER governance lock BEFORE feature-flag exclusive barrier.
  await acquireGovernanceSubjectLocks(tx, [{ subjectType: "USER", subjectId: input.actorId }]);
  const context = await loadAuthorizationContext(input.actorId, tx);
  await requirePermissionInContext(context, "feature.flags.manage", input.campusId);

  if (input.seams?.afterAuthorization) await input.seams.afterAuthorization(tx);
  await lockFeatureFlagExclusive(tx, input.key, scopeKey);

  const existing = await tx.featureFlagOverride.findUnique({
    where: { key_scopeKey: { key: input.key, scopeKey } },
    select: { id: true, version: true, disabled: true },
  });
  if (input.disabled === null && !existing) throw new Error("FEATURE_FLAG_OVERRIDE_NOT_FOUND");
  if ((existing?.version ?? 0) !== input.expectedVersion) {
    throw new Error("FEATURE_FLAG_VERSION_CONFLICT");
  }

  let flagId: string;
  const version = input.expectedVersion + 1;
  if (existing) {
    const updated = await tx.featureFlagOverride.updateMany({
      where: { id: existing.id, version: input.expectedVersion },
      data: { disabled: input.disabled, version: { increment: 1 } },
    });
    if (updated.count !== 1) throw new Error("FEATURE_FLAG_VERSION_CONFLICT");
    flagId = existing.id;
  } else {
    try {
      const created = await tx.featureFlagOverride.create({
        data: {
          key: input.key, scopeKey, campusId: input.campusId,
          disabled: input.disabled, version: 1,
        },
        select: { id: true },
      });
      flagId = created.id;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new Error("FEATURE_FLAG_VERSION_CONFLICT");
      }
      throw e;
    }
  }

  await tx.featureFlagRevision.create({
    data: {
      flagId, version,
      previousDisabled: existing?.disabled ?? null,
      nextDisabled: input.disabled,
    },
  });

  if (input.seams?.beforeAudit) await input.seams.beforeAudit(tx);
  await recordAdminAudit({
    actorId: input.actorId,
    action: "FEATURE_FLAG_CHANGED",
    targetType: "FEATURE_FLAG",
    targetId: input.key,
    campusId: input.campusId,
    detail: null,
    metadata: {
      flagKey: input.key,
      previousFlagVersion: existing?.version ?? 0,
      nextFlagVersion: version,
      previousFlagDisabled: existing?.disabled ?? null,
      nextFlagDisabled: input.disabled,
    },
  }, tx);

  return { key: input.key, scopeKey, disabled: input.disabled, version };
}

export async function setFeatureFlag(input: SetFeatureFlagInput) {
  return withTransaction((tx) => setFeatureFlagTx(tx, input));
}
