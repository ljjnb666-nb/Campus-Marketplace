import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { FEATURE_FLAG_KEYS, type FeatureFlagKey } from "@/lib/feature-flags/feature-flag-registry";
import { lockFeatureFlagSharedById } from "@/lib/feature-flags/feature-flag-guard";
import { withTransaction } from "@/lib/prisma";
import { loadAuthorizationContext, requirePermissionInContext } from "@/lib/rbac/service";

export type FeatureFlagConsoleRow = {
  key: FeatureFlagKey;
  localDisabled: boolean | null;
  globalDisabled: boolean;
  effectiveDisabled: boolean;
  currentVersion: number;
  revisions: {
    version: number;
    previousDisabled: boolean | null;
    nextDisabled: boolean | null;
    createdAt: string;
  }[];
};

/**
 * Exactly one actor/scope snapshot, with fresh RBAC and scoped revision history.
 * Campus operators may see whether GLOBAL is disabling a key, but can neither
 * see nor mutate global revision history. Never return other campus overrides.
 */
export async function loadFeatureFlagConsoleRows(input: {
  actorId: string;
  campusId: string | null;
}): Promise<FeatureFlagConsoleRow[]> {
  if (!input.actorId || (input.campusId !== null && !input.campusId.trim())) {
    throw new Error("FEATURE_FLAG_SCOPE_INVALID");
  }
  return withTransaction(async (tx) => {
    await acquireGovernanceSubjectLocks(tx, [{ subjectType: "USER", subjectId: input.actorId }]);
    const access = await loadAuthorizationContext(input.actorId, tx);
    await requirePermissionInContext(access, "feature.flags.manage", input.campusId);

    const scopeKey = input.campusId === null ? "GLOBAL" : `CAMPUS:${input.campusId}`;
    const scopes = input.campusId === null ? ["GLOBAL"] : ["GLOBAL", scopeKey];
    const locks = [...new Set(FEATURE_FLAG_KEYS.flatMap(key =>
      scopes.map(scope => `${key}:${scope}`)
    ))].sort();
    for (const id of locks) await lockFeatureFlagSharedById(tx, id);

    const rows = await tx.featureFlagOverride.findMany({
      where: { key: { in: [...FEATURE_FLAG_KEYS] }, scopeKey: { in: scopes } },
      select: {
        key: true, scopeKey: true, campusId: true, disabled: true, version: true,
        revisions: {
          orderBy: { version: "desc" }, take: 20,
          select: { version: true, previousDisabled: true, nextDisabled: true, createdAt: true },
        },
      },
    });
    // Fail-closed on malformed authority data; never display a false 'available' badge.
    for (const row of rows) {
      if (
        !FEATURE_FLAG_KEYS.some(key => key === row.key) ||
        !scopes.includes(row.scopeKey) ||
        (row.scopeKey === "GLOBAL" ? row.campusId !== null : row.campusId !== input.campusId) ||
        !Number.isSafeInteger(row.version) || row.version < 1 ||
        (row.disabled !== null && typeof row.disabled !== "boolean")
      ) throw new Error("FEATURE_FLAG_AUTHORITY_INVALID");
    }
    return FEATURE_FLAG_KEYS.map((key) => {
      const global = rows.find(row => row.key === key && row.scopeKey === "GLOBAL");
      const local = input.campusId === null
        ? global
        : rows.find(row => row.key === key && row.scopeKey === scopeKey);
      const globalDisabled = global?.disabled === true;
      return {
        key,
        localDisabled: local?.disabled ?? null,
        globalDisabled,
        effectiveDisabled: globalDisabled || (local?.disabled === true),
        currentVersion: local?.version ?? 0,
        revisions: (local?.revisions ?? []).map(revision => ({
          version: revision.version,
          previousDisabled: revision.previousDisabled,
          nextDisabled: revision.nextDisabled,
          createdAt: revision.createdAt.toISOString(),
        })),
      };
    });
  });
}
