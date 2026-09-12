// 相对导入：本模块（连同 permissions.ts / bootstrap.ts）被 prisma/seed.ts 与
// scripts/e2e-setup.ts 以 tsx 直接执行——tsx 无 @/ alias，链上不得使用 @ 导入。
import { PERMISSION_KEYS, type PermissionKey } from "./permissions";

/**
 * Phase 6A：系统内置角色定义（bootstrap 的唯一定义来源）。
 *
 * 当前产品只需要 platform admin（Phase 6A 审计结论）：不假装所有角色都
 * campus-scoped。Role.scope=CAMPUS + UserRoleAssignment.campusId 的数据模型
 * 已能自然表达未来的 Campus Moderator / Verification Reviewer，
 * 但不提前实现 Phase 7 的角色管理 UI。
 */

export const PLATFORM_ADMIN_ROLE_KEY = "PLATFORM_ADMIN";

// Phase 7A：校区申诉审核员（仅 appeal.review 的 campus-scoped 窄角色）。
// 生产既有库经 data-only migration 收敛（与 SYSTEM_ROLES 同一定义）；
// 角色授予/撤回走 canonical assignment service，管理 UI 属 Phase 7B。
export const CAMPUS_APPEAL_REVIEWER_ROLE_KEY = "CAMPUS_APPEAL_REVIEWER";

export const GLOBAL_SCOPE_KEY = "GLOBAL";

/** CAMPUS 角色授予行的 scopeKey 编码（assignment service 维护与 campusId 一致）。 */
export function campusScopeKey(campusId: string): string {
  return `CAMPUS:${campusId}`;
}

export type SystemRoleDefinition = {
  key: string;
  name: string;
  scope: "GLOBAL" | "CAMPUS";
  permissionKeys: PermissionKey[];
};

export const SYSTEM_ROLES: SystemRoleDefinition[] = [
  {
    key: PLATFORM_ADMIN_ROLE_KEY,
    name: "平台管理员",
    scope: "GLOBAL",
    permissionKeys: [...PERMISSION_KEYS],
  },
  {
    key: CAMPUS_APPEAL_REVIEWER_ROLE_KEY,
    name: "校区申诉审核员",
    scope: "CAMPUS",
    permissionKeys: ["appeal.review"],
  },
];
