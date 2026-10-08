import { prisma } from "@/lib/prisma";
import { loadAuthorizationContext, requirePermissionInContext } from "@/lib/rbac/service";
import {
  assertRuntimeConfigKey,
  type RuntimeConfigKey,
} from "@/lib/runtime-config/runtime-config-registry";

/**
 * Phase 10E: narrow, read-only operator management DTO.
 *
 * The override's own version (including a NULL/INHERIT tombstone) is the
 * compare-and-swap authority. Effective inherited GLOBAL version is never a
 * substitute. No actor identity, secrets, free-text notes, or PII in revisions.
 * No generic config enumeration; exact registered key and authorized scope only.
 */
export async function loadRuntimeConfigForOperator(input: {
  actorId: string;
  key: RuntimeConfigKey;
  campusId: string | null;
}): Promise<{
  key: RuntimeConfigKey;
  scopeKey: string;
  currentValue: number | null;
  currentVersion: number;
  revisions: Array<{
    version: number;
    previousValue: number | null;
    newValue: number | null;
    createdAt: string;
  }>;
}> {
  assertRuntimeConfigKey(input.key);
  if (
    !input.actorId ||
    (input.campusId !== null &&
      (typeof input.campusId !== "string" || !input.campusId.trim()))
  ) {
    throw new Error("RUNTIME_CONFIG_SCOPE_INVALID");
  }

  const scopeKey = input.campusId === null
    ? "GLOBAL"
    : `CAMPUS:${input.campusId}`;

  const context = await loadAuthorizationContext(input.actorId);
  await requirePermissionInContext(context, "runtime.config.manage", input.campusId);
  const row = await prisma.runtimeConfigOverride.findUnique({
    where: { key_scopeKey: { key: input.key, scopeKey } },
    select: {
      value: true,
      version: true,
      revisions: {
        orderBy: { version: "desc" },
        take: 20,
        select: {
          version: true,
          previousValue: true,
          newValue: true,
          createdAt: true,
        },
      },
    },
  });

  return {
    key: input.key,
    scopeKey,
    currentValue: row?.value ?? null,
    currentVersion: row?.version ?? 0,
    revisions: (row?.revisions ?? []).map((revision) => ({
      ...revision,
      createdAt: revision.createdAt.toISOString(),
    })),
  };
}
