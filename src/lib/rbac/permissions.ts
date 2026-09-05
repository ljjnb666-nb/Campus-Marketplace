/**
 * Phase 6A：permission key 的唯一定义来源（machine-readable 稳定标识）。
 *
 * 约定：
 * - key 采用 `域.动作` 小写点分风格，一旦发布不得改名（审计/角色数据引用它）
 * - permission set 从现有 admin 能力推导（Phase 6A 审计），不为未来 Phase 预留
 * - 未知 permission 一律 DENY（DEFAULT_DENY，见 src/lib/rbac/service.ts）
 */

export const PERMISSIONS = {
  "verification.review": "审核校园成员认证材料并作出决定",
  "report.review": "受理与处理举报",
  "listing.moderate": "对商品/跑腿/服务/租赁列表执行治理处置",
  "category.manage": "管理商品/跑腿/服务分类",
  "moderation.keyword.manage": "管理敏感词规则",
  "user.suspend": "停用/恢复用户账号",
  "asset.sensitive.read": "因治理/审核目的访问敏感私有材料（认证材料等）",
  "campus.manage": "管理校区与校园认证策略版本",
  "rbac.role.assign": "授予/撤回用户角色",
  "audit.read": "读取管理审计日志",
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

/** 类型收窄：把任意字符串收窄为已知 PermissionKey（未知返回 null → 调用方 DENY）。 */
export function asPermissionKey(key: string): PermissionKey | null {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, key) ? (key as PermissionKey) : null;
}

/**
 * requireAdmin 兼容桥的后台入口判定集合：持有本集合中任意 permission
 * 即视为可进入管理后台。Phase 6A 全部 permission 仅由 PLATFORM_ADMIN 持有，
 * 行为与旧 `role === "ADMIN"` 完全一致；Phase 7 按页面拆分细粒度判定。
 */
export const ADMIN_SURFACE_PERMISSION_KEYS: PermissionKey[] = [...PERMISSION_KEYS];
