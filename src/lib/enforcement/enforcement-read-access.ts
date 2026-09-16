import { notFound } from "next/navigation";

import { requireUser } from "@/lib/server-auth";
import { loadAuthorizationContext, type AuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 7D：执法可见性读面（/governance/enforcement）access 派生
 * （纯函数，DEFAULT_DENY）。
 *
 * 语义与中央 RBAC `hasPermission` 及 7A/7B/7C 派生模块逐条同构：
 * - null / 非激活账号 → 空 access；
 * - GLOBAL grant 含 enforcement.read → global=true（不要求任何 membership）；
 * - CAMPUS grant 含 enforcement.read@A → 仅当 A ∈ activeCampusIds 才纳入；
 * - campusIds 去重；绝不读取 User.role 字段。
 *
 * 权限语义冻结（Planning DECISION_01 / OPTION B）：enforcement.read 仅授权
 * EnforcementAction + RiskState 可见性。禁止以 user.suspend / campus.manage /
 * audit.read 组合派生本读面授权（读写不绑定、审计与执法可见性分离）。
 *
 * 7D 无 campus 执法角色（DECISION_10），campusIds 实际恒空，但 generic
 * authorization 必须正确——未来引入 campus 执法角色时本派生无需变更。
 *
 * 本派生是纯读授权（7D 无任何 mutation 面）；它授权的是 enforcement
 * provenance + current restriction state 的可见性，绝不构成任意
 * user-directory read（target 详情存在性权威见 enforcement-read-model）。
 */

export const ENFORCEMENT_READ_PERMISSION = "enforcement.read";

export type EnforcementReadAccess = {
  /** GLOBAL enforcement.read：可读全部授权行（含 campusId=null 的 GLOBAL 行） */
  global: boolean;
  /** 有效的 campus-scoped 读取 scope（grant ∧ ACTIVE membership 已求交） */
  campusIds: string[];
};

export function deriveEnforcementReadAccess(
  context: AuthorizationContext | null,
): EnforcementReadAccess {
  const access: EnforcementReadAccess = { global: false, campusIds: [] };
  if (!context || !context.accountActive) {
    return access;
  }

  for (const grant of context.grants) {
    if (!grant.permissionKeys.includes(ENFORCEMENT_READ_PERMISSION)) {
      continue;
    }
    if (grant.scope === "GLOBAL") {
      access.global = true;
    } else if (
      grant.campusId !== null &&
      context.activeCampusIds.includes(grant.campusId)
    ) {
      if (!access.campusIds.includes(grant.campusId)) {
        access.campusIds.push(grant.campusId);
      }
    }
  }

  return access;
}

/** 治理树 root gate 的 union 分量：是否具备任一执法读取 scope。 */
export function hasAnyEnforcementReadAccess(access: EnforcementReadAccess): boolean {
  return access.global || access.campusIds.length > 0;
}

export type EnforcementReaderPageSession = {
  user: Awaited<ReturnType<typeof requireUser>>;
  context: AuthorizationContext;
  access: EnforcementReadAccess;
};

/**
 * /governance/enforcement/** 页面统一入口（每次请求独立执行，绝不缓存）：
 * requireUser() → loadAuthorizationContext → deriveEnforcementReadAccess
 * → 无任何有效 scope → notFound()（不泄露治理面存在性）。
 *
 * 与 legacy requireAdmin() 完全分离：hasFullAdminSurfaceAccess 对仅持
 * enforcement.read 的角色恒 false（/admin 不可入，Phase 7A 隔离不变）。
 */
export async function requireEnforcementReader(): Promise<EnforcementReaderPageSession> {
  const user = await requireUser();
  const context = await loadAuthorizationContext(user.id);
  const access = deriveEnforcementReadAccess(context);

  if (!context || !hasAnyEnforcementReadAccess(access)) {
    notFound();
  }

  return { user, context, access };
}
