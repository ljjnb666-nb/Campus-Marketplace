import type { AuthorizationContext } from "@/lib/rbac/service";

/** Independent analytics.read capability; it does not imply audit, system or risk read. */
export type AnalyticsReadAccess = { global: boolean; campusIds: string[] };

export function deriveAnalyticsReadAccess(context: AuthorizationContext | null): AnalyticsReadAccess {
  if (!context?.accountActive) return { global: false, campusIds: [] };
  const active = new Set(context.activeCampusIds);
  const campusIds = new Set<string>();
  let global = false;
  for (const grant of context.grants) {
    if (!grant.permissionKeys.includes("analytics.read")) continue;
    if (grant.scope === "GLOBAL") global = true;
    if (grant.scope === "CAMPUS" && grant.campusId && active.has(grant.campusId)) {
      campusIds.add(grant.campusId);
    }
  }
  return { global, campusIds: [...campusIds].sort() };
}

export function canReadAnalyticsCampus(access: AnalyticsReadAccess, campusId: string): boolean {
  return Boolean(campusId) && (access.global || access.campusIds.includes(campusId));
}

export function hasAnyAnalyticsReadAccess(access: AnalyticsReadAccess): boolean {
  return access.global || access.campusIds.length > 0;
}
