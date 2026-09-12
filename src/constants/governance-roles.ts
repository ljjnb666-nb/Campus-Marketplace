import { CAMPUS_APPEAL_REVIEWER_ROLE_KEY } from "@/lib/rbac/roles";

/**
 * Phase 7B 角色管理面 UI 元数据。
 *
 * 只为 MANAGEABLE_GOVERNANCE_ROLE_KEYS（role-manage-access.ts 显式 allowlist）
 * 内的角色提供展示名；allowlist 外角色结构性无 UI 元数据（渲染时统一回退
 * 「未知角色」，绝不回显内部 roleKey）。
 */
export const GOVERNANCE_ROLE_LABELS: Record<string, string> = {
  [CAMPUS_APPEAL_REVIEWER_ROLE_KEY]: "校区申诉审核员",
};

export const GOVERNANCE_ROLE_GRANT_HINT = "将授予：校区申诉审核员";

export const ROLE_MANAGE_PAGE_TITLE = "角色管理";

export const ROLE_MANAGE_PAGE_SUBTITLE = "管理校园治理角色的授予与撤回";
