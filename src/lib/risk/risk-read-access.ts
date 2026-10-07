import type { AuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 10D — Risk Intelligence read authorization.
 *
 * Deliberately separate from Phase 7D enforcement.read:
 * - enforcement.read = EnforcementAction + current RiskState only (frozen);
 * - risk.read = RiskFlag-derived signal intelligence only.
 *
 * New read capability does not grant mutation, audit, full-admin compatibility,
 * or any user-directory visibility.
 */
export const RISK_READ_PERMISSION = "risk.read";

export type RiskReadAccess = {
  global: boolean;
  campusIds: string[];
};

export function deriveRiskReadAccess(
  context: AuthorizationContext | null,
): RiskReadAccess {
  const access: RiskReadAccess = { global: false, campusIds: [] };
  if (!context || !context.accountActive) {
    return access;
  }

  for (const grant of context.grants) {
    if (!grant.permissionKeys.includes(RISK_READ_PERMISSION)) {
      continue;
    }
    if (grant.scope === "GLOBAL") {
      access.global = true;
      continue;
    }

    if (
      grant.campusId !== null &&
      context.activeCampusIds.includes(grant.campusId) &&
      !access.campusIds.includes(grant.campusId)
    ) {
      access.campusIds.push(grant.campusId);
    }
  }

  return access;
}

export function hasAnyRiskReadAccess(access: RiskReadAccess): boolean {
  return access.global || access.campusIds.length > 0;
}
