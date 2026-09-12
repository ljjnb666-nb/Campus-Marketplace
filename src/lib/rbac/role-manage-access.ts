import { CAMPUS_APPEAL_REVIEWER_ROLE_KEY } from "@/lib/rbac/roles";
import type { AuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 7B：治理角色供给面（/governance/roles）访问派生 SSOT（纯函数，DEFAULT_DENY）。
 *
 * 语义与中央 RBAC `hasPermission` / 7A `deriveAppealReviewAccess` 逐条同构：
 * - null / 非激活账号 → 空 access；
 * - GLOBAL grant 含 rbac.role.assign → global=true（不要求任何 membership，
 *   与 hasPermission 的 GLOBAL-supersedes-campus 合同一致）；
 * - CAMPUS grant 含 rbac.role.assign@A → 仅当 A ∈ activeCampusIds（grant ∧
 *   ACTIVE membership 同时成立）才纳入 campusIds；
 * - campusIds 去重；绝不读取 User.role 字段。
 *
 * 可管理角色 = 显式 allowlist（冻结）：禁止以 SYSTEM_ROLES.filter(scope) 等
 * 任何派生方式扩列——未来新增 CAMPUS 角色不得因进入 SYSTEM_ROLES 而自动
 * 暴露给 7B 管理面；扩 allowlist 必须显式修改本文件并重新 review。
 *
 * P1 边界：MANAGE AUTHORIZATION 不检查 Campus.isActive——inactive campus 的
 * 既有 assignment 必须仍可发现/可撤；Campus.isActive 只参与 NEW-GRANT
 * ELIGIBILITY（role-assignment-query.resolveGrantEligibleCampus）。
 *
 * 本派生仅供发现/呈现与 action 层 fail-fast；canonical assignRole/revokeRole
 * 锁后授权重读始终是最终权威。
 */

export const MANAGEABLE_GOVERNANCE_ROLE_KEYS = [
  CAMPUS_APPEAL_REVIEWER_ROLE_KEY,
] as const;

export type ManageableGovernanceRoleKey = (typeof MANAGEABLE_GOVERNANCE_ROLE_KEYS)[number];

export type RoleManageAccess = {
  /** GLOBAL rbac.role.assign：可管理任意校区的既有 CAMPUS allowlist assignments */
  global: boolean;
  /** 有效的 campus-scoped 管理 scope（grant ∧ ACTIVE membership 已求交） */
  campusIds: string[];
};

export function isManageableGovernanceRoleKey(
  roleKey: string,
): roleKey is ManageableGovernanceRoleKey {
  return (MANAGEABLE_GOVERNANCE_ROLE_KEYS as readonly string[]).includes(roleKey);
}

export function deriveRoleManageAccess(
  context: AuthorizationContext | null,
): RoleManageAccess {
  const access: RoleManageAccess = { global: false, campusIds: [] };
  if (!context || !context.accountActive) {
    return access;
  }

  for (const grant of context.grants) {
    if (!grant.permissionKeys.includes("rbac.role.assign")) {
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

/** 单个 campus 的管理授权判定（与 hasPermission 同语义；不含 isActive 判断）。 */
export function canManageCampus(access: RoleManageAccess, campusId: string): boolean {
  return access.global || access.campusIds.includes(campusId);
}

/** 治理树 root gate 的 union 分量：是否具备任一角色管理 scope。 */
export function hasAnyRoleManageAccess(access: RoleManageAccess): boolean {
  return access.global || access.campusIds.length > 0;
}
