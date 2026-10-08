import { notFound } from "next/navigation";

import { RuntimeConfigConsole } from "@/components/governance/runtime-config-console";
import {
  canManageRuntimeConfigScope,
  deriveRuntimeConfigUiAccess,
  hasAnyRuntimeConfigUiAccess,
} from "@/lib/runtime-config/runtime-config-ui-access";
import { loadRuntimeConfigForOperator } from "@/lib/runtime-config/runtime-config-operator-query";
import { loadEffectiveRuntimeConfig } from "@/lib/runtime-config/runtime-config-query";
import {
  findRuntimeConfigUiCampusById, listRuntimeConfigUiCampuses,
} from "@/repositories/runtime-config-ui-campus-repository";
import { loadAuthorizationContext } from "@/lib/rbac/service";
import { requireUser } from "@/lib/server-auth";

export const dynamic = "force-dynamic";
const KEY = "RISK_SIGNAL_EVIDENCE_LIMIT" as const;

/** Leaf self-authorization, independent of /governance layout navigation. */
export default async function GovernanceRuntimeConfigPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireUser();
  const context = await loadAuthorizationContext(actor.id);
  const access = deriveRuntimeConfigUiAccess(context);
  if (!hasAnyRuntimeConfigUiAccess(access)) notFound();

  const params = await searchParams;
  const rawScope = params.campusId;
  if (Array.isArray(rawScope) || (typeof rawScope === "string" && rawScope.length > 128)) notFound();
  const campusId = rawScope === undefined
    ? (access.global ? null : access.campusIds[0]!)
    : (rawScope === "" ? null : rawScope);
  if (!canManageRuntimeConfigScope(access, campusId)) notFound();

  const campus = campusId === null ? null : await findRuntimeConfigUiCampusById(campusId);
  if (campusId !== null && !campus) notFound();

  const campuses = await listRuntimeConfigUiCampuses(access);
  if (campus && !campuses.some(row => row.id === campus.id)) campuses.push(campus);

  // The 10E operator reader checks fresh scoped RBAC before touching override history.
  const config = await loadRuntimeConfigForOperator({ actorId: actor.id, key: KEY, campusId });
  const effective = await loadEffectiveRuntimeConfig({
    key: KEY, ...(campusId === null ? {} : { campusId }),
  });

  return (
    <RuntimeConfigConsole
      key={`${campusId ?? "GLOBAL"}:${config.currentVersion}`}
      config={config}
      effective={effective}
      campusId={campusId}
      campusName={campus?.name ?? null}
      campuses={campuses}
      canManageGlobal={access.global}
    />
  );
}
