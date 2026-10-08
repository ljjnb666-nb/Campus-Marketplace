import { acquireGovernanceSubjectLocks } from "@/lib/governance/governance-lock";
import { lockFeatureFlagSharedById } from "@/lib/feature-flags/feature-flag-guard";
import { withTransaction } from "@/lib/prisma";
import { loadAuthorizationContext, requirePermissionInContext } from "@/lib/rbac/service";
import { assertFeatureFlagKey, type FeatureFlagKey } from "@/lib/feature-flags/feature-flag-registry";

/** Authorized exact-scope operator read: local CAS version and 20 revisions. */
export async function loadFeatureFlagForOperator(input: {
  actorId: string; key: FeatureFlagKey; campusId: string | null;
}) {
  assertFeatureFlagKey(input.key);
  if (
    !input.actorId ||
    (input.campusId !== null && (typeof input.campusId !== "string" || !input.campusId.trim()))
  ) throw new Error("FEATURE_FLAG_SCOPE_INVALID");

  const scopeKey = input.campusId === null ? "GLOBAL" : `CAMPUS:${input.campusId}`;
  return withTransaction(async (tx) => {
    // Revocation and operator reads serialize on the same actor USER authority;
    // the flag SHARED fence keeps the returned CAS version and revision list
    // coherent with any simultaneous exclusive configuration write.
    await acquireGovernanceSubjectLocks(tx, [
      { subjectType: "USER", subjectId: input.actorId },
    ]);
    const access = await loadAuthorizationContext(input.actorId, tx);
    await requirePermissionInContext(access, "feature.flags.manage", input.campusId);
    await lockFeatureFlagSharedById(tx, `${input.key}:${scopeKey}`);

    const row = await tx.featureFlagOverride.findUnique({
      where: { key_scopeKey: { key: input.key, scopeKey } },
      select: {
        disabled: true, version: true,
        revisions: {
          orderBy: { version: "desc" }, take: 20,
          select: { version: true, previousDisabled: true, nextDisabled: true, createdAt: true },
        },
      },
    });
    return {
      key: input.key, scopeKey,
      localDisabled: row?.disabled ?? null, currentVersion: row?.version ?? 0,
      revisions: (row?.revisions ?? []).map(r => ({
        version: r.version, previousDisabled: r.previousDisabled,
        nextDisabled: r.nextDisabled, createdAt: r.createdAt.toISOString(),
      })),
    };
  });
}
