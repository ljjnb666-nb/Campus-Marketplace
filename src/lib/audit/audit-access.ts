import { notFound } from "next/navigation";

import { requireUser } from "@/lib/server-auth";
import { loadAuthorizationContext, type AuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 7D：审计日志读面（/governance/audit）access 派生（纯函数，DEFAULT_DENY）。
 *
 * 语义与中央 RBAC `hasPermission` 及 7A/7B/7C 派生模块逐条同构：
 * - null / 非激活账号 → 空 access；
 * - GLOBAL grant 含 audit.read → global=true（不要求任何 membership）；
 * - CAMPUS grant 含 audit.read@A → 仅当 A ∈ activeCampusIds 才纳入 campusIds；
 * - campusIds 去重；绝不读取 User.role 字段。
 *
 * 权限语义冻结（Planning DECISION_01）：audit.read 仅授权 AdminLog 可见性，
 * 不授权 EnforcementAction / RiskState（那是 enforcement.read 的辖域）。
 *
 * 7D 无 campus 审计角色（DECISION_10），campusIds 实际恒空，但 generic
 * authorization 必须正确——未来引入 campus audit 角色时本派生无需变更。
 *
 * 本派生仅供发现/呈现；AdminLog append-only、无 mutation 面，故本模块
 * 不存在"域服务最终权威"复核层（读面即全部）。
 */

export const AUDIT_READ_PERMISSION = "audit.read";

export type AuditReadAccess = {
  /** GLOBAL audit.read：可读全部 AdminLog 行（含 campusId=null 行） */
  global: boolean;
  /** 有效的 campus-scoped 读取 scope（grant ∧ ACTIVE membership 已求交） */
  campusIds: string[];
};

export function deriveAuditAccess(context: AuthorizationContext | null): AuditReadAccess {
  const access: AuditReadAccess = { global: false, campusIds: [] };
  if (!context || !context.accountActive) {
    return access;
  }

  for (const grant of context.grants) {
    if (!grant.permissionKeys.includes(AUDIT_READ_PERMISSION)) {
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

/** 治理树 root gate 的 union 分量：是否具备任一审计读取 scope。 */
export function hasAnyAuditAccess(access: AuditReadAccess): boolean {
  return access.global || access.campusIds.length > 0;
}

export type AuditReaderPageSession = {
  user: Awaited<ReturnType<typeof requireUser>>;
  context: AuthorizationContext;
  access: AuditReadAccess;
};

/**
 * /governance/audit 页面统一入口（每次请求独立执行，绝不缓存）：
 * requireUser() → loadAuthorizationContext → deriveAuditAccess
 * → 无任何有效 scope → notFound()（不泄露治理面存在性）。
 *
 * 与 legacy requireAdmin() 完全分离：hasFullAdminSurfaceAccess 对仅持
 * audit.read 的角色恒 false（/admin 不可入，Phase 7A 隔离不变）。
 */
export async function requireAuditReader(): Promise<AuditReaderPageSession> {
  const user = await requireUser();
  const context = await loadAuthorizationContext(user.id);
  const access = deriveAuditAccess(context);

  if (!context || !hasAnyAuditAccess(access)) {
    notFound();
  }

  return { user, context, access };
}
