import type { AuthorizationContext } from "@/lib/rbac/service";

/** Discovery only: 10E canonical reader/writer recheck permission at the data boundary. */
export type RuntimeConfigUiAccess = { global: boolean; campusIds: string[] };

export function deriveRuntimeConfigUiAccess(context: AuthorizationContext | null): RuntimeConfigUiAccess {
  if (!context?.accountActive) return { global: false, campusIds: [] };
  const active = new Set(context.activeCampusIds);
  const campuses = new Set<string>();
  let global = false;
  for (const grant of context.grants) {
    if (!grant.permissionKeys.includes("runtime.config.manage")) continue;
    if (grant.scope === "GLOBAL") global = true;
    else if (grant.scope === "CAMPUS" && grant.campusId && active.has(grant.campusId)) {
      campuses.add(grant.campusId);
    }
  }
  return { global, campusIds: [...campuses].sort() };
}

export function hasAnyRuntimeConfigUiAccess(access: RuntimeConfigUiAccess): boolean {
  return access.global || access.campusIds.length > 0;
}

export function canManageRuntimeConfigScope(access: RuntimeConfigUiAccess, campusId: string | null): boolean {
  return campusId === null ? access.global : access.global || access.campusIds.includes(campusId);
}
