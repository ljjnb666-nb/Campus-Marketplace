import { Prisma, type Prisma as PrismaTypes } from "@prisma/client";

import { recordAdminAudit } from "@/lib/governance/admin-audit";
import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { withTransaction } from "@/lib/prisma";
import { loadAuthorizationContext, requirePermissionInContext } from "@/lib/rbac/service";
import {
  assertRuntimeConfigKey,
  parseRuntimeConfigValue,
  type RuntimeConfigKey,
} from "@/lib/runtime-config/runtime-config-registry";

export type RuntimeConfigMutationInput = {
  actorId: string;
  key: RuntimeConfigKey;
  campusId: string | null; // null = GLOBAL
  value: number;
  expectedVersion: number; // 0 = create, otherwise compare-and-swap
  seams?: {
    afterAuthorization?: (tx: PrismaTypes.TransactionClient) => Promise<void>;
    beforeAudit?: (tx: PrismaTypes.TransactionClient) => Promise<void>;
  };
};

export type RuntimeConfigMutationResult = {
  key: RuntimeConfigKey;
  scopeKey: string;
  previousValue: number | null;
  value: number;
  version: number;
};

/**
 * Canonical single-writer transaction:
 * actor governance lock -> fresh scoped permission -> typed validation ->
 * versioned CAS -> append-only revision -> AdminLog -> commit.
 *
 * No cache, no blind upsert, no last-write-wins. No writes on stale role,
 * invalid value, version conflict or audit failure.
 */
export async function setRuntimeConfigTx(
  tx: PrismaTypes.TransactionClient,
  input: RuntimeConfigMutationInput,
): Promise<RuntimeConfigMutationResult> {
  assertRuntimeConfigKey(input.key);
  const value = parseRuntimeConfigValue(input.key, input.value);
  if (
    !input.actorId ||
    (input.campusId !== null && !input.campusId.trim()) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  ) {
    throw new Error("RUNTIME_CONFIG_MUTATION_INVALID");
  }
  const scopeKey = input.campusId === null ? "GLOBAL" : `CAMPUS:${input.campusId}`;

  return (async () => {
    await acquireGovernanceSubjectLocks(tx, [
      { subjectType: "USER", subjectId: input.actorId },
    ]);
    const context = await loadAuthorizationContext(input.actorId, tx);
    await requirePermissionInContext(context, "runtime.config.manage", input.campusId);

    if (input.seams?.afterAuthorization) {
      await input.seams.afterAuthorization(tx);
    }

    const existing = await tx.runtimeConfigOverride.findUnique({
      where: { key_scopeKey: { key: input.key, scopeKey } },
      select: { id: true, version: true, value: true },
    });
    if ((existing?.version ?? 0) !== input.expectedVersion) {
      throw new Error("RUNTIME_CONFIG_VERSION_CONFLICT");
    }

    let id: string;
    let version: number;
    if (existing) {
      const updated = await tx.runtimeConfigOverride.updateMany({
        where: { id: existing.id, version: input.expectedVersion },
        data: { value, version: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new Error("RUNTIME_CONFIG_VERSION_CONFLICT");
      }
      id = existing.id;
      version = input.expectedVersion + 1;
    } else {
      try {
        const created = await tx.runtimeConfigOverride.create({
          data: {
            key: input.key,
            scopeKey,
            campusId: input.campusId,
            value,
            version: 1,
          },
          select: { id: true },
        });
        id = created.id;
        version = 1;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new Error("RUNTIME_CONFIG_VERSION_CONFLICT");
        }
        throw error;
      }
    }

    await tx.runtimeConfigRevision.create({
      data: {
        configId: id,
        version,
        previousValue: existing?.value ?? null,
        newValue: value,
      },
    });
    if (input.seams?.beforeAudit) await input.seams.beforeAudit(tx);
    await recordAdminAudit({
      actorId: input.actorId,
      action: "RUNTIME_CONFIG_CHANGED",
      targetType: "RUNTIME_CONFIG",
      targetId: input.key,
      campusId: input.campusId,
      detail: null,
      metadata: {
        configKey: input.key,
        previousConfigVersion: existing?.version ?? 0,
        nextConfigVersion: version,
        previousConfigValue: existing?.value ?? null,
        nextConfigValue: value,
      },
    }, tx);

    return {
      key: input.key,
      scopeKey,
      previousValue: existing?.value ?? null,
      value,
      version,
    };
  })();
}

/** Production entry point: owns transaction; test may exercise Tx core in a rollback-only fixture. */
export function setRuntimeConfig(
  input: RuntimeConfigMutationInput,
): Promise<RuntimeConfigMutationResult> {
  return withTransaction((tx) => setRuntimeConfigTx(tx, input));
}
