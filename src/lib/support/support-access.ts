import { notFound } from "next/navigation";

import { requireUser } from "@/lib/server-auth";
import {
  loadAuthorizationContext,
  type AuthorizationContext,
} from "@/lib/rbac/service";

/**
 * Phase 7G：support agent 有效 access 派生（纯函数，DEFAULT_DENY）。
 *
 * 语义与中央 RBAC `hasPermission` / 7A `deriveAppealReviewAccess` 逐条同构：
 * - null / 非激活账号 → 空 access；
 * - GLOBAL grant 含 support.manage → global=true（不要求任何 membership）；
 * - CAMPUS grant 含 support.manage@A → 仅当 A ∈ activeCampusIds 才纳入 campusIds；
 * - campusIds 去重；绝不读取 User.role 字段。
 *
 * scope 冻结（directive）：
 *   UNSCOPED support（campusId null + scopeKey 'UNSCOPED'）→ 仅 GLOBAL
 *   support.manage；CAMPUS support → GLOBAL OR exact campus support.manage。
 * permission 为 7G 新增 support.manage（不在 legacy 11-key 集合内）。
 * 本派生仅供发现/呈现与查询分支构造；canonical mutation（锁后授权重读）
 * 始终是最终权威。
 */

export const SUPPORT_MANAGE_PERMISSION = "support.manage" as const;

export type SupportManageAccess = {
  /** GLOBAL support.manage：可发现全部工单（含 UNSCOPED） */
  global: boolean;
  /** 有效的 campus-scoped 处理 scope（grant ∧ ACTIVE membership 已求交） */
  campusIds: string[];
};

export function deriveSupportManageAccess(
  context: AuthorizationContext | null,
): SupportManageAccess {
  const access: SupportManageAccess = { global: false, campusIds: [] };
  if (!context || !context.accountActive) {
    return access;
  }

  for (const grant of context.grants) {
    if (!grant.permissionKeys.includes(SUPPORT_MANAGE_PERMISSION)) {
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

/**
 * 单个工单 scope 的授权判定（与 hasPermission 同语义）：
 * UNSCOPED 仅 GLOBAL 可见；CAMPUS 对 GLOBAL 或该校区有效 grant 放行。
 */
export function canManageSupportScope(
  access: SupportManageAccess,
  row: { campusId: string | null; scopeKey: string },
): boolean {
  if (row.scopeKey === UNSCOPED_SCOPE_KEY) {
    return row.campusId === null && access.global;
  }
  return (
    row.campusId !== null &&
    row.scopeKey === campusScopeKeyOf(row.campusId) &&
    (access.global || access.campusIds.includes(row.campusId))
  );
}

/** root gate / 导航可见性用：是否持有任何有效 support manage scope。 */
export function hasAnySupportManageAccess(access: SupportManageAccess): boolean {
  return access.global || access.campusIds.length > 0;
}

const UNSCOPED_SCOPE_KEY = "UNSCOPED";

function campusScopeKeyOf(campusId: string): string {
  return `CAMPUS:${campusId}`;
}

// ── Phase 7G 治理页入口 resolver（独立于 requireAdmin，零桥接）────────────────

export type SupportAgentPageSession = {
  user: Awaited<ReturnType<typeof requireUser>>;
  context: AuthorizationContext;
  access: SupportManageAccess;
};

/**
 * /governance/support 页面统一入口（每次请求独立执行，绝不缓存）：
 *   requireUser() → loadAuthorizationContext → deriveSupportManageAccess
 *   → 无任何有效 scope → notFound()（不泄露治理面存在性）。
 */
export async function requireSupportAgent(): Promise<SupportAgentPageSession> {
  const user = await requireUser();
  const context = await loadAuthorizationContext(user.id);
  const access = deriveSupportManageAccess(context);

  if (!context || (!access.global && access.campusIds.length === 0)) {
    notFound();
  }

  return { user, context, access };
}
