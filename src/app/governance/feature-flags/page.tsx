import { notFound } from "next/navigation";

import { FeatureFlagConsole } from "@/components/governance/feature-flag-console";
import {
  canManageFeatureFlagScope,
  deriveFeatureFlagUiAccess,
  hasAnyFeatureFlagUiAccess,
} from "@/lib/feature-flags/feature-flag-ui-access";
import { loadFeatureFlagConsoleRows } from "@/lib/feature-flags/feature-flag-ui-query";
import { findFlagUiCampusById, listFlagUiCampuses } from "@/repositories/feature-flag-ui-campus-repository";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { requireUser } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

/** Separate leaf authorization; /governance root admission is never sufficient. */
export default async function GovernanceFeatureFlagsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireUser();
  const context = await loadAuthorizationContext(actor.id);
  const access = deriveFeatureFlagUiAccess(context);
  if (!hasAnyFeatureFlagUiAccess(access)) notFound();

  const params = await searchParams;
  const rawScope = params.campusId;
  if (Array.isArray(rawScope) || (typeof rawScope === "string" && rawScope.length > 128)) {
    notFound();
  }
  // Global managers default to GLOBAL; campus-only managers default to their
  // first exact membership-authorized scope, never global.
  const campusId = rawScope === undefined
    ? (access.global ? null : access.campusIds[0]!)
    : (rawScope === "" ? null : rawScope);
  if (!canManageFeatureFlagScope(access, campusId)) notFound();

  // No campus metadata query until the requested scope is authorized.
  const campus = campusId === null ? null : await findFlagUiCampusById(campusId);
  if (campusId !== null && !campus) notFound();

  const campuses = await listFlagUiCampuses(access);
  if (campus && !campuses.some(candidate => candidate.id === campus.id)) {
    campuses.push(campus);
  }
  const rows = await loadFeatureFlagConsoleRows({ actorId: actor.id, campusId });

  return (
    <FeatureFlagConsole
      rows={rows}
      campusId={campusId}
      campusName={campus?.name ?? null}
      campuses={campuses}
      canManageGlobal={access.global}
    />
  );
}
