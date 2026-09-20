import { notFound } from "next/navigation";

import { requireUser } from "@/lib/server-auth";
import { hasPermission, loadAuthorizationContext } from "@/lib/rbac/service";

/**
 * Phase 7H：运营级系统概览面（/governance/system）访问派生（DEFAULT_DENY）。
 *
 * 授权模型（Planning §11/§12 冻结）：operations.overview = GLOBAL ONLY——
 * Campus entity 之外的运行时/依赖状态是平台级事实，不存在 campus-scoped
 * 概览。hasPermission 不传 campusId 时仅 GLOBAL grant 放行：即使错误存在
 * campus.manage 式的 CAMPUS operations.overview grant 也绝不获得本面。
 *
 * 刻意不属于 LEGACY_ADMIN_EQUIVALENCE_PERMISSION_KEYS（恰 11 key 零变化，
 * requireAdmin 资格不受影响）；PLATFORM_ADMIN 因
 * SYSTEM_ROLES.permissionKeys = [...PERMISSION_KEYS] 自然获得。
 *
 * 绝不使用 requireAdmin()（那是 legacy 11-key 全量桥）与 User.role。
 */

export const OPERATIONS_OVERVIEW_PERMISSION = "operations.overview" as const;

export type OperationsOverviewAccess = {
  /** GLOBAL operations.overview（唯一有效形态） */
  global: boolean;
};

export function deriveOperationsOverviewAccess(
  context: Parameters<typeof hasPermission>[0],
): OperationsOverviewAccess {
  if (!context || !context.accountActive) {
    return { global: false };
  }
  // 不传 targetCampusId：CAMPUS grant 一律不命中 → GLOBAL-only 语义
  return { global: hasPermission(context, OPERATIONS_OVERVIEW_PERMISSION) };
}

/** root gate / 导航可见性用。 */
export function hasAnyOperationsOverviewAccess(access: OperationsOverviewAccess): boolean {
  return access.global;
}

export type OperationsOverviewPageSession = {
  user: Awaited<ReturnType<typeof requireUser>>;
};

/**
 * /governance/system 页面统一入口（每次请求独立执行，绝不缓存）：
 *   requireUser()（session → DB ACTIVE 复查 → consent）
 *   → loadAuthorizationContext
 *   → deriveOperationsOverviewAccess
 *   → 非 GLOBAL operations.overview → notFound()（不泄露治理面存在性）。
 *
 * 与 legacy requireAdmin() 完全分离（两层纵深：layout root gate 之外的
 * 子树自守门）。
 */
export async function requireOperationsOverviewAdmin(): Promise<OperationsOverviewPageSession> {
  const user = await requireUser();
  const context = await loadAuthorizationContext(user.id);
  const access = deriveOperationsOverviewAccess(context);

  if (!access.global) {
    notFound();
  }

  return { user };
}
