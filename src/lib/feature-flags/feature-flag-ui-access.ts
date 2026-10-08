import type { AuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 10G discovery only. The canonical 10F writer / reader re-authorize
 * under the actor's USER governance lock; UI scope lists are never authority.
 */
export type FeatureFlagUiAccess = { global: boolean; campusIds: string[] };

export function deriveFeatureFlagUiAccess(
  context: AuthorizationContext | null,
): FeatureFlagUiAccess {
  if (!context?.accountActive) return { global: false, campusIds: [] };
  const active = new Set(context.activeCampusIds);
  const ids = new Set<string>();
  let global = false;
  for (const grant of context.grants) {
    if (!grant.permissionKeys.includes("feature.flags.manage")) continue;
    if (grant.scope === "GLOBAL") {
      global = true;
    } else if (grant.scope === "CAMPUS" && grant.campusId && active.has(grant.campusId)) {
      ids.add(grant.campusId);
    }
  }
  return { global, campusIds: [...ids].sort() };
}

export function hasAnyFeatureFlagUiAccess(access: FeatureFlagUiAccess): boolean {
  return access.global || access.campusIds.length > 0;
}

export function canManageFeatureFlagScope(
  access: FeatureFlagUiAccess,
  campusId: string | null,
): boolean {
  return campusId === null ? access.global : access.global || access.campusIds.includes(campusId);
}
